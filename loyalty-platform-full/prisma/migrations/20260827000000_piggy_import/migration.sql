-- ============================================================================
-- Migration: piggy_import
-- Adds a generic customer/loyalty-balance import capability (built for
-- Piggy CSV/XLSX exports, but not Piggy-specific in structure), reusing
-- the existing customers + wallet_ledger_entries architecture rather
-- than introducing a parallel customer/balance model.
--
-- Depends on: 20260813000000_init_customer_crm (customers),
--             20260815000000_wallet_credit (wallet_ledger_entries)
-- ============================================================================

-- New ledger entry type for migrated balances (distinct from a normal
-- "earn", since it represents pre-existing history, not a fresh reward).
ALTER TYPE "WalletLedgerEntryType" ADD VALUE 'migration_import';

-- Import provenance on Customer — enables safe re-matching against the
-- same external system on a later import.
ALTER TABLE "customers" ADD COLUMN "external_id" TEXT;
ALTER TABLE "customers" ADD COLUMN "external_source" TEXT;
CREATE INDEX "customers_organization_id_external_source_external_id_idx" ON "customers"("organization_id", "external_source", "external_id");

CREATE TYPE "ImportJobStatus" AS ENUM ('parsed', 'previewed', 'processing', 'completed', 'failed', 'rolled_back');
CREATE TYPE "ImportRowAction" AS ENUM ('new_customer', 'matched_customer', 'review_required', 'invalid', 'skip', 'duplicate');

CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "source" TEXT NOT NULL DEFAULT 'piggy',
    "filename" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'parsed',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "success_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "review_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "column_mapping" JSONB,
    "conversion_type" TEXT,
    "conversion_rate" DECIMAL(10,4),
    "balance_mode" TEXT NOT NULL DEFAULT 'add',
    "total_source_balance" DECIMAL(14,2),
    "total_converted_credit" DECIMAL(14,2),
    "raw_rows" JSONB,
    "created_by_user_id" UUID,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "rolled_back_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "import_jobs_organization_id_created_at_idx" ON "import_jobs"("organization_id", "created_at");
CREATE INDEX "import_jobs_organization_id_file_hash_idx" ON "import_jobs"("organization_id", "file_hash");

CREATE TABLE "import_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "import_job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "row_hash" TEXT NOT NULL,
    "raw_data" JSONB NOT NULL,
    "action" "ImportRowAction" NOT NULL,
    "matched_customer_id" UUID,
    "source_balance" DECIMAL(14,2),
    "converted_credit" DECIMAL(14,2),
    "error_message" TEXT,
    "ledger_entry_id" UUID,
    "reversal_ledger_entry_id" UUID,
    "customer_created_by_import" BOOLEAN NOT NULL DEFAULT false,
    "committed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "import_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "import_records_import_job_id_row_hash_key" ON "import_records"("import_job_id", "row_hash");
CREATE INDEX "import_records_import_job_id_action_idx" ON "import_records"("import_job_id", "action");
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_import_job_id_fkey"
    FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
