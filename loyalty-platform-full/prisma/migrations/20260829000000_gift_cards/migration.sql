-- ============================================================================
-- Migration: gift_cards
-- Adds a Gift Card module, deliberately separate from the loyalty
-- Wallet/WalletLedgerEntry system: GiftCard -> GiftCardLedgerEntry is its
-- own accounting trail. A gift card purchase never touches
-- /transactions (and therefore never triggers the reward engine),
-- which is how "no loyalty earned on gift card purchase" is enforced
-- architecturally rather than via a special-case flag deep in reward
-- calculation.
--
-- Depends on: 20260813000000_init_customer_crm (customers),
--             20260814000000_transactions_pos_reward_engine (transactions)
-- ============================================================================

CREATE TYPE "GiftCardStatus" AS ENUM ('draft', 'active', 'partially_redeemed', 'redeemed', 'blocked', 'expired', 'cancelled');
CREATE TYPE "GiftCardLedgerEntryType" AS ENUM ('issue', 'sale', 'redeem', 'top_up', 'refund', 'reversal', 'adjustment', 'expiration');
CREATE TYPE "GiftCardBatchStatus" AS ENUM ('generating', 'ready', 'exported');

CREATE TABLE "gift_card_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "GiftCardBatchStatus" NOT NULL DEFAULT 'generating',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exported_at" TIMESTAMP(3),
    CONSTRAINT "gift_card_batches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gift_card_batches_organization_id_created_at_idx" ON "gift_card_batches"("organization_id", "created_at");

CREATE TABLE "gift_cards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "batch_id" UUID,
    "gift_card_number" TEXT NOT NULL,
    "public_token_hash" TEXT NOT NULL,
    "status" "GiftCardStatus" NOT NULL DEFAULT 'draft',
    "original_value" DECIMAL(10,2) NOT NULL,
    "current_balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "purchaser_customer_id" UUID,
    "recipient_customer_id" UUID,
    "recipient_name" TEXT,
    "recipient_email" TEXT,
    "mollie_payment_id" TEXT,
    "personal_message" TEXT,
    "scheduled_send_at" TIMESTAMP(3),
    "is_organization_wide" BOOLEAN NOT NULL DEFAULT true,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "blocked_at" TIMESTAMP(3),
    "blocked_reason" TEXT,
    "replaced_by_gift_card_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gift_cards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gift_cards_gift_card_number_key" ON "gift_cards"("gift_card_number");
CREATE UNIQUE INDEX "gift_cards_public_token_hash_key" ON "gift_cards"("public_token_hash");
CREATE UNIQUE INDEX "gift_cards_mollie_payment_id_key" ON "gift_cards"("mollie_payment_id");
CREATE UNIQUE INDEX "gift_cards_replaced_by_gift_card_id_key" ON "gift_cards"("replaced_by_gift_card_id");
CREATE INDEX "gift_cards_organization_id_status_idx" ON "gift_cards"("organization_id", "status");
CREATE INDEX "gift_cards_purchaser_customer_id_idx" ON "gift_cards"("purchaser_customer_id");
CREATE INDEX "gift_cards_recipient_customer_id_idx" ON "gift_cards"("recipient_customer_id");

ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "gift_card_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_purchaser_customer_id_fkey"
    FOREIGN KEY ("purchaser_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_recipient_customer_id_fkey"
    FOREIGN KEY ("recipient_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_replaced_by_gift_card_id_fkey"
    FOREIGN KEY ("replaced_by_gift_card_id") REFERENCES "gift_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "gift_card_ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "gift_card_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "entry_type" "GiftCardLedgerEntryType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "transaction_id" UUID,
    "performed_by_user_id" UUID,
    "reason" TEXT,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gift_card_ledger_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gift_card_ledger_entries_gift_card_id_occurred_at_idx" ON "gift_card_ledger_entries"("gift_card_id", "occurred_at");
ALTER TABLE "gift_card_ledger_entries" ADD CONSTRAINT "gift_card_ledger_entries_gift_card_id_fkey"
    FOREIGN KEY ("gift_card_id") REFERENCES "gift_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gift_card_ledger_entries" ADD CONSTRAINT "gift_card_ledger_entries_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
