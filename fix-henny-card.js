const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ACTIVE_CUSTOMER_ID = 'eb2fd190-d73b-4d53-b8f1-9ca9282fa9db'; // actief profiel, 20pt
const CARD_ID = '6ba5c713-b064-4336-ad7d-d9b8f7284d4a'; // BC-000104, nu gekoppeld aan verwijderd profiel

async function main() {
  // Veiligheidscheck: bevestig dat het doelprofiel bestaat en actief is
  const target = await prisma.customer.findUnique({
    where: { id: ACTIVE_CUSTOMER_ID },
  });
  if (!target || target.deletedAt) {
    throw new Error('Doelprofiel niet gevonden of is zelf verwijderd — stop.');
  }

  const updated = await prisma.loyaltyCard.update({
    where: { id: CARD_ID },
    data: { customerId: ACTIVE_CUSTOMER_ID },
  });

  console.log('Kaart verhangen naar actief profiel:');
  console.log(updated);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());