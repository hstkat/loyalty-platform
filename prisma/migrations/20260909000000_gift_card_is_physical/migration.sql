-- ============================================================================
-- Migration: gift_card_is_physical
-- Onderscheid fysieke vs. digitale kadobon, nodig voor gescheiden
-- rapportage (zie FinancialReportsService). Bestaande rijen krijgen
-- false (digitaal) — er zijn nog geen kaarten in productie uitgegeven,
-- dus dit is puur voor de kolomdefinitie.
-- ============================================================================

ALTER TABLE "gift_cards" ADD COLUMN "is_physical" BOOLEAN NOT NULL DEFAULT false;
