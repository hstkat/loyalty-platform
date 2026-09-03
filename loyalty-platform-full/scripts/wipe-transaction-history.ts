/**
 * Zet alle transactie-/omzet-/spaarpuntengeschiedenis terug naar nul —
 * bedoeld als vervolg op de eerdere opschoning van kadobonnen en
 * testklanten, nu ook de resterende omzetcijfers (Overzicht-scherm:
 * Omzet, Gemiddelde besteding, Terugkeerpercentage, Gouden leden, etc.)
 * nog uit oude testtransacties kwamen.
 *
 * Blijft bewust WEL bestaan: de 5 (test)klantaccounts zelf — die worden
 * niet aangeraakt, alleen hun transactie-afgeleide statistieken.
 *
 * Verwijdert, in de juiste volgorde (om foreign-key-conflicten te
 * voorkomen):
 *   1. WalletLedgerAllocation (cascade via WalletLedgerEntry, maar
 *      expliciet eerst voor de duidelijkheid)
 *   2. WalletLedgerEntry (alle spaarpunten-boekingen — niet alleen
 *      "op nul corrigeren" zoals de vorige keer, nu volledig weg)
 *   3. Transaction (cascade naar TransactionLineItem/Refund/Void/
 *      Chargeback)
 * Zet daarna terug op 0/null:
 *   - Wallet: alle saldo- en lifetime-velden
 *   - Customer: visitCount, first/lastVisitAt, averageVisitFrequencyDays,
 *     favoriteVisitDay/TimeWindow, lifetimeSpend, tierId, churnRiskScore
 *
 * Gebruik:
 *   npx ts-node scripts/wipe-transaction-history.ts <org-id> BEVESTIG
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const orgId = process.argv[2];
  const confirmation = process.argv[3];

  if (!orgId || confirmation !== 'BEVESTIG') {
    console.error('Gebruik: npx ts-node scripts/wipe-transaction-history.ts <org-id> BEVESTIG');
    console.error('(Het woord BEVESTIG moet je letterlijk meegeven, als extra veiligheidsstap.)');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const walletEntryCount = await prisma.walletLedgerEntry.count({ where: { organizationId: orgId } });
    const transactionCount = await prisma.transaction.count({ where: { organizationId: orgId } });

    if (walletEntryCount === 0 && transactionCount === 0) {
      console.log('Geen transacties of spaarpunten-boekingen gevonden — niets te verwijderen.');
      return;
    }

    console.log(`${walletEntryCount} spaarpunten-boeking(en) en ${transactionCount} transactie(s) gevonden — verwijderen...`);

    // 1+2. Spaarpunten-ledger volledig leeg (WalletLedgerAllocation gaat
    // automatisch mee via de cascade op WalletLedgerEntry).
    const deletedWalletEntries = await prisma.walletLedgerEntry.deleteMany({ where: { organizationId: orgId } });

    // Andere tabellen die (optioneel) naar Transaction verwijzen zonder
    // cascade — eerst ontkoppelen (transactionId op null), anders
    // blokkeert de foreign-key-relatie de verwijdering hieronder.
    // GiftCardLedgerEntry hoeft hier niet apart, die is al leeg sinds de
    // eerdere kadobon-opschoning. PosEvent heeft geen eigen
    // organizationId (loopt via posConnection), dus die scopen we via de
    // transaction-relatie zelf.
    await prisma.posEvent.updateMany({ where: { transaction: { organizationId: orgId } }, data: { transactionId: null } });
    await prisma.walletRedemptionReservation.updateMany({ where: { organizationId: orgId }, data: { transactionId: null } });
    await prisma.customerVoucher.updateMany({ where: { organizationId: orgId }, data: { transactionId: null } });

    // 3. Transacties (cascade naar regels/refunds/voids/chargebacks).
    const deletedTransactions = await prisma.transaction.deleteMany({ where: { organizationId: orgId } });

    // Wallet-saldi + lifetime-tellers terug op 0.
    const walletsReset = await prisma.wallet.updateMany({
      where: { organizationId: orgId },
      data: {
        availableBalance: 0,
        pendingBalance: 0,
        reservedBalance: 0,
        lifetimeEarned: 0,
        lifetimeExpired: 0,
        lifetimeRedeemed: 0,
      },
    });

    // Klant-statistieken die uit transacties werden afgeleid, terug op
    // hun beginwaarde — de klantaccounts zelf blijven gewoon bestaan.
    const customersReset = await prisma.customer.updateMany({
      where: { organizationId: orgId },
      data: {
        visitCount: 0,
        firstVisitAt: null,
        lastVisitAt: null,
        averageVisitFrequencyDays: null,
        favoriteVisitDay: null,
        favoriteVisitTimeWindow: null,
        lifetimeSpend: 0,
        tierId: null,
      },
    });

    // churnRiskScore is GEEN los veld op Customer, maar een aparte tabel
    // (1-op-1) — die rijen verwijderen we in plaats van een veld te
    // resetten. Een klant zonder rij hier telt straks vanzelf weer als
    // "geen risicoscore berekend" i.p.v. een verouderd cijfer te tonen.
    const churnScoresDeleted = await prisma.churnRiskScore.deleteMany({ where: { organizationId: orgId } });

    console.log(`OK — ${deletedWalletEntries.count} spaarpunten-boeking(en) en ${deletedTransactions.count} transactie(s) verwijderd.`);
    console.log(`${walletsReset.count} wallet(s), ${customersReset.count} klant(en) se statistieken, en ${churnScoresDeleted.count} risicoscore(s) teruggezet naar 0.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
