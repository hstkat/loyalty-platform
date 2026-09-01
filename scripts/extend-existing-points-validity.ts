/**
 * Trekt bestaande, nog-niet-verlopen spaarpunten-boekingen op naar de
 * nieuwe geldigheidstermijn (720 dagen, was 60) — bedoeld als eenmalige
 * correctie na de wijziging van DEFAULT_VALIDITY_DAYS in
 * wallet.service.ts.
 *
 * Herberekent per boeking: nieuweVervaldatum = occurredAt + 720 dagen.
 * Past dit ALLEEN toe als die nieuwe datum LATER ligt dan de huidige
 * vervaldatum — een boeking met een al langere (bijv. via een
 * aangepaste spaarregel met een eigen validityDays) vervaldatum wordt
 * dus nooit verkort, alleen mogelijk verlengd.
 *
 * Raakt alleen boekingen die nog daadwerkelijk openstaan: status
 * 'available' met remainingAmount > 0. Al verbruikte of al verlopen
 * boekingen blijven ongemoeid — daar verandert een nieuwe vervaldatum
 * toch niets meer aan.
 *
 * Gebruik:
 *   npx ts-node scripts/extend-existing-points-validity.ts <org-id> BEVESTIG
 */
import { PrismaClient } from '@prisma/client';

const NEW_VALIDITY_DAYS = 720;

async function main() {
  const orgId = process.argv[2];
  const confirmation = process.argv[3];

  if (!orgId || confirmation !== 'BEVESTIG') {
    console.error('Gebruik: npx ts-node scripts/extend-existing-points-validity.ts <org-id> BEVESTIG');
    console.error('(Het woord BEVESTIG moet je letterlijk meegeven, als extra veiligheidsstap.)');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const candidates = await prisma.walletLedgerEntry.findMany({
      where: {
        organizationId: orgId,
        status: 'available',
        remainingAmount: { gt: 0 },
        expiresAt: { not: null },
      },
      select: { id: true, occurredAt: true, expiresAt: true },
    });

    if (candidates.length === 0) {
      console.log('Geen openstaande boekingen met een vervaldatum gevonden — niets te doen.');
      return;
    }

    let extended = 0;
    for (const entry of candidates) {
      const newExpiry = new Date(entry.occurredAt.getTime() + NEW_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
      if (!entry.expiresAt || newExpiry <= entry.expiresAt) continue; // nooit verkorten, alleen verlengen

      await prisma.walletLedgerEntry.update({
        where: { id: entry.id },
        data: { expiresAt: newExpiry },
      });
      extended += 1;
    }

    console.log(`${candidates.length} openstaande boeking(en) bekeken, ${extended} verlengd naar de nieuwe termijn van ${NEW_VALIDITY_DAYS} dagen.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
