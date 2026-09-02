export interface IssueGiftCardDto {
  originalValue: number;
  // Locatiescope — leeg/onbepaald array = organisatiebreed geldig,
  // gevuld = alleen geldig bij die locatie(s). Zelfde conventie als
  // VoucherTemplate.locationIds.
  locationIds?: string[];
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
  // Markeert of deze kaart als fysieke kaart/sticker wordt overhandigd —
  // bepaalt de digitaal/fysiek-uitsplitsing in de financiële rapportage.
  isPhysical?: boolean;
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
  // Optioneel — voor kassamedewerkers met een vaste locatie wordt dit
  // altijd genegeerd/afgedwongen via resolveLocationId().
  locationId?: string;
}

export interface RedeemGiftCardDto {
  token: string;
  amount: number;
  transactionId?: string;
  reason?: string;
  // Locatie waar wordt ingewisseld — nodig om de locatiescope van de
  // kaart (locationIds) te kunnen controleren.
  locationId?: string;
}

export interface TopUpGiftCardDto {
  amount: number;
  reason?: string;
  // Optioneel — voor kassamedewerkers met een vaste locatie wordt dit
  // altijd genegeerd/afgedwongen via resolveLocationId().
  locationId?: string;
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
  // Optioneel — voor kassamedewerkers met een vaste locatie wordt dit
  // altijd genegeerd/afgedwongen via resolveLocationId().
  locationId?: string;
}

export interface RefundGiftCardDto {
  ledgerEntryId: string;
  reason?: string;
  // Optioneel — voor kassamedewerkers met een vaste locatie wordt dit
  // altijd genegeerd/afgedwongen via resolveLocationId().
  locationId?: string;
}

// -- Bulk online aankoop: één Mollie-betaling, meerdere kadobonnen met
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
