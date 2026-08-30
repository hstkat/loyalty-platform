export interface IssueGiftCardDto {
  originalValue: number;
  locationId?: string;
  isOrganizationWide?: boolean;
  purchaserCustomerId?: string;
  recipientCustomerId?: string;
  recipientName?: string;
  recipientEmail?: string;
  senderName?: string;
  senderEmail?: string;
  // Alleen relevant bij online aankoop (startOnlinePurchase) — welke
  // website (Het Strand of Zomers) de koper vandaan kwam, zodat de
  // bedankpagina na betaling naar de juiste site kan terugverwijzen.
  brand?: string;
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

// -- Bulk online aankoop: één Mollie-betaling, meerdere cadeaukaarten met
// elk hun eigen ontvanger/bedrag ------------------------------------------

export interface BulkGiftCardItemDto {
  originalValue: number;
  recipientName?: string;
  recipientEmail?: string;
  personalMessage?: string;
}

export interface BulkPurchaseDto {
  senderName: string;
  senderEmail: string;
  brand?: string;
  items: BulkGiftCardItemDto[];
}
