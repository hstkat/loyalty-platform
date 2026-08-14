import { IsArray, IsIn, IsISO8601, IsNumber, IsOptional, IsPositive, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

const PAYMENT_METHODS = ['cash', 'card', 'ideal', 'voucher', 'split', 'other'] as const;

export class LineItemDto {
  @IsString()
  description!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsNumber()
  quantity!: number;

  @IsNumber()
  unitPrice!: number;

  @IsNumber()
  lineNetAmount!: number;

  @IsOptional()
  rewardEligible?: boolean;
}

export class CreateTransactionDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsNumber()
  @IsPositive()
  grossAmount!: number;

  @IsOptional()
  @IsNumber()
  discountAmount?: number;

  @IsOptional()
  @IsNumber()
  serviceAmount?: number;

  @IsOptional()
  @IsNumber()
  vatAmount?: number;

  @IsNumber()
  netAmount!: number;

  @IsNumber()
  totalAmount!: number;

  @IsIn(PAYMENT_METHODS)
  paymentMethod!: (typeof PAYMENT_METHODS)[number];

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  tableReference?: string;

  @IsOptional()
  @IsString()
  externalTransactionId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  lineItems?: LineItemDto[];
}
