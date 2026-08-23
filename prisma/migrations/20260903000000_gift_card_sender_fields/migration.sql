-- ============================================================================
-- Migration: gift_card_sender_fields
-- Voegt afzendergegevens toe aan cadeaukaarten (naam + e-mailadres),
-- nodig voor de aparte aankoopbevestiging aan de koper. senderConfirmationSentAt
-- is een extra idempotency-vangnet los van de bestaande status-check, voor
-- het geval confirmMolliePayment ooit gelijktijdig zou worden aangeroepen.
-- ============================================================================

ALTER TABLE "gift_cards" ADD COLUMN "sender_name" TEXT;
ALTER TABLE "gift_cards" ADD COLUMN "sender_email" TEXT;
ALTER TABLE "gift_cards" ADD COLUMN "sender_confirmation_sent_at" TIMESTAMP(3);
