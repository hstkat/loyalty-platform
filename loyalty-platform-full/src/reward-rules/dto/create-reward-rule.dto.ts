import { IsArray, IsBoolean, IsIn, IsISO8601, IsInt, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';

const RULE_TYPES = ['base', 'tier', 'day', 'time', 'location', 'product', 'campaign', 'bonus', 'challenge'] as const;
const BUCKETS = ['percentage', 'multiplier', 'flat_bonus', 'challenge'] as const;
const STACKING_MODES = ['additive', 'exclusive', 'highest_only'] as const;

export class CreateRewardRuleDto {
  @IsIn(RULE_TYPES)
  ruleType!: (typeof RULE_TYPES)[number];

  @IsIn(BUCKETS)
  bucket!: (typeof BUCKETS)[number];

  @IsString()
  name!: string;

  @IsIn(STACKING_MODES)
  stackingMode!: (typeof STACKING_MODES)[number];

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  tierId?: string;

  @IsOptional()
  @IsNumber()
  percentageValue?: number;

  @IsOptional()
  @IsNumber()
  multiplierValue?: number;

  @IsOptional()
  @IsNumber()
  flatBonusAmount?: number;

  @IsOptional()
  @IsNumber()
  flatBonusThreshold?: number;

  @IsOptional()
  @IsNumber()
  maximumRewardPerTransaction?: number;

  @IsOptional()
  @IsArray()
  appliesOnDay?: string[];

  @IsOptional()
  @IsISO8601()
  timeWindowStart?: string;

  @IsOptional()
  @IsISO8601()
  timeWindowEnd?: string;

  @IsOptional()
  @IsArray()
  productCategories?: string[];

  @IsOptional()
  @IsBoolean()
  isExclusion?: boolean;

  @IsOptional()
  @IsISO8601()
  activeFrom?: string;

  @IsOptional()
  @IsISO8601()
  activeUntil?: string;
}
