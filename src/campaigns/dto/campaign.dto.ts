import { IsArray, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

const GOALS = [
  'meer_bezoekers',
  'lunch_vullen',
  'slapende_gasten_activeren',
  'credit_laten_inwisselen',
  'omzet_verhogen',
  'vip_event_vullen',
] as const;
const INCENTIVE_TYPES = ['flat_bonus', 'multiplier', 'percentage_bonus', 'coupon', 'none'] as const;
const SCHEDULE_TYPES = ['direct', 'datetime', 'period', 'recurring'] as const;

export class CreateCampaignDto {
  @IsString()
  name!: string;

  @IsIn(GOALS)
  goal!: (typeof GOALS)[number];

  @IsOptional()
  @IsObject()
  audienceFilter?: Record<string, unknown>;

  @IsOptional()
  @IsIn(INCENTIVE_TYPES)
  incentiveType?: (typeof INCENTIVE_TYPES)[number];

  @IsOptional()
  @IsObject()
  incentiveValue?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  channels?: string[];

  @IsOptional()
  @IsIn(SCHEDULE_TYPES)
  scheduleType?: (typeof SCHEDULE_TYPES)[number];

  @IsOptional()
  @IsInt()
  maxRecipients?: number;

  @IsOptional()
  @IsNumber()
  maxRewardExposure?: number;

  @IsOptional()
  @IsNumber()
  maxRedemptionCost?: number;

  @IsOptional()
  @IsInt()
  maxIncentivePerCustomer?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  controlGroupPercentage?: number;
}

export class PreviewCampaignDto {
  @IsObject()
  audienceFilter!: Record<string, unknown>;
}
