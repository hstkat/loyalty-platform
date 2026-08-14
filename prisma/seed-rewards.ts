// Sanity-check seed for Module 2 (Transactions & POS) and Module 4
// (Reward Engine). Reproduces the worked example from the Module 4 design
// doc: base 5% + Gold tier 1% = 6%, x2 Double Credit campaign = 12% on a
// €100 transaction => €12.00 reward.
//
// Run with: npm run db:seed:rewards
// (assumes prisma:migrate:deploy has already been run for both migrations,
// and that the Module 1 seed — organization "beach-hospitality-group" —
// has already been applied, since this script reuses that organization.)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: 'beach-hospitality-group' },
    update: {},
    create: { name: 'Beach Hospitality Group', slug: 'beach-hospitality-group' },
  });

  const location = await prisma.location.upsert({
    where: { id: '22222222-2222-2222-2222-222222222222' },
    update: {},
    create: {
      id: '22222222-2222-2222-2222-222222222222',
      organizationId: org.id,
      name: 'Beachclub Noordwijk',
    },
  });

  const goldTier = await prisma.loyaltyTier.create({
    data: { organizationId: org.id, name: 'Gold' },
  });

  const customer = await prisma.customer.create({
    data: {
      organizationId: org.id,
      firstName: 'Piet',
      lastName: 'Goud',
      tierId: goldTier.id,
      sourceChannel: 'manual',
    },
  });

  // POS-connection in "manual" mode — no real POS integration needed yet,
  // consistent with the "kassa koppeling nog niet nodig" scope decision.
  const posConnection = await prisma.posConnection.create({
    data: {
      organizationId: org.id,
      locationId: location.id,
      provider: 'manual',
      connectionMode: 'bulk_only',
      status: 'active',
    },
  });

  const transaction = await prisma.transaction.create({
    data: {
      organizationId: org.id,
      locationId: location.id,
      posConnectionId: posConnection.id,
      source: 'manual',
      externalTransactionId: 'SEED-001',
      customerId: customer.id,
      status: 'completed',
      grossAmount: 100,
      netAmount: 100,
      totalAmount: 100,
      paymentMethod: 'card',
      occurredAt: new Date(),
    },
  });

  const baseRule = await prisma.rewardRule.create({
    data: {
      organizationId: org.id,
      ruleType: 'base',
      bucket: 'percentage',
      name: 'Basisregel',
      stackingMode: 'additive',
      percentageValue: 5.0,
    },
  });

  const tierRule = await prisma.rewardRule.create({
    data: {
      organizationId: org.id,
      ruleType: 'tier',
      bucket: 'percentage',
      name: 'Gold-bonus',
      stackingMode: 'additive',
      percentageValue: 1.0,
      tierId: goldTier.id,
    },
  });

  const campaignRule = await prisma.rewardRule.create({
    data: {
      organizationId: org.id,
      ruleType: 'campaign',
      bucket: 'multiplier',
      name: 'Double Credit',
      stackingMode: 'highest_only',
      multiplierValue: 2.0,
    },
  });

  const calculation = await prisma.rewardCalculation.create({
    data: {
      organizationId: org.id,
      transactionId: transaction.id,
      customerId: customer.id,
      eligibleAmount: 100.0,
      combinedPercentage: 6.0,
      percentageSubtotal: 6.0,
      effectiveMultiplier: 2.0,
      multipliedSubtotal: 12.0,
      flatBonusTotal: 0,
      preCapTotal: 12.0,
      finalRewardAmount: 12.0,
      calculationTrace: [
        { stage: 'eligibility', message: 'Eligible amount: €100.00' },
        { stage: 'percentage', message: 'Basisregel (5.00%) van toepassing' },
        { stage: 'percentage', message: 'Gold-bonus (+1.00%) van toepassing — additive' },
        { stage: 'percentage', message: 'Combined percentage: 6.00% -> €6.00' },
        { stage: 'multiplier', message: 'Double Credit (x2.00) — highest_only' },
        { stage: 'multiplier', message: '€6.00 x 2.00 = €12.00' },
        { stage: 'result', message: 'Final reward amount: €12.00' },
      ],
      appliedRuleIds: [baseRule.id, tierRule.id, campaignRule.id],
    },
  });

  console.log('Seeded transaction:', transaction.externalTransactionId, '-> total €' + transaction.totalAmount);
  console.log('Seeded reward calculation: €' + calculation.finalRewardAmount, '(expected: €12.00)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
