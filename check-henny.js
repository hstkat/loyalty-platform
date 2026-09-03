const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const customers = await prisma.customer.findMany({
    where: {
      OR: [
        { firstName: { contains: 'henny', mode: 'insensitive' } },
        { lastName: { contains: 'schaap', mode: 'insensitive' } },
      ],
    },
    include: {
      loyaltyCards: true,
      identities: true,
      qrTokens: true,
    },
  });
  console.log('--- CUSTOMERS ---');
  console.dir(customers, { depth: null });
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());