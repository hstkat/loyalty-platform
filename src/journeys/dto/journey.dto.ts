import { IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

const NODE_TYPES = [
  'trigger',
  'wait',
  'condition',
  'segment_condition',
  'send_push',
  'send_email',
  'send_sms',
  'add_credit',
  'give_reward',
  'add_tag',
  'change_tier',
  'webhook',
  'split_test',
  'end',
] as const;

const TRIGGER_TYPES = ['event', 'scheduled_date'] as const;
const RE_ENROLLMENT_POLICIES = ['once_ever', 'once_per_completion', 'always'] as const;

export class JourneyNodeDto {
  @IsString()
  tempId!: string; // client-assigned temp id to reference in edges

  @IsIn(NODE_TYPES)
  nodeType!: (typeof NODE_TYPES)[number];

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class JourneyEdgeDto {
  @IsString()
  fromTempId!: string;

  @IsString()
  toTempId!: string;

  @IsOptional()
  @IsString()
  branchLabel?: string;
}

export class CreateJourneyDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsIn(RE_ENROLLMENT_POLICIES)
  reEnrollmentPolicy?: (typeof RE_ENROLLMENT_POLICIES)[number];

  @IsIn(TRIGGER_TYPES)
  triggerType!: (typeof TRIGGER_TYPES)[number];

  @IsOptional()
  @IsString()
  eventName?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JourneyNodeDto)
  nodes!: JourneyNodeDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JourneyEdgeDto)
  edges!: JourneyEdgeDto[];
}

export class TestJourneyDto {
  @IsUUID()
  customerId!: string;
}
