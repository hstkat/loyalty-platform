export interface IssueGiftCardDto {
  originalValue: number;
  locationId?: string;
  isOrganizationWide?: boolean;
  purchaserCustomerId?: string;
  recipientCustomerId?: string;
  recipientName?: string;
  recipientEmail?: string;
  personalMessage?: string;
  scheduledSendAt?: string;
  expiresAt?: string;
}

export interface CreateBatchDto {
  name: string;
  quantity: number;
  locationId?: string;
}

export interface ActivateGiftCardDto {
  token: string;
  originalValue: number;
  purchaserCustomerId?: string;
  recipientCustomerId?: string;
}

export interface RedeemGiftCardDto {
  token: string;
  amount: number;
  transactionId?: string;
  reason?: string;
}

export interface TopUpGiftCardDto {
  amount: number;
  reason?: string;
}

export interface BlockGiftCardDto {
  reason: string;
}

export interface ReplaceGiftCardDto {
  newCardToken: string;
  reason?: string;
}

export interface AdjustGiftCardDto {
  amount: number; // positief of negatief
  reason: string;
}

export interface RefundGiftCardDto {
  ledgerEntryId: string;
  reason?: string;
}
