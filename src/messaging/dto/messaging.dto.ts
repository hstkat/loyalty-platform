import { IsArray, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

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
}
