import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateTagDto {
  @IsString()
  label!: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsUUID()
  createdBy?: string;
}
