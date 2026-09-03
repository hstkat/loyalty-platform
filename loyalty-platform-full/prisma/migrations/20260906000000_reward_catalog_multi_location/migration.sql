-- ============================================================================
-- Migration: reward_catalog_multi_location
-- "Cadeaus voor punten" (RewardCatalogItem) kregen tot nu toe maar 1
-- optionele locatie (location_id, FK). Zelfde locatiescope-model als bij
-- de Voucher-module: een array met 0 of meer locatie-id's — leeg =
-- organisatiebreed geldig, gevuld = alleen bij de genoemde locatie(s).
-- ============================================================================

-- Nieuwe kolom toevoegen
ALTER TABLE "reward_catalog_items" ADD COLUMN "location_ids" UUID[] NOT NULL DEFAULT '{}';

-- Bestaande enkele locatie overzetten naar de array (1 item als er een
-- locatie stond, anders leeg = organisatiebreed — precies hetzelfde
-- gedrag als voorheen voor bestaande cadeaus).
UPDATE "reward_catalog_items"
SET "location_ids" = ARRAY["location_id"]
WHERE "location_id" IS NOT NULL;

-- Oude foreign-key-constraint en kolom weghalen (CASCADE als extra
-- vangnet mocht de constraint een andere naam hebben dan verwacht)
ALTER TABLE "reward_catalog_items" DROP CONSTRAINT IF EXISTS "reward_catalog_items_location_id_fkey";
ALTER TABLE "reward_catalog_items" DROP COLUMN "location_id" CASCADE;
