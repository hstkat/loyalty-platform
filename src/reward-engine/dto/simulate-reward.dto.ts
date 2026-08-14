import { IsISO8601, IsNumber, IsOptional, IsPositive, IsUUID } from 'class-validator';

export class SimulateRewardDto {
  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  tierId?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;
}
