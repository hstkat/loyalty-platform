/**
 * Zet het beschikbare tegoed (punten) van ALLE klanten terug op €0 —
 * bedoeld als eenmalige opschoning van testdata, nu er nog geen echte
 * spaartransacties zijn.
 *
 * Raakt bewust NIET aan lifetimeEarned/lifetimeRedeemed (de historische
 * totalen) — alleen het BESCHIKBARE saldo (availableBalance) gaat naar 0,
 * met een nette correctie-boeking in de ledger voor de audit-trail (net
 * als een handmatige aanpassing, maar dan geautomatiseerd voor iedereen
 * tegelijk). Bestaande "open" boekingen (status 'available') worden als
 * verbruikt gemarkeerd, zodat de ledger-historie intern consistent
 * blijft — er blijven geen "open" bedragen staan die niet meer in het
 * saldo terugkomen.
 *
 * Gebruik:
 *   npx ts-node scripts/reset-all-points-to-zero.ts <org-id> BEVESTIG
 *
 * Het woord BEVESTIG moet je letterlijk meegeven — dat voorkomt dat dit
 * ooit per ongeluk (bijv. door een verkeerd gekopieerd commando) wordt
 * uitgevoerd.
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const orgId = process.argv[2];
  const confirmation = process.argv[3];

  if (!orgId || confirmation !== 'BEVESTIG') {
    console.error('Gebruik: npx ts-node scripts/reset-all-points-to-zero.ts <org-id> BEVESTIG');
    console.error('(Het woord BEVESTIG moet je letterlijk meegeven, als extra veiligheidsstap.)');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const wallets = await prisma.wallet.findMany({
      where: {
        organizationId: orgId,
        availableBalance: { gt: 0 },
        customer: { deletedAt: null },
      },
      select: { id: true, customerId: true, availableBalance: true },
    });

    if (wallets.length === 0) {
      console.log('Geen klanten met een openstaand saldo gevonden — niets te doen.');
      return;
    }

    console.log(`${wallets.length} klant(en) met een openstaand saldo gevonden — terugzetten naar €0...`);

    let processed = 0;
    for (const wallet of wallets) {
      await prisma.$transaction(async (tx) => {
        // Alle nog "open" boekingen als volledig verbruikt markeren, zodat
        // de ledger-historie niet langer beweert dat er nog iets
        // beschikbaar is.
        await tx.walletLedgerEntry.updateMany({
          where: { walletId: wallet.id, status: 'available', remainingAmount: { gt: 0 } },
          data: { remainingAmount: 0, status: 'redeemed' },
        });

        // Eén nette correctieboeking voor de audit-trail.
        await tx.walletLedgerEntry.create({
          data: {
            walletId: wallet.id,
            organizationId: orgId,
            entryType: 'correction',
            amount: Number(wallet.availableBalance) * -1,
            remainingAmount: 0,
            status: 'redeemed',
            source: 'manual',
            performedByType: 'system',
            reason: 'Testdata-opschoning: saldo teruggezet naar €0',
            occurredAt: new Date(),
          },
        });

        await tx.wallet.update({ where: { id: wallet.id }, data: { availableBalance: 0 } });
      });
      processed += 1;
    }

    console.log(`OK — ${processed} klant(en) hebben nu weer €0 beschikbaar saldo.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
