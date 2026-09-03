-- ============================================================================
-- Migration: bulk_gift_card_purchase
-- Maakt bulk-aankoop van cadeaukaarten mogelijk (meerdere ontvangers +
-- bedragen in één betaling): mollie_payment_id was 1-op-1 uniek (één
-- betaling = precies één kaart), dat wordt nu 1-op-veel (één betaling
-- kan meerdere kaarten activeren).
-- ============================================================================

-- Verwijder de unieke-constraint op mollie_payment_id
DROP INDEX IF EXISTS "gift_cards_mollie_payment_id_key";

-- Vervang door een gewone (niet-unieke) index — nog steeds nodig voor
-- snelle lookups bij het activeren via de webhook.
CREATE INDEX "gift_cards_mollie_payment_id_idx" ON "gift_cards"("mollie_payment_id");
