const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const staff = await prisma.staffUser.findMany({
    where: { email: { contains: 'kassa', mode: 'insensitive' } },
    select: { email: true, permissions: true },
  });
  staff.forEach(s => {
    console.log(s.email, '->', 'wallet.redeem:', s.permissions.includes('wallet.redeem'));
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());