-- ============================================================================
-- Migration: gift_card_location_scope
-- Vervangt gift_cards.location_id (enkelvoud) + is_organization_wide door
-- location_ids (array), exact dezelfde conventie als voucher_templates:
-- leeg array = organisatiebreed geldig, gevuld = alleen die locatie(s).
-- Voorheen werd dit veld nergens daadwerkelijk gecontroleerd bij
-- inwisseling — dat wordt nu wel afgedwongen (zie GiftCardsService.redeem()).
-- ============================================================================

ALTER TABLE "gift_cards" ADD COLUMN "location_ids" UUID[] NOT NULL DEFAULT '{}';

-- Bestaande data migreren: een kaart die niet organisatiebreed was,
-- krijgt haar losse location_id als enige element in het nieuwe array.
UPDATE "gift_cards"
SET "location_ids" = ARRAY["location_id"]
WHERE "is_organization_wide" = false AND "location_id" IS NOT NULL;

ALTER TABLE "gift_cards" DROP COLUMN "location_id";
ALTER TABLE "gift_cards" DROP COLUMN "is_organization_wide";
