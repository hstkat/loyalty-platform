import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeRateService } from '../wallet/exchange-rate.service';

/**
 * Implements Module 10's KPI definitions (design doc section 2), computed
 * live from Module 1/2/3/7's real tables — never a separate, duplicated
 * "analytics database". Matches the exact formulas from the design doc.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private prisma: PrismaService,
    private exchangeRate: ExchangeRateService,
  ) {}

  async getDashboard(orgId: string) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [
      memberCount,
      newMembersInPeriod,
      monthTransactions,
      wallets,
      expiringLots,
      atRiskCount,
      vipCount,
    ] = await Promise.all([
      this.prisma.customer.count({ where: { organizationId: orgId, loyaltyStatus: 'active', deletedAt: null } }),
      this.prisma.customer.count({ where: { organizationId: orgId, createdAt: { gte: monthStart }, deletedAt: null } }),
      this.prisma.transaction.findMany({
        where: { organizationId: orgId, status: 'completed', customerId: { not: null }, occurredAt: { gte: monthStart } },
        select: { totalAmount: true, customerId: true },
      }),
      this.prisma.wallet.aggregate({
        where: { organizationId: orgId },
        _sum: { availableBalance: true, pendingBalance: true },
      }),
      this.prisma.walletLedgerEntry.aggregate({
        where: {
          organizationId: orgId,
          status: 'available',
          expiresAt: { gte: new Date(), lte: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) },
        },
        _sum: { remainingAmount: true },
      }),
      this.prisma.churnRiskScore.count({ where: { organizationId: orgId, isAtRisk: true } }),
      this.prisma.customer.count({ where: { organizationId: orgId, tierId: { not: null }, deletedAt: null } }),
    ]);

    const loyaltyRevenue = monthTransactions.reduce((sum, t) => sum + Number(t.totalAmount), 0);
    const uniqueCustomers = new Set(monthTransactions.map((t) => t.customerId));
    const averageSpend = uniqueCustomers.size > 0 ? loyaltyRevenue / monthTransactions.length : 0;

    const visitCountsByCustomer = new Map<string, number>();
    for (const t of monthTransactions) {
      if (!t.customerId) continue;
      visitCountsByCustomer.set(t.customerId, (visitCountsByCustomer.get(t.customerId) ?? 0) + 1);
    }
    const repeatCustomers = [...visitCountsByCustomer.values()].filter((c) => c >= 2).length;
    const repeatVisitRate = uniqueCustomers.size > 0 ? (repeatCustomers / uniqueCustomers.size) * 100 : 0;

    return {
      memberCount,
      newMembersInPeriod,
      loyaltyRevenue: round2(loyaltyRevenue),
      averageSpend: round2(averageSpend),
      repeatVisitRate: round2(repeatVisitRate),
      outstandingCredit: round2(Number(wallets._sum.availableBalance ?? 0) + Number(wallets._sum.pendingBalance ?? 0)),
      creditExpiringSoon: round2(Number(expiringLots._sum.remainingAmount ?? 0)),
      atRiskCount,
      vipCount,
    };
  }

  async getCreditAnalytics(orgId: string) {
    const [issued, redeemed, outstanding, expired] = await Promise.all([
      this.prisma.walletLedgerEntry.aggregate({
        where: { organizationId: orgId, entryType: { in: ['earn', 'bonus', 'campaign_bonus'] } },
        _sum: { amount: true },
      }),
      this.prisma.walletLedgerEntry.aggregate({
        where: { organizationId: orgId, entryType: 'redeem' },
        _sum: { amount: true },
      }),
      this.prisma.walletLedgerEntry.aggregate({
        where: { organizationId: orgId, status: 'available' },
        _sum: { remainingAmount: true },
      }),
      this.prisma.walletLedgerEntry.aggregate({
        where: { organizationId: orgId, entryType: 'expiration' },
        _sum: { amount: true },
      }),
    ]);

    const issuedTotal = Number(issued._sum.amount ?? 0);
    const redeemedTotal = Number(redeemed._sum.amount ?? 0);
    const outstandingTotal = Number(outstanding._sum.remainingAmount ?? 0);
    const expiredTotal = Number(expired._sum.amount ?? 0);

    return {
      issued: round2(issuedTotal),
      redeemed: round2(redeemedTotal),
      outstanding: round2(outstandingTotal),
      expired: round2(expiredTotal),
      redemptionPercentage: issuedTotal > 0 ? round2((redeemedTotal / issuedTotal) * 100) : 0,
      breakage: issuedTotal > 0 ? round2((expiredTotal / issuedTotal) * 100) : 0,
      liability: round2(outstandingTotal),
    };
  }

  async getCampaignRoiRanking(orgId: string) {
    const campaigns = await this.prisma.campaign.findMany({
      where: { organizationId: orgId, status: { in: ['active', 'completed', 'paused'] } },
    });

    // Eén query voor ALLE campagnes tegelijk i.p.v. één losse .count()
    // per campagne — bij veel campagnes was dit een N+1-patroon.
    const recipientCounts = await this.prisma.campaignRecipient.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: campaigns.map((c) => c.id) } },
      _count: { _all: true },
    });
    const recipientCountMap = new Map(recipientCounts.map((r) => [r.campaignId, r._count._all]));

    const results = campaigns.map((campaign) => ({
      campaignId: campaign.id,
      name: campaign.name,
      recipients: recipientCountMap.get(campaign.id) ?? 0,
      currentRewardExposure: Number(campaign.currentRewardExposure),
      currentRedemptionCost: Number(campaign.currentRedemptionCost),
    }));
    return results.sort((a, b) => b.recipients - a.recipients);
  }

  /**
   * Daily accounting closing (added on request): the figures a
   * bookkeeper needs for a single day — transaction count and revenue,
   * points issued, points redeemed with their euro-equivalent at THAT
   * day's exchange rate, and points expired. Distinct from Module 10's
   * all-time credit analytics (section 7 of the design doc), which is
   * cumulative rather than day-scoped.
   */
  async getDailyClosing(orgId: string, date: string) {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);

    const [transactions, issued, redeemedEntries, expired] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { organizationId: orgId, status: 'completed', occurredAt: { gte: dayStart, lte: dayEnd } },
        select: { totalAmount: true, customerId: true },
      }),
      this.prisma.walletLedgerEntry.aggregate({
        where: {
          organizationId: orgId,
          entryType: { in: ['earn', 'bonus', 'campaign_bonus'] },
          occurredAt: { gte: dayStart, lte: dayEnd },
        },
        _sum: { amount: true },
      }),
      // Fetched individually (not just aggregated) so we can separate
      // generic points redemptions from catalog-item (cadeau) redemptions
      // — the latter carry a real euro cost that the accounting needs,
      // distinct from the points-economy exchange rate.
      this.prisma.walletLedgerEntry.findMany({
        where: { organizationId: orgId, entryType: 'redeem', occurredAt: { gte: dayStart, lte: dayEnd } },
        select: { amount: true, metadata: true },
      }),
      this.prisma.walletLedgerEntry.aggregate({
        where: { organizationId: orgId, entryType: 'expiration', occurredAt: { gte: dayStart, lte: dayEnd } },
        _sum: { amount: true },
      }),
    ]);

    const grossRevenue = transactions.reduce((sum, t) => sum + Number(t.totalAmount), 0);
    const pointsIssued = Number(issued._sum.amount ?? 0);

    let pointsRedeemed = 0;
    let catalogGiftsCount = 0;
    let catalogGiftsValue = 0;
    for (const entry of redeemedEntries) {
      const amount = Math.abs(Number(entry.amount));
      pointsRedeemed += amount;
      const meta = entry.metadata as { rewardCatalogItemId?: string; euroValue?: number } | null;
      if (meta?.rewardCatalogItemId) {
        catalogGiftsCount += 1;
        catalogGiftsValue += Number(meta.euroValue ?? 0);
      }
    }
    const pointsExpired = Math.abs(Number(expired._sum.amount ?? 0));

    // Redeemed points' euro-equivalent uses the SAME day's rate they were
    // redeemed at — not "any active rule", since the rate varies by day
    // (design doc: 250 punten = €10 op maandag, €5 op vrijdag). Reuses
    // ExchangeRateService's real day-matching logic, the same one the
    // kassa itself uses — no second, divergent implementation.
    const dayName = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'][dayStart.getUTCDay()];
    const pointsPerEuro = await this.exchangeRate.getPointsPerEuro(orgId, undefined, dayStart);
    const redeemedEuroValue = pointsPerEuro > 0 ? round2(pointsRedeemed / pointsPerEuro) : 0;

    return {
      date,
      dayName,
      transactionCount: transactions.length,
      grossRevenue: round2(grossRevenue),
      pointsIssued: round2(pointsIssued),
      pointsRedeemed: round2(pointsRedeemed),
      redeemedEuroValue,
      catalogGiftsCount,
      catalogGiftsValue: round2(catalogGiftsValue),
      pointsExpired: round2(pointsExpired),
      pointsPerEuroThatDay: pointsPerEuro,
    };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
