import { IsIn, IsString } from 'class-validator';

const IDENTITY_TYPES = ['email', 'phone', 'qr_code', 'wallet_pass_id', 'pos_customer_ref', 'external_crm_id'] as const;

export class ResolveIdentityDto {
  @IsIn(IDENTITY_TYPES)
  identityType!: (typeof IDENTITY_TYPES)[number];

  @IsString()
  identityValue!: string;
}
