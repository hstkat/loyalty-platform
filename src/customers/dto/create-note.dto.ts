import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

const NOTE_TYPES = ['general', 'complaint', 'preference', 'allergy', 'vip_flag'] as const;
const VISIBILITIES = ['organization', 'location_only'] as const;

export class CreateNoteDto {
  @IsUUID()
  authorUserId!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsIn(NOTE_TYPES)
  noteType?: (typeof NOTE_TYPES)[number];

  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility?: (typeof VISIBILITIES)[number];
}
