-- ============================================================================
-- Migration: loyalty_cards
-- Adds physical loyalty card support (QR token -> LoyaltyCard -> Customer
-- -> Wallet). A card never owns the balance itself — the balance always
-- stays on the linked Customer's Wallet, so replacing/blocking/relinking
-- a card is always safe.
--
-- Depends on: 20260813000000_init_customer_crm (customers),
--             20260815000000_wallet_credit (wallet_ledger_entries, credit_rules)
-- ============================================================================

CREATE TYPE "LoyaltyCardBatchStatus" AS ENUM ('generating', 'ready', 'exported');
CREATE TYPE "LoyaltyCardStatus" AS ENUM ('unclaimed', 'active', 'blocked', 'lost', 'replaced', 'expired');

CREATE TABLE "loyalty_card_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "LoyaltyCardBatchStatus" NOT NULL DEFAULT 'generating',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exported_at" TIMESTAMP(3),
    CONSTRAINT "loyalty_card_batches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "loyalty_card_batches_organization_id_created_at_idx" ON "loyalty_card_batches"("organization_id", "created_at");

CREATE TABLE "loyalty_cards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "batch_id" UUID,
    "customer_id" UUID,
    "public_token_hash" TEXT NOT NULL,
    "card_number" TEXT NOT NULL,
    "status" "LoyaltyCardStatus" NOT NULL DEFAULT 'unclaimed',
    "pending_balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "blocked_at" TIMESTAMP(3),
    "blocked_reason" TEXT,
    "last_used_at" TIMESTAMP(3),
    "replaced_by_card_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "loyalty_cards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "loyalty_cards_public_token_hash_key" ON "loyalty_cards"("public_token_hash");
CREATE UNIQUE INDEX "loyalty_cards_card_number_key" ON "loyalty_cards"("card_number");
CREATE UNIQUE INDEX "loyalty_cards_replaced_by_card_id_key" ON "loyalty_cards"("replaced_by_card_id");
CREATE INDEX "loyalty_cards_organization_id_status_idx" ON "loyalty_cards"("organization_id", "status");
CREATE INDEX "loyalty_cards_customer_id_idx" ON "loyalty_cards"("customer_id");

ALTER TABLE "loyalty_cards" ADD CONSTRAINT "loyalty_cards_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "loyalty_card_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "loyalty_cards" ADD CONSTRAINT "loyalty_cards_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "loyalty_cards" ADD CONSTRAINT "loyalty_cards_replaced_by_card_id_fkey"
    FOREIGN KEY ("replaced_by_card_id") REFERENCES "loyalty_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "loyalty_card_pending_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "card_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_card_pending_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "loyalty_card_pending_entries_card_id_idx" ON "loyalty_card_pending_entries"("card_id");
ALTER TABLE "loyalty_card_pending_entries" ADD CONSTRAINT "loyalty_card_pending_entries_card_id_fkey"
    FOREIGN KEY ("card_id") REFERENCES "loyalty_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sectie 14: configureerbare drempel voor extra verificatie bij hoge bedragen
ALTER TABLE "credit_rules" ADD COLUMN "card_redemption_threshold" DECIMAL(10,2);
