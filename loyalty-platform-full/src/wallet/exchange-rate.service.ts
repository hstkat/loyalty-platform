import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Implements the variable-value points redemption model: the same number
 * of points can be worth more or less in euros depending on the day the
 * customer redeems them (e.g. 250 points = €10 on quiet weekdays, €5 on
 * busy weekend days) — the yield-management mirror of Module 4's
 * day/time reward multipliers, but on the redemption side.
 *
 * If an organization has configured no RedemptionRateRule at all, the
 * default is 1 point = €1 — i.e. today's existing euro-based Beach
 * Credit behavior is completely unaffected unless an organization
 * explicitly opts into the points model.
 */
@Injectable()
export class ExchangeRateService {
  constructor(private prisma: PrismaService) {}

  async getPointsPerEuro(organizationId: string, locationId?: string, date: Date = new Date()): Promise<number> {
    const dayName = WEEKDAYS[date.getUTCDay()];

    const rules = await this.prisma.redemptionRateRule.findMany({
      where: {
        organizationId,
        isActive: true,
        OR: [{ locationId: locationId ?? undefined }, { locationId: null }],
      },
      orderBy: { priority: 'desc' },
    });

    const matching = rules.find((rule) => (rule.appliesOnDays as string[]).includes(dayName));
    return matching ? Number(matching.pointsPerEuro) : 1; // default: 1 point = €1
  }

  async getEuroValue(organizationId: string, points: number, locationId?: string, date?: Date): Promise<number> {
    const rate = await this.getPointsPerEuro(organizationId, locationId, date);
    return Math.round((points / rate) * 100) / 100;
  }

  async getPointsNeededForEuroAmount(
    organizationId: string,
    euroAmount: number,
    locationId?: string,
    date?: Date,
  ): Promise<number> {
    const rate = await this.getPointsPerEuro(organizationId, locationId, date);
    return Math.ceil(euroAmount * rate);
  }
}
