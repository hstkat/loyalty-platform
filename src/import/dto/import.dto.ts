export interface ParseImportDto {
  filename: string;
  fileBase64: string;
  locationId?: string;
}

export interface PreviewImportDto {
  columnMapping: Record<string, string>; // ons veld -> kolomnaam in het bestand
  conversionType: 'ratio' | 'one_to_one';
  conversionRate?: number; // bijv. 100 (punten per euro) bij "ratio"
  balanceMode: 'add' | 'replace';
}

export interface CommitBatchDto {
  batchSize?: number;
}

export interface ResolveReviewDto {
  resolution: 'match_existing' | 'create_new' | 'skip';
  customerId?: string; // verplicht bij "match_existing"
}
