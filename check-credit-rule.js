const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const rule = await prisma.creditRule.findFirst({
    where: { organizationId: 'ab51a93c-43a2-40cd-8635-f8522f68a8c8', isActive: true },
  });
  console.log('--- ACTIEVE CREDIT RULE ---');
  console.dir(rule, { depth: null });

  const allRules = await prisma.creditRule.findMany({
    where: { organizationId: 'ab51a93c-43a2-40cd-8635-f8522f68a8c8' },
  });
  console.log('--- ALLE CREDIT RULES (ook inactieve) ---');
  console.dir(allRules, { depth: null });
}

main().catch(console.error).finally(() => prisma.$disconnect());
