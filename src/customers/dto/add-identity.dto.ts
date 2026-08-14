import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

const IDENTITY_TYPES = ['email', 'phone', 'qr_code', 'wallet_pass_id', 'pos_customer_ref', 'external_crm_id'] as const;
const SOURCE_CHANNELS = ['pos', 'qr', 'website', 'reservation', 'wallet', 'manual', 'import'] as const;

export class AddIdentityDto {
  @IsIn(IDENTITY_TYPES)
  identityType!: (typeof IDENTITY_TYPES)[number];

  @IsString()
  identityValue!: string;

  @IsIn(SOURCE_CHANNELS)
  source!: (typeof SOURCE_CHANNELS)[number];

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsBoolean()
  verified?: boolean;
}
