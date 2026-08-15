import { IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

const SERVICE_PERIODS = ['lunch', 'dinner', 'all_day'] as const;

export class CreateReservationDto {
  @IsString()
  locationId!: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsISO8601()
  dateTime!: string;

  @IsIn(SERVICE_PERIODS)
  servicePeriod!: (typeof SERVICE_PERIODS)[number];

  @IsInt()
  @IsPositive()
  covers!: number;

  @IsOptional()
  @IsString()
  area?: string;

  @IsOptional()
  @IsString()
  tableReference?: string;
}

export class CreateCapacitySettingDto {
  @IsString()
  locationId!: string;

  @IsOptional()
  @IsString()
  area?: string;

  @IsIn(SERVICE_PERIODS)
  servicePeriod!: (typeof SERVICE_PERIODS)[number];

  @IsInt()
  @IsPositive()
  maxCovers!: number;
}

export class CreateWeatherForecastDto {
  @IsString()
  locationId!: string;

  @IsISO8601()
  forecastDate!: string;

  @IsNumber()
  temperatureCelsius!: number;

  @IsString()
  condition!: string;
}
