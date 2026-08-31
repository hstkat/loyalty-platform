-- ============================================================================
-- Migration: gift_card_expiry_reminder
-- Bijhoudt of de 30-dagen-voor-verloop-herinnering al verstuurd is,
-- zodat een kaart niet dubbel gemaild wordt.
-- ============================================================================

ALTER TABLE "gift_cards" ADD COLUMN "expiry_reminder_sent_at" TIMESTAMP(3);
