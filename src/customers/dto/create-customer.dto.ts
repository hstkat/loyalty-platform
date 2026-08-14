import { IsArray, IsDateString, IsEmail, IsEnum, IsIn, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

const SOURCE_CHANNELS = ['pos', 'qr', 'website', 'reservation', 'wallet', 'manual', 'import'] as const;

export class CreateCustomerDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsIn(SOURCE_CHANNELS)
  sourceChannel?: (typeof SOURCE_CHANNELS)[number];

  @IsOptional()
  @IsArray()
  interests?: string[];

  @IsOptional()
  @IsObject()
  preferences?: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  favoriteLocationId?: string;
}
