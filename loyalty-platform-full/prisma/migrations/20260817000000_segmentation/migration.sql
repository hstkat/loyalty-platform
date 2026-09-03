-- ============================================================================
-- Migration: segmentation
-- Module 7: Segmentation Engine
--
-- Depends on: 20260813000000_init_customer_crm (organizations, customers)
--
-- This migration REPLACES the forward-looking "segments" /
-- "customer_segment_memberships" stub tables that were created in
-- 20260813000000_init_customer_crm with the real Module 7 implementation.
-- The stub was never used to store real data (no application code wrote to
-- it), so a drop-and-recreate is safe here rather than a data migration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Drop the Module 1 forward-looking stub
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS "customer_segment_memberships";
DROP TABLE IF EXISTS "segments";

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

CREATE TYPE "SegmentType" AS ENUM ('standard', 'custom');
CREATE TYPE "EvaluationMode" AS ENUM ('realtime', 'cached');
CREATE TYPE "RefreshFrequency" AS ENUM ('realtime', 'hourly', 'daily');

-- ----------------------------------------------------------------------------
-- segments
-- ----------------------------------------------------------------------------

CREATE TABLE "segments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "segment_type" "SegmentType" NOT NULL,
    "definition" JSONB NOT NULL,
    "evaluation_mode" "EvaluationMode" NOT NULL,
    "refresh_frequency" "RefreshFrequency",
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "last_computed_at" TIMESTAMP(3),
    "last_computed_count" INTEGER,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "segments_organization_id_segment_type_idx" ON "segments"("organization_id", "segment_type");

-- ----------------------------------------------------------------------------
-- segment_membership
-- ----------------------------------------------------------------------------

CREATE TABLE "segment_membership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "segment_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "matched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "segment_membership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "segment_membership_segment_id_customer_id_key" ON "segment_membership"("segment_id", "customer_id");
CREATE INDEX "segment_membership_customer_id_idx" ON "segment_membership"("customer_id");
ALTER TABLE "segment_membership" ADD CONSTRAINT "segment_membership_segment_id_fkey"
    FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "segment_membership" ADD CONSTRAINT "segment_membership_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- churn_risk_scores
-- ----------------------------------------------------------------------------

CREATE TABLE "churn_risk_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "risk_ratio" DECIMAL(6,2) NOT NULL,
    "churn_risk_score" INTEGER NOT NULL,
    "is_at_risk" BOOLEAN NOT NULL DEFAULT false,
    "based_on_personal_cadence" BOOLEAN NOT NULL DEFAULT true,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "churn_risk_scores_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "churn_risk_scores_customer_id_key" ON "churn_risk_scores"("customer_id");
CREATE INDEX "churn_risk_scores_organization_id_is_at_risk_idx" ON "churn_risk_scores"("organization_id", "is_at_risk");
ALTER TABLE "churn_risk_scores" ADD CONSTRAINT "churn_risk_scores_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
