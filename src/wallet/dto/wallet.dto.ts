import { IsNumber, IsOptional, IsPositive, IsString, IsUUID } from 'class-validator';

export class ReserveRedemptionDto {
  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsUUID()
  transactionId!: string;

  @IsString()
  idempotencyKey!: string;
}

export class ManualAdjustmentDto {
  @IsNumber()
  amount!: number; // positive = credit toevoegen, negative = credit verwijderen

  @IsString()
  reason!: string;

  @IsOptional()
  @IsUUID()
  performedByUserId?: string;
}
