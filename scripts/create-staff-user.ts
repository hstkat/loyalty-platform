/**
 * Maakt een backoffice-account aan (of update het wachtwoord/permissies
 * van een bestaand account op hetzelfde e-mailadres). ALLEEN lokaal
 * uitvoeren — nooit als endpoint, nooit een wachtwoord in git committen.
 *
 * Gebruik:
 *   npx ts-node scripts/create-staff-user.ts <org-id> <email> <wachtwoord> <voornaam> [achternaam] [permissies-comma-gescheiden]
 *
 * Voorbeeld — Henny als volledige admin:
 *   npx ts-node scripts/create-staff-user.ts \
 *     ab51a93c-43a2-40cd-8635-f8522f68a8c8 \
 *     henny@het-strand.nl \
 *     "een-sterk-wachtwoord-hier" \
 *     Henny \
 *     "" \
 *     "customer.read,customer.write,customer.merge,transaction.read,transaction.write,wallet.read,wallet.write,gift_card.read,gift_card.write,loyalty_card.read,loyalty_card.write,campaign.read,campaign.write,analytics.read,ai_assistant.use,import.read,import.write,credit_rules.read,credit_rules.write,reward_rules.read,reward_rules.write,messaging.read,messaging.write,journeys.read,journeys.write,occupancy.read,occupancy.write,tags.read,tags.write,custom_fields.read,custom_fields.write,pos_connections.read,pos_connections.write,admin.read,admin.write"
 *
 * Laat je het permissies-argument weg, dan krijgt het account bovenstaande
 * volledige lijst standaard (handig voor het eerste/enige admin-account).
 *
 * Draai daarna: npx prisma generate  (als dat nog niet gebeurd is)
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const FULL_PERMISSIONS = [
  'customer.read', 'customer.write', 'customer.merge',
  'transaction.read', 'transaction.write',
  'wallet.read', 'wallet.write',
  'gift_card.read', 'gift_card.write',
  'loyalty_card.read', 'loyalty_card.write',
  'campaign.read', 'campaign.write',
  'analytics.read', 'ai_assistant.use',
  'import.read', 'import.write',
  'credit_rules.read', 'credit_rules.write',
  'reward_rules.read', 'reward_rules.write',
  'messaging.read', 'messaging.write',
  'journeys.read', 'journeys.write',
  'occupancy.read', 'occupancy.write',
  'tags.read', 'tags.write',
  'custom_fields.read', 'custom_fields.write',
  'pos_connections.read', 'pos_connections.write',
  'admin.read', 'admin.write',
];

async function main() {
  const [orgId, email, password, firstName, lastName, permissionsArg] = process.argv.slice(2);

  if (!orgId || !email || !password || !firstName) {
    console.error('Gebruik: npx ts-node scripts/create-staff-user.ts <org-id> <email> <wachtwoord> <voornaam> [achternaam] [permissies]');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Wachtwoord moet minstens 10 tekens lang zijn.');
    process.exit(1);
  }

  const permissions = permissionsArg ? permissionsArg.split(',').map((p) => p.trim()).filter(Boolean) : FULL_PERMISSIONS;

  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(password, 12);

    const staffUser = await prisma.staffUser.upsert({
      where: { organizationId_email: { organizationId: orgId, email } },
      update: { passwordHash, firstName, lastName: lastName || null, permissions, isActive: true, failedLoginAttempts: 0, lockedUntil: null },
      create: { organizationId: orgId, email, passwordHash, firstName, lastName: lastName || null, permissions, isActive: true },
    });

    console.log(`OK — staff-account klaar: ${staffUser.email} (${staffUser.id})`);
    console.log(`Permissies: ${staffUser.permissions.join(', ')}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
