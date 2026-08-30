/**
 * Verwijdert ALLE cadeaukaart-/kadobon-data (kaarten, ledger-boekingen,
 * batches) voor deze organisatie — bedoeld als eenmalige opschoning van
 * testdata, nu er nog geen echte kaarten verkocht zijn.
 *
 * Zet de nummering vanzelf terug op GC-000001: het volgende uitgegeven
 * nummer wordt berekend op basis van het aantal bestaande rijen, dus
 * zodra die allemaal weg zijn, begint het gewoon opnieuw.
 *
 * Ledger-boekingen (giftCardLedgerEntry) worden automatisch mee
 * verwijderd (onDelete: Cascade in het schema) — die hoeven hier niet
 * apart aangeroepen te worden. Batches (fysiek voorgedrukte kaarten,
 * indien ooit aangemaakt) worden er ook uit gehaald.
 *
 * Gebruik:
 *   npx ts-node scripts/wipe-gift-cards.ts <org-id> BEVESTIG
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
    console.error('Gebruik: npx ts-node scripts/wipe-gift-cards.ts <org-id> BEVESTIG');
    console.error('(Het woord BEVESTIG moet je letterlijk meegeven, als extra veiligheidsstap.)');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const cardCount = await prisma.giftCard.count({ where: { organizationId: orgId } });
    if (cardCount === 0) {
      console.log('Geen kadobonnen gevonden voor deze organisatie — niets te verwijderen.');
      return;
    }

    console.log(`${cardCount} kadobon(nen) gevonden — verwijderen...`);

    // Cascade verwijdert automatisch de bijbehorende ledger-boekingen.
    const deletedCards = await prisma.giftCard.deleteMany({ where: { organizationId: orgId } });

    // Batches (fysiek voorgedrukte kaarten) — nu veilig te verwijderen
    // omdat er geen kaarten meer naar verwijzen.
    const deletedBatches = await prisma.giftCardBatch.deleteMany({ where: { organizationId: orgId } });

    console.log(`OK — ${deletedCards.count} kadobon(nen) en ${deletedBatches.count} batch(es) verwijderd.`);
    console.log('De volgende uitgegeven kadobon krijgt weer nummer GC-000001.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
