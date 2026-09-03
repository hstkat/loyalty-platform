-- ============================================================================
-- Migration: audit_log_location
-- Legt bij elke auditregel ook de locatie vast waarop de mutatie is
-- geboekt — nodig om kassamedewerker → locatie te kunnen herleiden in
-- het audit-spoor, niet alleen in de ledger-boekingen zelf.
-- ============================================================================

ALTER TABLE "audit_log" ADD COLUMN "location_id" UUID;
