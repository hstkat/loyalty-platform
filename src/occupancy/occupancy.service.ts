import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AudienceFilterService } from '../common/audience-filter.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { CreateReservationDto, CreateCapacitySettingDto, CreateWeatherForecastDto } from './dto/occupancy.dto';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const OPPORTUNITY_THRESHOLD = 45; // design doc section 4, organisatie-configureerbaar in een latere pas

/**
 * Implements Module 9 (Reservations & Occupancy Booster).
 *
 * SIMPLIFICATION vs. the design doc: the forecast model only uses the
 * historical-average factor (real past Reservation rows for the same
 * day-of-week) and a simple weather correction — season/events/lead-time
 * corrections (design doc section 3) are not implemented. The incentive
 * policy thresholds (section 7) are hardcoded here rather than a
 * configurable occupancy_incentive_policy. See README.
 */
@Injectable()
export class OccupancyService {
  constructor(
    private prisma: PrismaService,
    private audienceFilter: AudienceFilterService,
    private campaigns: CampaignsService,
  ) {}

  // -- Reservations -------------------------------------------------------

  createReservation(orgId: string, dto: CreateReservationDto) {
    return this.prisma.reservation.create({
      data: {
        organizationId: orgId,
        locationId: dto.locationId,
        customerId: dto.customerId,
        dateTime: new Date(dto.dateTime),
        servicePeriod: dto.servicePeriod,
        covers: dto.covers,
        area: dto.area,
        tableReference: dto.tableReference,
        status: 'confirmed',
      },
    });
  }

  listReservations(orgId: string, locationId?: string) {
    return this.prisma.reservation.findMany({
      where: { organizationId: orgId, locationId: locationId || undefined },
      orderBy: { dateTime: 'asc' },
      take: 200,
    });
  }

  async updateReservationStatus(orgId: string, id: string, status: string) {
    const reservation = await this.prisma.reservation.findFirst({ where: { id, organizationId: orgId } });
    if (!reservation) throw new NotFoundException('Reservation not found');
    return this.prisma.reservation.update({ where: { id }, data: { status: status as never } });
  }

  // -- Capacity settings ----------------------------------------------------

  createCapacitySetting(orgId: string, dto: CreateCapacitySettingDto) {
    return this.prisma.locationCapacitySetting.create({ data: dto as never });
  }

  listCapacitySettings(orgId: string, locationId: string) {
    return this.prisma.locationCapacitySetting.findMany({ where: { locationId } });
  }

  // -- Weather --------------------------------------------------------------

  createWeatherForecast(orgId: string, dto: CreateWeatherForecastDto) {
    return this.prisma.weatherForecast.create({
      data: { locationId: dto.locationId, forecastDate: new Date(dto.forecastDate), temperatureCelsius: dto.temperatureCelsius, condition: dto.condition },
    });
  }

  // -- Occupancy calculation (design doc section 2) ------------------------

  async getOccupancy(locationId: string, date: string, servicePeriod: string, area?: string) {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);

    const [bookedCovers, capacitySetting, weather] = await Promise.all([
      this.prisma.reservation.aggregate({
        where: {
          locationId,
          servicePeriod: servicePeriod as never,
          area: area || undefined,
          status: { in: ['confirmed', 'seated', 'completed'] },
          dateTime: { gte: dayStart, lte: dayEnd },
        },
        _sum: { covers: true },
      }),
      this.prisma.locationCapacitySetting.findFirst({
        where: { locationId, servicePeriod: servicePeriod as never, area: area || null },
      }),
      this.prisma.weatherForecast.findFirst({ where: { locationId, forecastDate: new Date(date) } }),
    ]);

    const covers = bookedCovers._sum.covers ?? 0;
    const capacity = capacitySetting?.maxCovers ?? null;
    const occupancyPercentage = capacity ? Math.round((covers / capacity) * 10000) / 100 : null;

    return { date, servicePeriod, area: area ?? null, bookedCovers: covers, capacity, occupancyPercentage, weather };
  }

  // -- Forecast (design doc section 3, rule_based_v1) ------------------------

  async computeForecast(orgId: string, locationId: string, date: string, servicePeriod: string, area?: string) {
    const targetDate = new Date(date);
    const dayName = WEEKDAYS[targetDate.getUTCDay()];

    // Historical average: past reservations on the same weekday, last ~8 occurrences.
    const pastReservations = await this.prisma.reservation.findMany({
      where: {
        locationId,
        servicePeriod: servicePeriod as never,
        area: area || undefined,
        status: { in: ['confirmed', 'seated', 'completed'] },
        dateTime: { lt: targetDate },
      },
      orderBy: { dateTime: 'desc' },
      take: 200,
    });
    const sameDayPast = pastReservations.filter((r) => WEEKDAYS[r.dateTime.getUTCDay()] === dayName);
    const capacitySetting = await this.prisma.locationCapacitySetting.findFirst({
      where: { locationId, servicePeriod: servicePeriod as never, area: area || null },
    });
    const capacity = capacitySetting?.maxCovers ?? 100;

    const historicalCoversByDate = new Map<string, number>();
    for (const r of sameDayPast) {
      const key = r.dateTime.toISOString().slice(0, 10);
      historicalCoversByDate.set(key, (historicalCoversByDate.get(key) ?? 0) + r.covers);
    }
    const historicalOccupancies = [...historicalCoversByDate.values()].map((c) => (c / capacity) * 100);
    const historicalAverage = historicalOccupancies.length
      ? historicalOccupancies.reduce((s, v) => s + v, 0) / historicalOccupancies.length
      : 50; // no history yet: neutral default

    // Weather correction: sunny + warm boosts the estimate slightly.
    const weather = await this.prisma.weatherForecast.findFirst({ where: { locationId, forecastDate: targetDate } });
    let weatherCorrection = 1.0;
    if (weather) {
      if (weather.condition === 'sunny' && Number(weather.temperatureCelsius) >= 22) weatherCorrection = 1.15;
      else if (weather.condition === 'rainy') weatherCorrection = 0.85;
    }

    const forecastOccupancyPercentage = Math.min(100, Math.round(historicalAverage * weatherCorrection * 100) / 100);

    const run = await this.prisma.forecastRun.create({
      data: {
        locationId,
        forecastDate: targetDate,
        servicePeriod: servicePeriod as never,
        area,
        modelVersion: 'rule_based_v1',
        forecastOccupancyPercentage,
        factorsUsed: {
          historicalAverage: Math.round(historicalAverage * 100) / 100,
          weatherCorrection,
          sampleSize: historicalOccupancies.length,
          weather: weather ? { temperature: Number(weather.temperatureCelsius), condition: weather.condition } : null,
        },
      },
    });

    return run;
  }

  // -- Opportunity detection + recommendation (design doc sections 4-7) ------

  async detectOpportunity(orgId: string, locationId: string, forecastRunId: string) {
    const forecastRun = await this.prisma.forecastRun.findUniqueOrThrow({ where: { id: forecastRunId } });
    const forecastPct = Number(forecastRun.forecastOccupancyPercentage);

    if (forecastPct >= OPPORTUNITY_THRESHOLD) {
      return { detected: false, forecastOccupancyPercentage: forecastPct, threshold: OPPORTUNITY_THRESHOLD };
    }

    const opportunity = await this.prisma.occupancyOpportunity.create({
      data: {
        organizationId: orgId,
        locationId,
        opportunityDate: forecastRun.forecastDate,
        servicePeriod: forecastRun.servicePeriod,
        area: forecastRun.area,
        forecastRunId,
        forecastOccupancyPercentage: forecastPct,
        status: 'detected',
      },
    });

    // Incentive policy (design doc section 7): tiered, human-configured
    // thresholds — the system never picks a free-form discount.
    let incentiveType: 'multiplier' = 'multiplier';
    let multiplier = 1.5;
    if (forecastPct < 30) multiplier = 3;
    else if (forecastPct < 45) multiplier = 2;

    const audienceFilter = {
      combinator: 'AND',
      conditions: [
        { field: 'daysSinceLastVisit', operator: 'gt', value: 14 },
        { field: 'marketingConsent', operator: 'isTrue' },
      ],
    };
    const audience = await this.audienceFilter.evaluate(orgId, audienceFilter as never);

    const avgSpendEstimate = 60; // pragmatic placeholder — a real build would query Customer.averageSpend per matched customer
    const estimatedMaxRewardExposure = Math.round(audience.count * avgSpendEstimate * 0.05 * multiplier * 100) / 100;

    const recommendation = await this.prisma.occupancyRecommendation.create({
      data: {
        opportunityId: opportunity.id,
        organizationId: orgId,
        suggestedName: `${forecastRun.servicePeriod === 'lunch' ? 'Lunch' : 'Diner'} Booster ${forecastRun.forecastDate.toISOString().slice(0, 10)}`,
        audienceFilter: audienceFilter as never,
        audienceCount: audience.count,
        incentiveType,
        incentiveValue: { multiplier } as never,
        suggestedMessage: `Morgen ${forecastRun.servicePeriod === 'lunch' ? 'lunch' : 'diner'} nog rustig — kom langs en verdien ${multiplier}x Beach Credit!`,
        estimatedMaxRewardExposure,
        status: 'pending_approval',
      },
    });

    await this.prisma.occupancyOpportunity.update({ where: { id: opportunity.id }, data: { status: 'recommendation_created' } });

    return { detected: true, opportunity, recommendation };
  }

  async listRecommendations(orgId: string, status?: string) {
    return this.prisma.occupancyRecommendation.findMany({
      where: { organizationId: orgId, status: (status as never) || undefined },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getRecommendation(orgId: string, id: string) {
    const rec = await this.prisma.occupancyRecommendation.findFirst({
      where: { id, organizationId: orgId },
      include: { opportunity: { include: { forecastRun: true } } },
    });
    if (!rec) throw new NotFoundException('Recommendation not found');
    return rec;
  }

  async dismissRecommendation(orgId: string, id: string) {
    await this.getRecommendation(orgId, id);
    return this.prisma.occupancyRecommendation.update({ where: { id }, data: { status: 'dismissed' } });
  }

  /**
   * Approval flow (design doc section 8): approving a recommendation
   * creates a Module 5 DRAFT campaign — pre-filled, but not launched.
   * The actual launch remains a separate, deliberate action in Module 5,
   * exactly the recommendation -> approval -> execution separation the
   * design doc requires (mirrored by Module 10's AI suggestions later).
   */
  async approveRecommendation(orgId: string, id: string) {
    const rec = await this.getRecommendation(orgId, id);
    if (rec.status !== 'pending_approval') {
      throw new NotFoundException(`Recommendation is not pending approval (status: ${rec.status})`);
    }

    const campaign = await this.campaigns.create(orgId, {
      name: rec.suggestedName,
      goal: 'lunch_vullen',
      audienceFilter: rec.audienceFilter as never,
      incentiveType: rec.incentiveType as never,
      incentiveValue: rec.incentiveValue as never,
      channels: ['push'],
      scheduleType: 'direct',
      maxRewardExposure: Number(rec.estimatedMaxRewardExposure),
    });

    await this.prisma.occupancyRecommendation.update({
      where: { id },
      data: { status: 'approved', resultingCampaignId: campaign.id, reviewedAt: new Date() },
    });

    return { recommendation: { ...rec, status: 'approved', resultingCampaignId: campaign.id }, campaign };
  }
}
