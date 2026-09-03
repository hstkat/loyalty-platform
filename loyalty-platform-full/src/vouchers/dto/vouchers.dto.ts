export interface VoucherTemplateDto {
  name: string;
  description?: string;
  imageUrl?: string;
  benefit: string;
  terms?: string;
  isActive?: boolean;
  validityDays?: number;
  validFrom?: string;
  validUntil?: string;
  locationIds?: string[];
  reminderDaysBeforeExpiry?: number[];
}

export interface IssueVoucherDto {
  customerId: string;
  voucherTemplateId: string;
  campaignId?: string;
  journeyId?: string;
  issueReason?: string;
  issueSource?: 'manual' | 'campaign' | 'journey' | 'reward_engine' | 'api';
  // Override de template-geldigheid voor deze ene uitgifte (optioneel —
  // meestal leeg, dan geldt de template-regel).
  validFromOverride?: string;
  validUntilOverride?: string;
}

export interface RedeemVoucherDto {
  secureToken: string;
  locationId?: string;
  transactionId?: string;
}
