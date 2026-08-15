import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

const SEGMENT_TYPES = ['standard', 'custom'] as const;
const EVALUATION_MODES = ['realtime', 'cached'] as const;

export class CreateSegmentDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(SEGMENT_TYPES)
  segmentType?: (typeof SEGMENT_TYPES)[number];

  @IsObject()
  definition!: Record<string, unknown>;

  @IsOptional()
  @IsIn(EVALUATION_MODES)
  evaluationMode?: (typeof EVALUATION_MODES)[number];
}

export class PreviewSegmentDto {
  @IsObject()
  definition!: Record<string, unknown>;
}
