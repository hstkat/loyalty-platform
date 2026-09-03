/**
 * Maakt de twee standaard voucher-berichttemplates aan (uitgifte +
 * verloopherinnering) — er is nog geen backoffice-scherm voor
 * berichttemplates, dus dit is het eenvoudigst als lokaal script, net
 * als scripts/create-staff-user.ts. Draai dit ÉÉN keer na de eerste
 * voucher-uitrol; herhaald draaien maakt gewoon nieuwe (extra) rijen
 * aan, dus check eerst even of ze al bestaan als je twijfelt.
 *
 * Gebruik:
 *   npx ts-node scripts/create-voucher-templates.ts <org-id>
 *
 * Wil je de teksten aanpassen? Wijzig ze hieronder en draai opnieuw
 * (of pas de rij later aan via de messaging-API/database).
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const orgId = process.argv[2];
  if (!orgId) {
    console.error('Gebruik: npx ts-node scripts/create-voucher-templates.ts <org-id>');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const issued = await prisma.messageTemplate.create({
      data: {
        organizationId: orgId,
        templateGroupKey: 'voucher_issued',
        channel: 'push',
        category: 'transactional',
        name: 'Voucher uitgegeven',
        locale: 'nl',
        body: 'Er staat een nieuwe voucher voor je klaar: {{voucher_name}} — {{voucher_benefit}}. Bekijk hem in je account.',
      },
    });
    const expiring = await prisma.messageTemplate.create({
      data: {
        organizationId: orgId,
        templateGroupKey: 'voucher_expiring_soon',
        channel: 'push',
        category: 'transactional',
        name: 'Voucher verloopt binnenkort',
        locale: 'nl',
        body: 'Je {{voucher_name}} is nog {{days_left}} dag(en) geldig — gebruik hem voordat die verloopt.',
      },
    });
    console.log('OK — templates aangemaakt:', issued.id, expiring.id);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
