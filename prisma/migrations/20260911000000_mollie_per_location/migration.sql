-- ============================================================================
-- Migration: mollie_per_location
-- Maakt het mogelijk om online kadobon-betalingen per locatie/merk
-- (Het Strand vs. Zomers) op een apart Mollie-account te laten
-- binnenkomen. De ECHTE API-sleutels staan bewust NIET in de database
-- (alleen environment variables) — hier alleen het niet-geheime
-- Mollie-profiel-ID (voor rapportage/herkenning) en de koppeling die
-- vastlegt via welk merk een kaart online gekocht is.
-- ============================================================================

ALTER TABLE "locations" ADD COLUMN "mollie_profile_id" TEXT;

ALTER TABLE "gift_cards" ADD COLUMN "brand_location_id" UUID;
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_brand_location_id_fkey"
  FOREIGN KEY ("brand_location_id") REFERENCES "locations"("id") ON DELETE SET NULL;
CREATE INDEX "gift_cards_brand_location_id_idx" ON "gift_cards"("brand_location_id");
