-- ============================================================================
-- Migration: catalog_availability
-- Extends reward_catalog_items with optional day-of-week and date-range
-- availability restrictions (e.g. "koffie met gebak" only on Mon/Tue for
-- 4 weeks, or only on a single specific date like August 31st).
--
-- Depends on: 20260822000000_reward_catalog (reward_catalog_items)
-- ============================================================================

ALTER TABLE "reward_catalog_items" ADD COLUMN "available_days" JSONB;
ALTER TABLE "reward_catalog_items" ADD COLUMN "valid_from" DATE;
ALTER TABLE "reward_catalog_items" ADD COLUMN "valid_until" DATE;
