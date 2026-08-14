import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

const CONNECTION_MODES = ['webhook', 'polling', 'bulk_only'] as const;

export class CreatePosConnectionDto {
  @IsUUID()
  locationId!: string;

  @IsString()
  provider!: string;

  @IsIn(CONNECTION_MODES)
  connectionMode!: (typeof CONNECTION_MODES)[number];

  @IsOptional()
  @IsString()
  apiCredentialsRef?: string;
}
