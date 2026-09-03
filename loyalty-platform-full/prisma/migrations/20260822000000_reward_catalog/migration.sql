-- ============================================================================
-- Migration: reward_catalog
-- Extends Module 3 (Wallet & Credit) with:
--   1. A configurable fixed redemption block size (e.g. 250 points at a
--      time, instead of an arbitrary euro-derived amount).
--   2. A rewards catalog: fixed items redeemable for a fixed point cost
--      (e.g. "Gebakje bij de koffie — 100 punten").
--
-- Depends on: 20260821000000_points_redemption_rates (credit_rules)
-- ============================================================================

ALTER TABLE "credit_rules" ADD COLUMN "redemption_block_size" INTEGER;

CREATE TABLE "reward_catalog_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "points_cost" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reward_catalog_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reward_catalog_items_organization_id_is_active_idx" ON "reward_catalog_items"("organization_id", "is_active");
ALTER TABLE "reward_catalog_items" ADD CONSTRAINT "reward_catalog_items_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
