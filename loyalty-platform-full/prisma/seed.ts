// Sanity-check seed for Module 1 — Customer & CRM.
// Run with: npm run db:seed  (after prisma:generate + prisma:migrate:deploy)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: 'beach-hospitality-group' },
    update: {},
    create: {
      name: 'Beach Hospitality Group',
      slug: 'beach-hospitality-group',
    },
  });

  const location = await prisma.location.create({
    data: {
      organizationId: org.id,
      name: 'Beachclub Noordwijk',
    },
  });

  const customer = await prisma.customer.create({
    data: {
      organizationId: org.id,
      firstName: 'Jan',
      lastName: 'de Vries',
      email: 'jan@example.nl',
      phone: '+31612345678',
      language: 'nl',
      sourceChannel: 'pos',
      interests: ['diner', 'terras', 'cocktails', 'sunset events'],
      favoriteLocationId: location.id,
      favoriteVisitDay: 'saturday',
      favoriteVisitTimeWindow: '17:00-22:00',
      favoritePartySize: 2,
      identities: {
        create: [
          {
            organizationId: org.id,
            identityType: 'email',
            identityValue: 'jan@example.nl',
            isPrimary: true,
            verified: true,
            source: 'pos',
          },
          {
            organizationId: org.id,
            identityType: 'phone',
            identityValue: '+31612345678',
            isPrimary: false,
            verified: false,
            source: 'pos',
          },
        ],
      },
      consents: {
        create: [
          {
            consentType: 'marketing',
            granted: true,
            grantedAt: new Date(),
            source: 'pos_prompt',
            privacyPolicyVersion: '2026-01',
          },
          {
            consentType: 'email',
            granted: true,
            grantedAt: new Date(),
            source: 'pos_prompt',
            privacyPolicyVersion: '2026-01',
          },
        ],
      },
      timelineEvents: {
        create: [
          {
            organizationId: org.id,
            locationId: location.id,
            eventType: 'account_created',
            eventSourceModule: 'crm',
            payload: { channel: 'pos' },
            occurredAt: new Date(),
          },
        ],
      },
    },
  });

  console.log('Seeded organization:', org.slug);
  console.log('Seeded customer:', customer.email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
