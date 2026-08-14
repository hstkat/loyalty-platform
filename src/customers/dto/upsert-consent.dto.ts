import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

const CONSENT_TYPES = ['marketing', 'email', 'sms', 'push', 'profiling', 'data_sharing_partners'] as const;
const CONSENT_SOURCES = ['signup_form', 'pos_prompt', 'wallet_signup', 'website', 'import', 'manual_staff', 'api'] as const;

export class UpsertConsentDto {
  @IsIn(CONSENT_TYPES)
  consentType!: (typeof CONSENT_TYPES)[number];

  @IsBoolean()
  granted!: boolean;

  @IsIn(CONSENT_SOURCES)
  source!: (typeof CONSENT_SOURCES)[number];

  @IsString()
  privacyPolicyVersion!: string;

  @IsOptional()
  @IsString()
  ipAddress?: string;
}
