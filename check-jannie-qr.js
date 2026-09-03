const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const jannie = await prisma.customer.findUnique({
    where: { id: 'bb4accce-7e8f-4237-84c8-e44853c96cf5' },
    include: { qrTokens: true },
  });
  console.log('--- JANNIE QR TOKENS ---');
  console.dir(jannie?.qrTokens, { depth: null });
}

main().catch(console.error).finally(() => prisma.$disconnect());