import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const AT_RISK_THRESHOLD = 1.5; // riskRatio boven deze waarde = At Risk (design doc section 11)

/**
 * Implements Module 7's churn algorithm: personal visit cadence, not a
 * fixed threshold. A customer who normally visits every 20 days and is
 * now 35 days out (ratio 1.75) is At Risk; a customer who normally
 * visits every 60 days and is 50 days out (ratio 0.83) is not — even
 * though 50 > 35 in absolute terms.
 */
@Injectable()
export class ChurnRiskService {
  constructor(private prisma: PrismaService) {}

  async recomputeForOrganization(organizationId: string) {
    const customers = await this.prisma.customer.findMany({
      where: { organizationId, deletedAt: null, loyaltyStatus: 'active', lastVisitAt: { not: null } },
    });

    // Fallback cadence for customers without enough history (<2 visits):
    // organization-wide average among customers who DO have enough data.
    const withHistory = customers.filter((c) => c.visitCount >= 2 && c.averageVisitFrequencyDays);
    const orgAverageCadence = withHistory.length
      ? withHistory.reduce((sum, c) => sum + (c.averageVisitFrequencyDays ?? 0), 0) / withHistory.length
      : 30; // platform default if the organization has no data at all yet

    const now = Date.now();
    let processed = 0;

    for (const customer of customers) {
      const daysSinceLastVisit = Math.floor((now - customer.lastVisitAt!.getTime()) / 86400000);
      const hasPersonalCadence = customer.visitCount >= 2 && !!customer.averageVisitFrequencyDays;
      const cadence = hasPersonalCadence ? customer.averageVisitFrequencyDays! : orgAverageCadence;

      const riskRatio = cadence > 0 ? daysSinceLastVisit / cadence : 0;
      const isAtRisk = riskRatio > AT_RISK_THRESHOLD;
      const churnRiskScore = Math.min(100, Math.round(Math.min(riskRatio, 3) * 30));

      await this.prisma.churnRiskScore.upsert({
        where: { customerId: customer.id },
        create: {
          customerId: customer.id,
          organizationId,
          riskRatio,
          churnRiskScore,
          isAtRisk,
          basedOnPersonalCadence: hasPersonalCadence,
        },
        update: {
          riskRatio,
          churnRiskScore,
          isAtRisk,
          basedOnPersonalCadence: hasPersonalCadence,
          computedAt: new Date(),
        },
      });
      processed++;
    }

    return { processed, orgAverageCadence };
  }

  async getForCustomer(orgId: string, customerId: string) {
    return this.prisma.churnRiskScore.findFirst({ where: { customerId, organizationId: orgId } });
  }
}
