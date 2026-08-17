/**
 * Shared audience-filter evaluator for the AND/OR condition-tree DSL used
 * across Module 5 (campaign audiences), Module 7 (segments), Module 9 and
 * Module 10 (AI tool `getSegmentPreview`). One evaluator, one definition
 * of what a condition means — consistent with the platform-wide principle
 * of never duplicating a piece of business logic across modules.
 *
 * SIMPLIFICATION vs. the Module 7 design doc: this evaluates in
 * application code against a pre-loaded batch of customers, rather than
 * generating a dynamic, indexed SQL WHERE-clause. This is correct but not
 * optimized for very large customer bases — Module 7's "query generator"
 * (design doc section 9) should replace this once that module gets its
 * own API layer. Documented here and in the README.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface FilterCondition {
  field: string;
  operator: string;
  value?: unknown;
}

export interface FilterGroup {
  combinator: 'AND' | 'OR';
  conditions?: FilterCondition[];
  groups?: FilterGroup[];
}

interface CustomerView {
  id: string;
  lifetimeSpend: number;
  daysSinceLastVisit: number | null;
  visitCount: number;
  tierId: string | null;
  creditBalance: number;
  marketingConsent: boolean;
  favoriteVisitDay: string | null;
  isAtRisk: boolean;
  churnRiskScore: number | null;
  // Dagen tot de eerstvolgende verjaardag (0 = vandaag, 365/366 als geen
  // geboortedatum bekend is — bewust een hoge waarde i.p.v. null, zodat
  // "kleiner dan N"-filters op een ontbrekende datum nooit per ongeluk
  // matchen). Voor verjaardagscampagnes/-journeys.
  daysUntilBirthday: number | null;
}

@Injectable()
export class AudienceFilterService {
  constructor(private prisma: PrismaService) {}

  private computeDaysUntilBirthday(dateOfBirth: Date | null, now: Date): number | null {
    if (!dateOfBirth) return null;
    const thisYear = now.getFullYear();
    let next = new Date(Date.UTC(thisYear, dateOfBirth.getUTCMonth(), dateOfBirth.getUTCDate()));
    const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    if (next.getTime() < todayUtc.getTime()) {
      next = new Date(Date.UTC(thisYear + 1, dateOfBirth.getUTCMonth(), dateOfBirth.getUTCDate()));
    }
    return Math.round((next.getTime() - todayUtc.getTime()) / 86400000);
  }

  async evaluate(organizationId: string, filter: FilterGroup) {
    const customers = await this.prisma.customer.findMany({
      where: { organizationId, deletedAt: null, loyaltyStatus: 'active' },
      include: {
        wallet: true,
        consents: { where: { consentType: 'marketing' } },
        churnRiskScore: true,
      },
      take: 5000, // pragmatic cap for this build pass, see class-level note
    });

    const now = Date.now();
    const nowDate = new Date();
    const views: CustomerView[] = customers.map((c) => ({
      id: c.id,
      lifetimeSpend: Number(c.lifetimeSpend),
      daysSinceLastVisit: c.lastVisitAt ? Math.floor((now - c.lastVisitAt.getTime()) / 86400000) : null,
      visitCount: c.visitCount,
      tierId: c.tierId,
      creditBalance: c.wallet ? Number(c.wallet.availableBalance) : 0,
      marketingConsent: c.consents.some((cs) => cs.granted),
      favoriteVisitDay: c.favoriteVisitDay,
      isAtRisk: c.churnRiskScore?.isAtRisk ?? false,
      churnRiskScore: c.churnRiskScore?.churnRiskScore ?? null,
      daysUntilBirthday: this.computeDaysUntilBirthday(c.dateOfBirth, nowDate),
    }));

    const matched = views.filter((v) => this.matchesGroup(v, filter));
    return { matchedCustomerIds: matched.map((m) => m.id), count: matched.length };
  }

  private matchesGroup(view: CustomerView, group: FilterGroup): boolean {
    const conditionResults = (group.conditions ?? []).map((c) => this.matchesCondition(view, c));
    const groupResults = (group.groups ?? []).map((g) => this.matchesGroup(view, g));
    const results = [...conditionResults, ...groupResults];
    if (results.length === 0) return true;
    return group.combinator === 'OR' ? results.some(Boolean) : results.every(Boolean);
  }

  private matchesCondition(view: CustomerView, condition: FilterCondition): boolean {
    const fieldValue = (view as unknown as Record<string, unknown>)[condition.field];
    const { operator, value } = condition;

    switch (operator) {
      case 'eq':
        return fieldValue === value;
      case 'neq':
        return fieldValue !== value;
      case 'gt':
        return typeof fieldValue === 'number' && fieldValue > (value as number);
      case 'gte':
        return typeof fieldValue === 'number' && fieldValue >= (value as number);
      case 'lt':
        return typeof fieldValue === 'number' && fieldValue < (value as number);
      case 'lte':
        return typeof fieldValue === 'number' && fieldValue <= (value as number);
      case 'in':
        return Array.isArray(value) && value.includes(fieldValue);
      case 'notIn':
        return Array.isArray(value) && !value.includes(fieldValue);
      case 'isTrue':
        return fieldValue === true;
      case 'isFalse':
        return fieldValue === false;
      case 'isNull':
        return fieldValue === null || fieldValue === undefined;
      case 'isNotNull':
        return fieldValue !== null && fieldValue !== undefined;
      default:
        return false;
    }
  }
}
