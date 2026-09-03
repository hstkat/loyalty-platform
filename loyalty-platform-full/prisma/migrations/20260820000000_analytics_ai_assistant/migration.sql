-- ============================================================================
-- Migration: analytics_ai_assistant
-- Module 10: Analytics & AI Campaign Assistant
--
-- Depends on: 20260813000000_init_customer_crm (organizations, locations)
--             20260816000000_campaign_messaging (IncentiveType enum)
--             20260819000000_reservations_occupancy (RecommendationStatus enum)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

CREATE TYPE "AnalyticsPeriodType" AS ENUM ('daily', 'monthly');
CREATE TYPE "AiMessageRole" AS ENUM ('user', 'assistant');
CREATE TYPE "InsightSeverity" AS ENUM ('info', 'attention', 'warning');

-- ----------------------------------------------------------------------------
-- analytics_snapshots
-- ----------------------------------------------------------------------------

CREATE TABLE "analytics_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "snapshot_date" DATE NOT NULL,
    "period_type" "AnalyticsPeriodType" NOT NULL,
    "member_count" INTEGER NOT NULL,
    "new_members_in_period" INTEGER NOT NULL,
    "loyalty_revenue" DECIMAL(10,2) NOT NULL,
    "average_spend" DECIMAL(10,2),
    "repeat_visit_rate" DECIMAL(5,2),
    "outstanding_credit" DECIMAL(10,2) NOT NULL,
    "credit_expiring_soon" DECIMAL(10,2) NOT NULL,
    "at_risk_count" INTEGER NOT NULL,
    "vip_count" INTEGER NOT NULL,
    "credit_issued" DECIMAL(10,2) NOT NULL,
    "credit_redeemed" DECIMAL(10,2) NOT NULL,
    "credit_expired" DECIMAL(10,2) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "analytics_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "analytics_snapshots_org_loc_period_date_idx"
    ON "analytics_snapshots"("organization_id", "location_id", "period_type", "snapshot_date");

-- ----------------------------------------------------------------------------
-- cohort_retention_snapshots
-- ----------------------------------------------------------------------------

CREATE TABLE "cohort_retention_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "cohort_month" DATE NOT NULL,
    "months_since_cohort" INTEGER NOT NULL,
    "cohort_size" INTEGER NOT NULL,
    "active_count" INTEGER NOT NULL,
    "retention_percentage" DECIMAL(5,2) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cohort_retention_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cohort_retention_snapshots_organization_id_cohort_month_idx"
    ON "cohort_retention_snapshots"("organization_id", "cohort_month");

-- ----------------------------------------------------------------------------
-- ai_assistant_conversations
-- ----------------------------------------------------------------------------

CREATE TABLE "ai_assistant_conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_assistant_conversations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_assistant_conversations_organization_id_idx" ON "ai_assistant_conversations"("organization_id");

-- ----------------------------------------------------------------------------
-- ai_assistant_messages
-- ----------------------------------------------------------------------------

CREATE TABLE "ai_assistant_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_assistant_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_assistant_messages_conversation_id_idx" ON "ai_assistant_messages"("conversation_id");
ALTER TABLE "ai_assistant_messages" ADD CONSTRAINT "ai_assistant_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "ai_assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- ai_tool_calls
-- ----------------------------------------------------------------------------

CREATE TABLE "ai_tool_calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "parameters" JSONB,
    "result" JSONB,
    "called_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_tool_calls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_tool_calls_message_id_idx" ON "ai_tool_calls"("message_id");
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "ai_assistant_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- ai_campaign_suggestions
-- ----------------------------------------------------------------------------

CREATE TABLE "ai_campaign_suggestions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID,
    "suggested_name" TEXT NOT NULL,
    "audience_filter" JSONB NOT NULL,
    "audience_count" INTEGER NOT NULL,
    "incentive_type" "IncentiveType" NOT NULL,
    "incentive_value" JSONB,
    "suggested_message" TEXT NOT NULL,
    "estimated_max_exposure" DECIMAL(10,2) NOT NULL,
    "underlying_data_snapshot" JSONB,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'pending_approval',
    "reviewed_by_user_id" UUID,
    "resulting_campaign_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_campaign_suggestions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_campaign_suggestions_organization_id_status_idx" ON "ai_campaign_suggestions"("organization_id", "status");
ALTER TABLE "ai_campaign_suggestions" ADD CONSTRAINT "ai_campaign_suggestions_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "ai_assistant_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- proactive_insights
-- ----------------------------------------------------------------------------

CREATE TABLE "proactive_insights" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "insight_type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "underlying_data_snapshot" JSONB,
    "severity" "InsightSeverity" NOT NULL DEFAULT 'info',
    "dismissed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "proactive_insights_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "proactive_insights_organization_id_dismissed_at_idx" ON "proactive_insights"("organization_id", "dismissed_at");
