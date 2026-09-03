const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('=== HENNY (moet actief zijn, kaart BC-000104) ===');
  const henny = await prisma.customer.findUnique({
    where: { id: 'eb2fd190-d73b-4d53-b8f1-9ca9282fa9db' },
    include: { loyaltyCards: true },
  });
  console.dir(henny, { depth: null });

  console.log('=== KAART BC-000104 (los opgezocht) ===');
  const card104 = await prisma.loyaltyCard.findFirst({
    where: { cardNumber: 'BC-000104' },
    include: { customer: true },
  });
  console.dir(card104, { depth: null });

  console.log('=== JANNIE ===');
  const jannie = await prisma.customer.findMany({
    where: {
      OR: [
        { email: { contains: 'jannie', mode: 'insensitive' } },
      ],
    },
    include: { loyaltyCards: true },
  });
  console.dir(jannie, { depth: null });

  console.log('=== LAATSTE 10 AANGEMAAKTE KAARTEN (ongeacht klant) ===');
  const recentCards = await prisma.loyaltyCard.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { customer: { select: { firstName: true, lastName: true, email: true, deletedAt: true } } },
  });
  console.dir(recentCards, { depth: null });
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());