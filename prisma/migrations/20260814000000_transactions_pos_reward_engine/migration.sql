-- ============================================================================
-- Migration: transactions_pos_reward_engine
-- Module 2: Transactions & POS (herziene, volledige versie)
-- Module 4: Reward Engine (herziene, volledige versie)
--
-- Depends on: 20260813000000_init_customer_crm (organizations, locations,
-- customers, loyalty_tiers must already exist)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums — Module 2
-- ----------------------------------------------------------------------------

CREATE TYPE "PosConnectionMode" AS ENUM ('webhook', 'polling', 'bulk_only');
CREATE TYPE "PosConnectionStatus" AS ENUM ('active', 'paused', 'error', 'not_configured');
CREATE TYPE "IngestionMethod" AS ENUM ('webhook', 'poll', 'bulk_import', 'csv_upload');
CREATE TYPE "PosEventProcessingStatus" AS ENUM ('pending', 'processed', 'failed', 'ignored_duplicate');
CREATE TYPE "TransactionSource" AS ENUM ('pos', 'manual', 'csv_import');
CREATE TYPE "TransactionStatus" AS ENUM ('pending', 'completed', 'failed', 'voided', 'partially_refunded', 'refunded', 'charged_back');
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'card', 'ideal', 'voucher', 'split', 'other');
CREATE TYPE "RefundType" AS ENUM ('partial', 'full');
CREATE TYPE "RefundInitiator" AS ENUM ('pos', 'manual_staff');
CREATE TYPE "ChargebackStatus" AS ENUM ('received', 'disputed', 'lost', 'won');
CREATE TYPE "MappingStatus" AS ENUM ('mapped', 'unmapped', 'needs_review');
CREATE TYPE "MatchedVia" AS ENUM ('external_id_direct', 'phone', 'email', 'manual');
CREATE TYPE "FailureStage" AS ENUM ('normalization', 'validation', 'matching', 'storage');
CREATE TYPE "FailedTxStatus" AS ENUM ('pending_retry', 'retrying', 'resolved', 'abandoned');
CREATE TYPE "ResolvedBy" AS ENUM ('automatic_retry', 'manual_staff');
CREATE TYPE "SyncRunType" AS ENUM ('polling', 'reconciliation', 'manual_trigger');
CREATE TYPE "SyncRunStatus" AS ENUM ('success', 'partial_success', 'failed');

-- ----------------------------------------------------------------------------
-- Enums — Module 4
-- ----------------------------------------------------------------------------

CREATE TYPE "RewardRuleType" AS ENUM ('base', 'tier', 'day', 'time', 'location', 'product', 'campaign', 'bonus', 'challenge');
CREATE TYPE "RewardBucket" AS ENUM ('percentage', 'multiplier', 'flat_bonus', 'challenge');
CREATE TYPE "StackingMode" AS ENUM ('additive', 'exclusive', 'highest_only');
CREATE TYPE "CapPeriodType" AS ENUM ('daily', 'weekly', 'monthly');

-- ----------------------------------------------------------------------------
-- pos_connections
-- ----------------------------------------------------------------------------

CREATE TABLE "pos_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "connection_mode" "PosConnectionMode" NOT NULL,
    "api_credentials_ref" TEXT,
    "webhook_secret_ref" TEXT,
    "polling_interval_seconds" INTEGER,
    "last_synced_at" TIMESTAMP(3),
    "last_successful_sync_at" TIMESTAMP(3),
    "status" "PosConnectionStatus" NOT NULL DEFAULT 'not_configured',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pos_connections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pos_connections_organization_id_idx" ON "pos_connections"("organization_id");
CREATE INDEX "pos_connections_location_id_idx" ON "pos_connections"("location_id");
ALTER TABLE "pos_connections" ADD CONSTRAINT "pos_connections_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- transactions (needed before pos_events due to FK)
-- ----------------------------------------------------------------------------

CREATE TABLE "transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "pos_connection_id" UUID,
    "source" "TransactionSource" NOT NULL DEFAULT 'manual',
    "external_transaction_id" TEXT,
    "customer_id" UUID,
    "table_reference" TEXT,
    "reservation_id" UUID,
    "status" "TransactionStatus" NOT NULL DEFAULT 'pending',
    "gross_amount" DECIMAL(10,2) NOT NULL,
    "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "service_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "vat_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(10,2) NOT NULL,
    "total_amount" DECIMAL(10,2) NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "pos_created_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "transactions_pos_connection_id_external_transaction_id_key"
    ON "transactions"("pos_connection_id", "external_transaction_id");
CREATE INDEX "transactions_organization_id_idx" ON "transactions"("organization_id");
CREATE INDEX "transactions_location_id_occurred_at_idx" ON "transactions"("location_id", "occurred_at");
CREATE INDEX "transactions_customer_id_idx" ON "transactions"("customer_id");

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_pos_connection_id_fkey"
    FOREIGN KEY ("pos_connection_id") REFERENCES "pos_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- pos_events
-- ----------------------------------------------------------------------------

CREATE TABLE "pos_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pos_connection_id" UUID NOT NULL,
    "ingestion_method" "IngestionMethod" NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_status" "PosEventProcessingStatus" NOT NULL DEFAULT 'pending',
    "transaction_id" UUID,
    CONSTRAINT "pos_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pos_events_pos_connection_id_payload_hash_idx" ON "pos_events"("pos_connection_id", "payload_hash");
CREATE INDEX "pos_events_pos_connection_id_received_at_idx" ON "pos_events"("pos_connection_id", "received_at");
ALTER TABLE "pos_events" ADD CONSTRAINT "pos_events_pos_connection_id_fkey"
    FOREIGN KEY ("pos_connection_id") REFERENCES "pos_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pos_events" ADD CONSTRAINT "pos_events_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- transaction_line_items + modifiers
-- ----------------------------------------------------------------------------

CREATE TABLE "pos_product_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "pos_connection_id" UUID NOT NULL,
    "external_product_id" TEXT NOT NULL,
    "external_product_name" TEXT,
    "internal_category" TEXT,
    "reward_eligible_override" BOOLEAN,
    "mapping_status" "MappingStatus" NOT NULL DEFAULT 'unmapped',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pos_product_mappings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pos_product_mappings_pos_connection_id_external_product_id_key"
    ON "pos_product_mappings"("pos_connection_id", "external_product_id");
ALTER TABLE "pos_product_mappings" ADD CONSTRAINT "pos_product_mappings_pos_connection_id_fkey"
    FOREIGN KEY ("pos_connection_id") REFERENCES "pos_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "transaction_line_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "transaction_id" UUID NOT NULL,
    "pos_product_id" TEXT,
    "internal_product_mapping_id" UUID,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "line_gross_amount" DECIMAL(10,2) NOT NULL,
    "line_discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "line_net_amount" DECIMAL(10,2) NOT NULL,
    "line_vat_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "reward_eligible" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "transaction_line_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "transaction_line_items_transaction_id_idx" ON "transaction_line_items"("transaction_id");
ALTER TABLE "transaction_line_items" ADD CONSTRAINT "transaction_line_items_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transaction_line_items" ADD CONSTRAINT "transaction_line_items_internal_product_mapping_id_fkey"
    FOREIGN KEY ("internal_product_mapping_id") REFERENCES "pos_product_mappings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "transaction_line_item_modifiers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "line_item_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_adjustment" DECIMAL(10,2) NOT NULL,
    CONSTRAINT "transaction_line_item_modifiers_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "transaction_line_item_modifiers" ADD CONSTRAINT "transaction_line_item_modifiers_line_item_id_fkey"
    FOREIGN KEY ("line_item_id") REFERENCES "transaction_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- refunds / voids / chargebacks
-- ----------------------------------------------------------------------------

CREATE TABLE "transaction_refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "transaction_id" UUID NOT NULL,
    "refund_type" "RefundType" NOT NULL,
    "refunded_amount" DECIMAL(10,2) NOT NULL,
    "refunded_line_items" JSONB,
    "reason" TEXT NOT NULL,
    "external_refund_id" TEXT,
    "initiated_by" "RefundInitiator" NOT NULL,
    "performed_by_user_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "transaction_refunds_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "transaction_refunds_transaction_id_idx" ON "transaction_refunds"("transaction_id");
ALTER TABLE "transaction_refunds" ADD CONSTRAINT "transaction_refunds_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "transaction_voids" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "transaction_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "performed_by_user_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "transaction_voids_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "transaction_voids_transaction_id_idx" ON "transaction_voids"("transaction_id");
ALTER TABLE "transaction_voids" ADD CONSTRAINT "transaction_voids_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "transaction_chargebacks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "transaction_id" UUID NOT NULL,
    "chargeback_amount" DECIMAL(10,2) NOT NULL,
    "reason_code" TEXT,
    "status" "ChargebackStatus" NOT NULL DEFAULT 'received',
    "received_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "transaction_chargebacks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "transaction_chargebacks_transaction_id_idx" ON "transaction_chargebacks"("transaction_id");
ALTER TABLE "transaction_chargebacks" ADD CONSTRAINT "transaction_chargebacks_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- pos_customer_mappings
-- ----------------------------------------------------------------------------

CREATE TABLE "pos_customer_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pos_connection_id" UUID NOT NULL,
    "external_customer_id" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "matched_via" "MatchedVia" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pos_customer_mappings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pos_customer_mappings_conn_external_customer_key"
    ON "pos_customer_mappings"("pos_connection_id", "external_customer_id");
ALTER TABLE "pos_customer_mappings" ADD CONSTRAINT "pos_customer_mappings_pos_connection_id_fkey"
    FOREIGN KEY ("pos_connection_id") REFERENCES "pos_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pos_customer_mappings" ADD CONSTRAINT "pos_customer_mappings_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- failed_transactions
-- ----------------------------------------------------------------------------

CREATE TABLE "failed_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pos_event_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "failure_stage" "FailureStage" NOT NULL,
    "error_message" TEXT NOT NULL,
    "error_details" JSONB,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 5,
    "next_retry_at" TIMESTAMP(3),
    "status" "FailedTxStatus" NOT NULL DEFAULT 'pending_retry',
    "resolved_at" TIMESTAMP(3),
    "resolved_by" "ResolvedBy",
    CONSTRAINT "failed_transactions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "failed_transactions_organization_id_status_idx" ON "failed_transactions"("organization_id", "status");
ALTER TABLE "failed_transactions" ADD CONSTRAINT "failed_transactions_pos_event_id_fkey"
    FOREIGN KEY ("pos_event_id") REFERENCES "pos_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- pos_sync_runs
-- ----------------------------------------------------------------------------

CREATE TABLE "pos_sync_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pos_connection_id" UUID NOT NULL,
    "run_type" "SyncRunType" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "transactions_found_at_pos" INTEGER,
    "transactions_ingested" INTEGER NOT NULL DEFAULT 0,
    "discrepancy_count" INTEGER NOT NULL DEFAULT 0,
    "discrepancy_details" JSONB,
    "status" "SyncRunStatus" NOT NULL DEFAULT 'success',
    CONSTRAINT "pos_sync_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pos_sync_runs_pos_connection_id_started_at_idx" ON "pos_sync_runs"("pos_connection_id", "started_at");
ALTER TABLE "pos_sync_runs" ADD CONSTRAINT "pos_sync_runs_pos_connection_id_fkey"
    FOREIGN KEY ("pos_connection_id") REFERENCES "pos_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Module 4 — Reward Engine tables
-- ============================================================================

CREATE TABLE "reward_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "rule_type" "RewardRuleType" NOT NULL,
    "bucket" "RewardBucket" NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "stacking_mode" "StackingMode" NOT NULL,
    "percentage_value" DECIMAL(5,2),
    "multiplier_value" DECIMAL(4,2),
    "flat_bonus_amount" DECIMAL(10,2),
    "flat_bonus_threshold" DECIMAL(10,2),
    "challenge_condition" JSONB,
    "challenge_reward_amount" DECIMAL(10,2),
    "tier_id" UUID,
    "applies_on_day" JSONB,
    "time_window_start" TIME,
    "time_window_end" TIME,
    "product_categories" JSONB,
    "is_exclusion" BOOLEAN NOT NULL DEFAULT false,
    "campaign_id" UUID,
    "maximum_reward_per_transaction" DECIMAL(10,2),
    "active_from" TIMESTAMP(3),
    "active_until" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parent_rule_id" UUID,
    "superseded_by_rule_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reward_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reward_rules_organization_id_is_active_bucket_idx" ON "reward_rules"("organization_id", "is_active", "bucket");
CREATE INDEX "reward_rules_location_id_idx" ON "reward_rules"("location_id");
ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_tier_id_fkey"
    FOREIGN KEY ("tier_id") REFERENCES "loyalty_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "reward_customer_caps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "period_type" "CapPeriodType" NOT NULL,
    "max_amount" DECIMAL(10,2) NOT NULL,
    "current_period_spent" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "current_period_start" DATE NOT NULL,
    CONSTRAINT "reward_customer_caps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reward_customer_caps_customer_id_idx" ON "reward_customer_caps"("customer_id");
ALTER TABLE "reward_customer_caps" ADD CONSTRAINT "reward_customer_caps_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "reward_location_caps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "period_type" "CapPeriodType" NOT NULL,
    "max_amount" DECIMAL(10,2) NOT NULL,
    "current_period_spent" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "current_period_start" DATE NOT NULL,
    CONSTRAINT "reward_location_caps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reward_location_caps_location_id_idx" ON "reward_location_caps"("location_id");
ALTER TABLE "reward_location_caps" ADD CONSTRAINT "reward_location_caps_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "reward_calculations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "transaction_id" UUID,
    "customer_id" UUID,
    "eligible_amount" DECIMAL(10,2) NOT NULL,
    "combined_percentage" DECIMAL(5,2),
    "percentage_subtotal" DECIMAL(10,2),
    "effective_multiplier" DECIMAL(4,2),
    "multiplied_subtotal" DECIMAL(10,2),
    "flat_bonus_total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "pre_cap_total" DECIMAL(10,2) NOT NULL,
    "applied_caps" JSONB,
    "final_reward_amount" DECIMAL(10,2) NOT NULL,
    "calculation_trace" JSONB NOT NULL,
    "applied_rule_ids" JSONB NOT NULL,
    "is_simulation" BOOLEAN NOT NULL DEFAULT false,
    "superseded_by_correction_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reward_calculations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reward_calculations_organization_id_idx" ON "reward_calculations"("organization_id");
CREATE INDEX "reward_calculations_transaction_id_idx" ON "reward_calculations"("transaction_id");
CREATE INDEX "reward_calculations_customer_id_idx" ON "reward_calculations"("customer_id");
ALTER TABLE "reward_calculations" ADD CONSTRAINT "reward_calculations_transaction_id_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reward_calculations" ADD CONSTRAINT "reward_calculations_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "reward_challenge_progress" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reward_rule_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "progress_count" INTEGER NOT NULL DEFAULT 0,
    "window_started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "reward_calculation_id" UUID,
    CONSTRAINT "reward_challenge_progress_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reward_challenge_progress_reward_rule_id_customer_id_idx" ON "reward_challenge_progress"("reward_rule_id", "customer_id");
ALTER TABLE "reward_challenge_progress" ADD CONSTRAINT "reward_challenge_progress_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
