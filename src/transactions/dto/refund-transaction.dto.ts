import { IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class RefundTransactionDto {
  @IsIn(['partial', 'full'])
  refundType!: 'partial' | 'full';

  @IsNumber()
  @IsPositive()
  refundedAmount!: number;

  @IsString()
  reason!: string;
}

export class VoidTransactionDto {
  @IsString()
  reason!: string;
}
