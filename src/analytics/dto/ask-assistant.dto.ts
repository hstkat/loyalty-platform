import { IsOptional, IsString, IsUUID } from 'class-validator';

export class AskAssistantDto {
  @IsString()
  promptText!: string;

  @IsUUID()
  locationId!: string;

  @IsString()
  date!: string; // YYYY-MM-DD, the date the question is about

  @IsOptional()
  @IsUUID()
  userId?: string;
}
