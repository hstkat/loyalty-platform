import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Implements Module 10's KPI definitions (design doc section 2), computed
 * live from Module 1/2/3/7's real tables — never a separate, duplicated
 * "analytics database". Matches the exact formulas from the design doc.
 */
@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

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
      this.prisma.customer.count({ where: { organizationId: orgId, createdAt: { gte: monthStart } } }),
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
      this.prisma.customer.count({ where: { organizationId: orgId, tierId: { not: null } } }),
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

    const results = [];
    for (const campaign of campaigns) {
      const recipients = await this.prisma.campaignRecipient.count({ where: { campaignId: campaign.id } });
      results.push({
        campaignId: campaign.id,
        name: campaign.name,
        recipients,
        currentRewardExposure: Number(campaign.currentRewardExposure),
        currentRedemptionCost: Number(campaign.currentRedemptionCost),
      });
    }
    return results.sort((a, b) => b.recipients - a.recipients);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
