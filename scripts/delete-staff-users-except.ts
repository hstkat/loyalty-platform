/**
 * Verwijdert alle medewerker-accounts binnen een organisatie, BEHALVE
 * het opgegeven e-mailadres — bedoeld om testaccounts op te ruimen
 * vlak vóór een deploy.
 *
 * Verwijdert écht (geen soft-delete/deactiveren) — bedoeld voor
 * accounts zonder relevante geschiedenis. Sessies van de verwijderde
 * accounts gaan automatisch mee (cascade). Losse verwijzingen elders
 * (bijv. performedByUserId op ledger-boekingen) zijn GEEN echte
 * foreign-key-koppeling in dit platform — die blijven na verwijdering
 * gewoon als los UUID staan, zonder dat de verwijdering daarop
 * vastloopt of dat die boekingen zelf verdwijnen.
 *
 * Gebruik:
 *   npx ts-node scripts/delete-staff-users-except.ts <org-id> <te-behouden-email> BEVESTIG
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const [orgId, keepEmail, confirmation] = process.argv.slice(2);

  if (!orgId || !keepEmail || confirmation !== 'BEVESTIG') {
    console.error('Gebruik: npx ts-node scripts/delete-staff-users-except.ts <org-id> <te-behouden-email> BEVESTIG');
    console.error('(Het woord BEVESTIG moet je letterlijk meegeven, als extra veiligheidsstap.)');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const keepUser = await prisma.staffUser.findFirst({ where: { organizationId: orgId, email: keepEmail } });
    if (!keepUser) {
      console.error(`Geen medewerker gevonden met e-mailadres "${keepEmail}" binnen deze organisatie — niets verwijderd, uit voorzorg.`);
      process.exit(1);
    }

    const toDelete = await prisma.staffUser.findMany({
      where: { organizationId: orgId, id: { not: keepUser.id } },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    if (toDelete.length === 0) {
      console.log(`Geen andere medewerkers gevonden — "${keepEmail}" was toch al de enige.`);
      return;
    }

    console.log(`Te verwijderen (${toDelete.length}):`);
    for (const u of toDelete) {
      console.log(`  - ${u.email} (${[u.firstName, u.lastName].filter(Boolean).join(' ')})`);
    }

    const result = await prisma.staffUser.deleteMany({
      where: { organizationId: orgId, id: { not: keepUser.id } },
    });

    console.log(`\nOK — ${result.count} medewerker(s) verwijderd. "${keepEmail}" blijft over als enige account.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
