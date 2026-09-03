-- ============================================================================
-- Migration: staff_home_location
-- Locatie-bepalende koppeling voor kassamedewerkers — is dit gezet, dan
-- bepaalt DEZE koppeling (server-side, nooit een door de client
-- meegestuurde locationId) op welke locatie alles wat deze gebruiker
-- doet wordt geboekt.
-- ============================================================================

ALTER TABLE "staff_users" ADD COLUMN "home_location_id" UUID;
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_home_location_id_fkey"
  FOREIGN KEY ("home_location_id") REFERENCES "locations"("id") ON DELETE SET NULL;
CREATE INDEX "staff_users_home_location_id_idx" ON "staff_users"("home_location_id");
