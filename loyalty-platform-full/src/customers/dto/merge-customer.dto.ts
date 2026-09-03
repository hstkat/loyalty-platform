import { IsOptional, IsString, IsUUID } from 'class-validator';

export class MergeCustomerDto {
  @IsUUID()
  mergeWithCustomerId!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
