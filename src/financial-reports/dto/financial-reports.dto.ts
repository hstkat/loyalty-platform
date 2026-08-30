export type ReportPeriodType =
  | 'today'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'quarter'
  | 'year'
  | 'custom';

export interface ReportFiltersDto {
  periodType: ReportPeriodType;
  from?: string; // ISO date — vereist bij periodType 'custom', anders afgeleid
  to?: string; // ISO date — vereist bij periodType 'custom', anders afgeleid
  locationId?: string; // leeg = hele organisatie
}

export interface ResolvedPeriod {
  periodStart: Date;
  periodEnd: Date;
}
