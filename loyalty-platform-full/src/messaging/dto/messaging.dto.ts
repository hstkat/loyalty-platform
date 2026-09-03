import { IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

const CHANNELS = ['push', 'wallet', 'email', 'sms', 'whatsapp'] as const;
const CATEGORIES = ['transactional', 'marketing'] as const;
const SOURCE_TYPES = ['campaign', 'journey', 'system'] as const;

export class CreateMessageTemplateDto {
  @IsString()
  templateGroupKey!: string;

  @IsIn(CHANNELS)
  channel!: (typeof CHANNELS)[number];

  @IsIn(CATEGORIES)
  category!: (typeof CATEGORIES)[number];

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsString()
  body!: string;
}

export class SendMessageDto {
  @IsIn(SOURCE_TYPES)
  sourceType!: (typeof SOURCE_TYPES)[number];

  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @IsString()
  templateGroupKey!: string;

  @IsArray()
  @IsUUID('4', { each: true })
  customerIds!: string[];

  @IsIn(CHANNELS)
  channel!: (typeof CHANNELS)[number];

  // Optioneel: extra {{variabelen}} bovenop de vaste basisset
  // (first_name/credit_balance/favorite_location/tier) — voor modules
  // die iets specifieks in het bericht willen zetten, bijv. de
  // Voucher-module met {{voucher_name}}/{{days_left}}. Overschrijft
  // nooit de basisset, alleen aanvullend.
  @IsOptional()
  @IsObject()
  extraVariables?: Record<string, string | number>;
}
