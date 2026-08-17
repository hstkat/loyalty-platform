export interface CreateBatchDto {
  name: string;
  quantity: number;
  locationId?: string;
}

export interface ClaimNewCustomerDto {
  firstName: string;
  lastName?: string;
  email: string;
  phone: string;
  dateOfBirth?: string;
  marketingConsent?: boolean;
}

export interface ClaimLinkExistingDto {
  sessionToken: string;
}

export interface AdminLinkCardDto {
  token: string;
  customerId: string;
}

export interface BlockCardDto {
  reason: string;
}

export interface ReplaceCardDto {
  newCardToken: string;
  reason?: string;
}
