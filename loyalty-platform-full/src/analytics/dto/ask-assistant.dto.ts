import { IsOptional, IsString, IsUUID } from 'class-validator';

export class AskAssistantDto {
  @IsString()
  promptText!: string;

  // Not @IsUUID(): see the same fix in CreateTransactionDto — production
  // data is validated by Postgres, which is looser than class-validator's
  // strict RFC4122 check.
  @IsString()
  locationId!: string;

  @IsString()
  date!: string; // YYYY-MM-DD, the date the question is about

  @IsOptional()
  @IsUUID()
  userId?: string;
}
