-- ============================================================================
-- Migration: voucher_module
-- Nieuwe, volledig APARTE voucher-module — bewust GEEN samenvoeging met
-- wallet_ledger_entries (Beach Credit/punten) of gift_cards
-- (cadeaukaartsaldo). Zie schema-commentaar bij VoucherTemplate/
-- CustomerVoucher voor de architecturale onderbouwing.
-- ============================================================================

CREATE TABLE "voucher_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_url" TEXT,
    "benefit" TEXT NOT NULL,
    "terms" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "validity_days" INTEGER,
    "valid_from" TIMESTAMP(3),
    "valid_until" TIMESTAMP(3),
    "location_ids" UUID[] NOT NULL DEFAULT '{}',
    "reminder_days_before_expiry" INTEGER[] NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voucher_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "voucher_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE INDEX "voucher_templates_organization_id_is_active_idx" ON "voucher_templates"("organization_id", "is_active");

CREATE TABLE "customer_vouchers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "voucher_template_id" UUID NOT NULL,
    "campaign_id" UUID,
    "journey_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemed_at" TIMESTAMP(3),
    "transaction_id" UUID,
    "location_id" UUID,
    "redeemed_by_staff_id" UUID,
    "issue_reason" TEXT,
    "issue_source" TEXT NOT NULL DEFAULT 'manual',
    "reminders_sent_days" INTEGER[] NOT NULL DEFAULT '{}',
    "secure_token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_vouchers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_vouchers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "customer_vouchers_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE,
    CONSTRAINT "customer_vouchers_voucher_template_id_fkey" FOREIGN KEY ("voucher_template_id") REFERENCES "voucher_templates"("id")
);

CREATE UNIQUE INDEX "customer_vouchers_secure_token_hash_key" ON "customer_vouchers"("secure_token_hash");
CREATE INDEX "customer_vouchers_organization_id_customer_id_idx" ON "customer_vouchers"("organization_id", "customer_id");
CREATE INDEX "customer_vouchers_organization_id_status_idx" ON "customer_vouchers"("organization_id", "status");
CREATE INDEX "customer_vouchers_voucher_template_id_idx" ON "customer_vouchers"("voucher_template_id");
