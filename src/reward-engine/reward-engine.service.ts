import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, RewardRule } from '@prisma/client';

export interface CalculateRewardParams {
  organizationId: string;
  transactionId?: string;
  customerId?: string;
  tierId?: string;
  locationId?: string;
  eligibleAmount: number;
  occurredAt: Date;
  isSimulation: boolean;
}

interface TraceEntry {
  stage: string;
  message: string;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Implements the calculation order from the Module 4 design doc, section 3:
 *   Stage 0 — eligible spend (passed in by the caller, e.g. Transactions
 *             module, which already applied product-level exclusions)
 *   Stage 1 — percentage bucket (additive, unless an exclusive rule wins)
 *   Stage 2 — multiplier bucket (highest_only by default)
 *   Stage 3 — flat bonus bucket (additive, not multiplied)
 *   Stage 4 — caps (maximum_reward_per_transaction only in this MVP —
 *             customer/location period caps are modeled in the schema
 *             but not yet enforced here, see README)
 *   Stage 5 — challenge rules are intentionally NOT implemented in this
 *             pass (separate pipeline, see design doc) — out of scope
 *             for this build increment.
 *
 * Simulations and live calculations share this exact same method, per
 * the design doc's requirement that the simulator can never diverge from
 * reality.
 */
@Injectable()
export class RewardEngineService {
  constructor(private prisma: PrismaService) {}

  /**
   * Losgetrokken van calculate() zodat een aanroeper (zie
   * TransactionsService.create()) deze opzoeking al kan starten VOORDAT
   * de transactie zelf is weggeschreven — de regels hangen namelijk
   * nergens van af behalve organizationId/locationId/occurredAt, dus er
   * is geen reden om hier na elkaar op te wachten.
   */
  async fetchActiveRules(organizationId: string, locationId: string | undefined, occurredAt: Date) {
    return this.prisma.rewardRule.findMany({
      where: {
        organizationId,
        isActive: true,
        OR: [{ locationId: locationId ?? undefined }, { locationId: null }],
        AND: [
          { OR: [{ activeFrom: null }, { activeFrom: { lte: occurredAt } }] },
          { OR: [{ activeUntil: null }, { activeUntil: { gte: occurredAt } }] },
        ],
      },
      orderBy: { priority: 'desc' },
    });
  }

  async calculate(params: CalculateRewardParams, preFetchedRules?: RewardRule[]) {
    const trace: TraceEntry[] = [];
    trace.push({ stage: 'eligibility', message: `Eligible amount: €${params.eligibleAmount.toFixed(2)}` });

    const activeRules = preFetchedRules ?? (await this.fetchActiveRules(params.organizationId, params.locationId, params.occurredAt));

    // -- Stage 1: percentage bucket -----------------------------------
    const percentageRules = activeRules.filter(
      (r) => r.bucket === 'percentage' && this.percentageRuleApplies(r, params),
    );

    let combinedPercentage = 0;
    const appliedPercentageRules: RewardRule[] = [];

    const exclusivePercentage = percentageRules
      .filter((r) => r.stackingMode === 'exclusive')
      .sort((a, b) => b.priority - a.priority)[0];

    if (exclusivePercentage) {
      combinedPercentage = Number(exclusivePercentage.percentageValue ?? 0);
      appliedPercentageRules.push(exclusivePercentage);
      trace.push({
        stage: 'percentage',
        message: `${exclusivePercentage.name} (${combinedPercentage}%) — exclusive, overige percentageregels genegeerd`,
      });
    } else {
      for (const rule of percentageRules) {
        const value = Number(rule.percentageValue ?? 0);
        combinedPercentage += value;
        appliedPercentageRules.push(rule);
        trace.push({ stage: 'percentage', message: `${rule.name} (+${value}%) — additive` });
      }
    }
    const percentageSubtotal = round2((params.eligibleAmount * combinedPercentage) / 100);
    trace.push({
      stage: 'percentage',
      message: `Combined percentage: ${combinedPercentage}% -> €${percentageSubtotal.toFixed(2)}`,
    });

    // -- Stage 2: multiplier bucket ------------------------------------
    const multiplierRules = activeRules.filter(
      (r) => r.bucket === 'multiplier' && this.multiplierRuleApplies(r, params.occurredAt),
    );

    let effectiveMultiplier = 1;
    const appliedMultiplierRules: RewardRule[] = [];
    const ignoredMultiplierRules: RewardRule[] = [];

    if (multiplierRules.length > 0) {
      const sorted = [...multiplierRules].sort(
        (a, b) => Number(b.multiplierValue ?? 0) - Number(a.multiplierValue ?? 0),
      );
      const winner = sorted[0];
      effectiveMultiplier = Number(winner.multiplierValue ?? 1);
      appliedMultiplierRules.push(winner);
      ignoredMultiplierRules.push(...sorted.slice(1));
      trace.push({
        stage: 'multiplier',
        message: `${winner.name} (x${effectiveMultiplier}) — highest_only, ${sorted.length - 1} andere regel(s) genegeerd`,
      });
    } else {
      trace.push({ stage: 'multiplier', message: 'Geen actieve multiplier-regel' });
    }

    const multipliedSubtotal = round2(percentageSubtotal * effectiveMultiplier);
    trace.push({
      stage: 'multiplier',
      message: `€${percentageSubtotal.toFixed(2)} x ${effectiveMultiplier} = €${multipliedSubtotal.toFixed(2)}`,
    });

    // -- Stage 3: flat bonus bucket -------------------------------------
    const bonusRules = activeRules.filter(
      (r) => r.bucket === 'flat_bonus' && Number(r.flatBonusThreshold ?? 0) <= params.eligibleAmount,
    );
    let flatBonusTotal = 0;
    for (const rule of bonusRules) {
      const amount = Number(rule.flatBonusAmount ?? 0);
      flatBonusTotal += amount;
      trace.push({ stage: 'flat_bonus', message: `${rule.name}: +€${amount.toFixed(2)} (drempel gehaald)` });
    }
    flatBonusTotal = round2(flatBonusTotal);
    if (bonusRules.length === 0) {
      trace.push({ stage: 'flat_bonus', message: 'Geen bonus-regels met gehaalde drempel' });
    }

    const preCapTotal = round2(multipliedSubtotal + flatBonusTotal);

    // -- Stage 4: caps (maximum_reward_per_transaction only in this MVP) --
    const capRules = [...appliedPercentageRules, ...appliedMultiplierRules].filter(
      (r) => r.maximumRewardPerTransaction != null,
    );
    let finalRewardAmount = preCapTotal;
    const appliedCaps: { ruleId: string; ruleName: string; cappedFrom: number; cappedTo: number }[] = [];

    for (const rule of capRules) {
      const cap = Number(rule.maximumRewardPerTransaction);
      if (finalRewardAmount > cap) {
        appliedCaps.push({ ruleId: rule.id, ruleName: rule.name, cappedFrom: finalRewardAmount, cappedTo: cap });
        trace.push({
          stage: 'caps',
          message: `Cap "${rule.name}": €${finalRewardAmount.toFixed(2)} -> €${cap.toFixed(2)}`,
        });
        finalRewardAmount = cap;
      }
    }
    if (appliedCaps.length === 0) {
      trace.push({ stage: 'caps', message: 'Geen caps overschreden' });
    }
    finalRewardAmount = round2(finalRewardAmount);
    trace.push({ stage: 'result', message: `Final reward amount: €${finalRewardAmount.toFixed(2)}` });

    const appliedRuleIds = [...appliedPercentageRules, ...appliedMultiplierRules, ...bonusRules].map((r) => r.id);

    const calculation = await this.prisma.rewardCalculation.create({
      data: {
        organizationId: params.organizationId,
        transactionId: params.transactionId,
        customerId: params.customerId,
        eligibleAmount: params.eligibleAmount,
        combinedPercentage,
        percentageSubtotal,
        effectiveMultiplier,
        multipliedSubtotal,
        flatBonusTotal,
        preCapTotal,
        appliedCaps: appliedCaps as unknown as Prisma.InputJsonValue,
        finalRewardAmount,
        calculationTrace: trace as unknown as Prisma.InputJsonValue,
        appliedRuleIds: appliedRuleIds as unknown as Prisma.InputJsonValue,
        isSimulation: params.isSimulation,
      },
    });

    return {
      id: calculation.id,
      eligibleAmount: params.eligibleAmount,
      stages: {
        percentage: {
          combinedPercentage,
          subtotal: percentageSubtotal,
          appliedRules: appliedPercentageRules.map((r) => ({
            ruleId: r.id,
            name: r.name,
            value: Number(r.percentageValue),
            stackingMode: r.stackingMode,
          })),
        },
        multiplier: {
          effectiveMultiplier,
          subtotal: multipliedSubtotal,
          appliedRule: appliedMultiplierRules[0]
            ? {
                ruleId: appliedMultiplierRules[0].id,
                name: appliedMultiplierRules[0].name,
                value: Number(appliedMultiplierRules[0].multiplierValue),
                stackingMode: appliedMultiplierRules[0].stackingMode,
              }
            : null,
          ignoredRules: ignoredMultiplierRules.map((r) => ({ ruleId: r.id, name: r.name })),
        },
        flatBonus: {
          total: flatBonusTotal,
          appliedRules: bonusRules.map((r) => ({ ruleId: r.id, name: r.name, amount: Number(r.flatBonusAmount) })),
        },
        caps: {
          applied: appliedCaps,
          preCapAmount: preCapTotal,
        },
      },
      finalRewardAmount,
      isSimulation: params.isSimulation,
      calculationTrace: trace,
    };
  }

  private percentageRuleApplies(rule: RewardRule, params: CalculateRewardParams): boolean {
    if (rule.ruleType === 'tier') {
      return !!params.tierId && rule.tierId === params.tierId;
    }
    if (rule.ruleType === 'location') {
      return !!params.locationId && rule.locationId === params.locationId;
    }
    // base / product / other percentage rule types: apply whenever active
    // (product-category exclusions are handled upstream when the caller
    // computes eligibleAmount, per the design doc's stage-0 note).
    return true;
  }

  private multiplierRuleApplies(rule: RewardRule, occurredAt: Date): boolean {
    if (rule.ruleType === 'day' && rule.appliesOnDay) {
      const days = rule.appliesOnDay as string[];
      const dayName = WEEKDAYS[occurredAt.getUTCDay()];
      if (!days.map((d) => d.toLowerCase()).includes(dayName)) return false;
    }
    if (rule.timeWindowStart && rule.timeWindowEnd) {
      const minutes = occurredAt.getUTCHours() * 60 + occurredAt.getUTCMinutes();
      const start = rule.timeWindowStart.getUTCHours() * 60 + rule.timeWindowStart.getUTCMinutes();
      const end = rule.timeWindowEnd.getUTCHours() * 60 + rule.timeWindowEnd.getUTCMinutes();
      if (minutes < start || minutes > end) return false;
    }
    return true;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
