-- ============================================================================
-- Migration: points_redemption_rates
-- Extends Module 3 (Wallet & Credit) with a variable exchange-rate model
-- and a minimum-redemption-balance threshold — the "250 points = €10 on
-- weekdays, €5 on weekends" points system.
--
-- Depends on: 20260815000000_wallet_credit (credit_rules)
-- ============================================================================

ALTER TABLE "credit_rules" ADD COLUMN "minimum_redemption_balance" DECIMAL(10,2);

CREATE TABLE "redemption_rate_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "name" TEXT NOT NULL,
    "applies_on_days" JSONB NOT NULL,
    "points_per_euro" DECIMAL(10,4) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "redemption_rate_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "redemption_rate_rules_organization_id_is_active_idx" ON "redemption_rate_rules"("organization_id", "is_active");
ALTER TABLE "redemption_rate_rules" ADD CONSTRAINT "redemption_rate_rules_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
