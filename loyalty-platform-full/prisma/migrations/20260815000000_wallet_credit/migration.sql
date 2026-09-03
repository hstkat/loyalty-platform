-- ============================================================================
-- Migration: wallet_credit
-- Module 3: Wallet & Credit
--
-- Depends on: 20260813000000_init_customer_crm (customers, locations)
--             20260814000000_transactions_pos_reward_engine (transactions)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

CREATE TYPE "WalletLedgerEntryType" AS ENUM (
  'earn', 'redeem', 'bonus', 'campaign_bonus', 'manual_adjustment',
  'refund_reversal', 'expiration', 'transfer', 'correction'
);
CREATE TYPE "WalletLedgerEntryStatus" AS ENUM ('pending', 'available', 'reserved', 'redeemed', 'expired', 'reversed');
CREATE TYPE "WalletLedgerSource" AS ENUM ('pos', 'manual', 'campaign', 'system');
CREATE TYPE "PerformedByType" AS ENUM ('system', 'staff', 'customer_self_service');
CREATE TYPE "WalletPassType" AS ENUM ('apple', 'google');
CREATE TYPE "WalletPassStatus" AS ENUM ('active', 'removed', 'not_installed');

-- ----------------------------------------------------------------------------
-- wallets
-- ----------------------------------------------------------------------------

CREATE TABLE "wallets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "available_balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "pending_balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "reserved_balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lifetime_expired" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lifetime_earned" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lifetime_redeemed" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wallets_customer_id_key" ON "wallets"("customer_id");
CREATE INDEX "wallets_organization_id_idx" ON "wallets"("organization_id");
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- wallet_ledger_entries
-- ----------------------------------------------------------------------------

CREATE TABLE "wallet_ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entry_type" "WalletLedgerEntryType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "remaining_amount" DECIMAL(10,2),
    "status" "WalletLedgerEntryStatus",
    "source" "WalletLedgerSource" NOT NULL,
    "transaction_id" UUID,
    "reward_calculation_id" UUID,
    "campaign_id" UUID,
    "performed_by_user_id" UUID,
    "performed_by_type" "PerformedByType" NOT NULL,
    "related_ledger_entry_id" UUID,
    "reason" TEXT,
    "metadata" JSONB,
    "expires_at" TIMESTAMP(3),
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wallet_ledger_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wallet_ledger_entries_wallet_id_entry_type_idx" ON "wallet_ledger_entries"("wallet_id", "entry_type");
CREATE INDEX "wallet_ledger_entries_organization_id_idx" ON "wallet_ledger_entries"("organization_id");
CREATE INDEX "wallet_ledger_entries_wallet_id_status_expires_at_idx" ON "wallet_ledger_entries"("wallet_id", "status", "expires_at");
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_wallet_id_fkey"
    FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- wallet_ledger_allocations
-- ----------------------------------------------------------------------------

CREATE TABLE "wallet_ledger_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "debit_entry_id" UUID NOT NULL,
    "credit_entry_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wallet_ledger_allocations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wallet_ledger_allocations_debit_entry_id_idx" ON "wallet_ledger_allocations"("debit_entry_id");
CREATE INDEX "wallet_ledger_allocations_credit_entry_id_idx" ON "wallet_ledger_allocations"("credit_entry_id");
ALTER TABLE "wallet_ledger_allocations" ADD CONSTRAINT "wallet_ledger_allocations_debit_entry_id_fkey"
    FOREIGN KEY ("debit_entry_id") REFERENCES "wallet_ledger_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wallet_ledger_allocations" ADD CONSTRAINT "wallet_ledger_allocations_credit_entry_id_fkey"
    FOREIGN KEY ("credit_entry_id") REFERENCES "wallet_ledger_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- wallet_passes
-- ----------------------------------------------------------------------------

CREATE TABLE "wallet_passes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_id" UUID NOT NULL,
    "pass_type" "WalletPassType" NOT NULL,
    "serial_number" TEXT NOT NULL,
    "device_library_identifier" TEXT,
    "push_token" TEXT,
    "status" "WalletPassStatus" NOT NULL DEFAULT 'not_installed',
    "last_pushed_at" TIMESTAMP(3),
    "installed_at" TIMESTAMP(3),
    "removed_at" TIMESTAMP(3),
    CONSTRAINT "wallet_passes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wallet_passes_serial_number_key" ON "wallet_passes"("serial_number");
CREATE INDEX "wallet_passes_wallet_id_idx" ON "wallet_passes"("wallet_id");
ALTER TABLE "wallet_passes" ADD CONSTRAINT "wallet_passes_wallet_id_fkey"
    FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- credit_rules
-- ----------------------------------------------------------------------------

CREATE TABLE "credit_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "validity_days" INTEGER NOT NULL DEFAULT 60,
    "usable_from_next_visit" BOOLEAN NOT NULL DEFAULT true,
    "minimum_order_amount" DECIMAL(10,2),
    "maximum_redeem_percentage" DECIMAL(5,2),
    "excluded_product_categories" JSONB,
    "excluded_days" JSONB,
    "non_combinable_campaign_ids" JSONB,
    "transfers_allowed" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "credit_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "credit_rules_organization_id_idx" ON "credit_rules"("organization_id");
ALTER TABLE "credit_rules" ADD CONSTRAINT "credit_rules_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
