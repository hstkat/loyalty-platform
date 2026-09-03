-- ============================================================================
-- Migration: catalog_item_value
-- Adds a required euro_value to reward_catalog_items — the actual
-- cost/worth of a gift (e.g. "Gebakje bij de koffie" costs the business
-- €2.50), independent of its points_cost. Needed for the daily
-- accounting closing report to reflect the real financial impact of
-- gift redemptions, not just an abstract points deduction.
--
-- Depends on: 20260822000000_reward_catalog (reward_catalog_items)
-- ============================================================================

ALTER TABLE "reward_catalog_items" ADD COLUMN "euro_value" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "reward_catalog_items" ALTER COLUMN "euro_value" DROP DEFAULT;
