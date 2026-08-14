import { IsIn, IsOptional, IsString } from 'class-validator';

const FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'select'] as const;

export class CreateCustomFieldDto {
  @IsString()
  fieldKey!: string;

  @IsString()
  fieldLabel!: string;

  @IsIn(FIELD_TYPES)
  fieldType!: (typeof FIELD_TYPES)[number];

  @IsOptional()
  options?: string[];
}
