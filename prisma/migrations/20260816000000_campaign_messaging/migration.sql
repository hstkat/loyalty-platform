-- ============================================================================
-- Migration: campaign_messaging
-- Module 5: Campaign Manager
-- Module 6: Messaging
--
-- Depends on: 20260813000000_init_customer_crm (organizations, locations, customers)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums — Module 5
-- ----------------------------------------------------------------------------

CREATE TYPE "CampaignGoal" AS ENUM (
  'meer_bezoekers', 'lunch_vullen', 'slapende_gasten_activeren',
  'credit_laten_inwisselen', 'omzet_verhogen', 'vip_event_vullen'
);
CREATE TYPE "CampaignStatus" AS ENUM (
  'draft', 'pending_approval', 'scheduled', 'active', 'paused', 'completed', 'cancelled', 'archived'
);
CREATE TYPE "IncentiveType" AS ENUM ('flat_bonus', 'multiplier', 'percentage_bonus', 'coupon', 'none');
CREATE TYPE "ScheduleType" AS ENUM ('direct', 'datetime', 'period', 'recurring');
CREATE TYPE "RecipientChannel" AS ENUM ('push', 'wallet', 'email', 'sms');
CREATE TYPE "RecipientStatus" AS ENUM ('queued', 'delivered', 'opened', 'clicked', 'failed');

-- ----------------------------------------------------------------------------
-- Enums — Module 6
-- ----------------------------------------------------------------------------

CREATE TYPE "MessageChannel" AS ENUM ('push', 'wallet', 'email', 'sms', 'whatsapp');
CREATE TYPE "MessageCategory" AS ENUM ('transactional', 'marketing');
CREATE TYPE "ProviderStatus" AS ENUM ('active', 'paused', 'error');
CREATE TYPE "SendRequestSourceType" AS ENUM ('campaign', 'journey', 'system');
CREATE TYPE "QueueItemStatus" AS ENUM (
  'pending', 'ready_to_send', 'sending', 'sent', 'delivered', 'bounced', 'failed',
  'skipped_no_consent', 'skipped_frequency_cap', 'skipped_no_channel', 'delayed_quiet_hours'
);
CREATE TYPE "MessageEventType" AS ENUM ('delivered', 'opened', 'clicked', 'bounced', 'unsubscribed');
CREATE TYPE "PushPlatform" AS ENUM ('ios', 'android', 'web');

-- ----------------------------------------------------------------------------
-- campaign_templates
-- ----------------------------------------------------------------------------

CREATE TABLE "campaign_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "default_goal" "CampaignGoal" NOT NULL,
    "default_audience_filter" JSONB,
    "default_incentive_type" "IncentiveType" NOT NULL,
    "default_incentive_value" JSONB,
    "default_channels" JSONB,
    "default_schedule_type" "ScheduleType" NOT NULL,
    "suggested_budget_limits" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "campaign_templates_pkey" PRIMARY KEY ("id")
);

-- ----------------------------------------------------------------------------
-- campaigns
-- ----------------------------------------------------------------------------

CREATE TABLE "campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "template_id" UUID,
    "name" TEXT NOT NULL,
    "goal" "CampaignGoal" NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "audience_filter" JSONB,
    "incentive_type" "IncentiveType" NOT NULL DEFAULT 'none',
    "incentive_value" JSONB,
    "reward_rule_id" UUID,
    "channels" JSONB NOT NULL DEFAULT '[]',
    "schedule_type" "ScheduleType" NOT NULL DEFAULT 'direct',
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "recurrence_rule" TEXT,
    "max_recipients" INTEGER,
    "max_reward_exposure" DECIMAL(10,2),
    "max_redemption_cost" DECIMAL(10,2),
    "max_incentive_per_customer" INTEGER NOT NULL DEFAULT 1,
    "current_reward_exposure" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "current_redemption_cost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "control_group_percentage" DECIMAL(5,2),
    "created_by_user_id" UUID,
    "approved_by_user_id" UUID,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "campaigns_organization_id_status_idx" ON "campaigns"("organization_id", "status");

-- ----------------------------------------------------------------------------
-- campaign_audience_snapshot
-- ----------------------------------------------------------------------------

CREATE TABLE "campaign_audience_snapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "run_number" INTEGER NOT NULL,
    "customer_id" UUID NOT NULL,
    "matched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "in_control_group" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "campaign_audience_snapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "campaign_audience_snapshot_campaign_id_run_number_idx" ON "campaign_audience_snapshot"("campaign_id", "run_number");
ALTER TABLE "campaign_audience_snapshot" ADD CONSTRAINT "campaign_audience_snapshot_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_audience_snapshot" ADD CONSTRAINT "campaign_audience_snapshot_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- campaign_recipients
-- ----------------------------------------------------------------------------

CREATE TABLE "campaign_recipients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "run_number" INTEGER NOT NULL,
    "channel" "RecipientChannel" NOT NULL,
    "status" "RecipientStatus" NOT NULL DEFAULT 'queued',
    "queued_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "clicked_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "campaign_recipients_campaign_id_status_idx" ON "campaign_recipients"("campaign_id", "status");
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- campaign_metrics_snapshots
-- ----------------------------------------------------------------------------

CREATE TABLE "campaign_metrics_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "snapshot_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "opens" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "reservations" INTEGER NOT NULL DEFAULT 0,
    "visits" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "average_check" DECIMAL(10,2),
    "reward_issued" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "reward_redeemed" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "incremental_revenue" DECIMAL(10,2),
    "estimated_roi" DECIMAL(6,2),
    CONSTRAINT "campaign_metrics_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "campaign_metrics_snapshots_campaign_id_snapshot_at_idx" ON "campaign_metrics_snapshots"("campaign_id", "snapshot_at");
ALTER TABLE "campaign_metrics_snapshots" ADD CONSTRAINT "campaign_metrics_snapshots_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- message_providers
-- ----------------------------------------------------------------------------

CREATE TABLE "message_providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "provider_name" TEXT NOT NULL,
    "credentials_ref" TEXT,
    "status" "ProviderStatus" NOT NULL DEFAULT 'active',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "message_providers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "message_providers_organization_id_channel_idx" ON "message_providers"("organization_id", "channel");

-- ----------------------------------------------------------------------------
-- message_templates
-- ----------------------------------------------------------------------------

CREATE TABLE "message_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID,
    "template_group_key" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "category" "MessageCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'nl',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "message_templates_organization_id_template_group_key_idx" ON "message_templates"("organization_id", "template_group_key");

-- ----------------------------------------------------------------------------
-- message_send_requests
-- ----------------------------------------------------------------------------

CREATE TABLE "message_send_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "source_type" "SendRequestSourceType" NOT NULL,
    "source_id" UUID,
    "template_group_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_send_requests_pkey" PRIMARY KEY ("id")
);

-- ----------------------------------------------------------------------------
-- message_queue_items
-- ----------------------------------------------------------------------------

CREATE TABLE "message_queue_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "send_request_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "location_id" UUID,
    "channel" "MessageChannel" NOT NULL,
    "template_id" UUID NOT NULL,
    "rendered_subject" TEXT,
    "rendered_body" TEXT NOT NULL,
    "status" "QueueItemStatus" NOT NULL DEFAULT 'pending',
    "provider_id" UUID,
    "provider_message_id" TEXT,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "message_queue_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "message_queue_items_organization_id_status_idx" ON "message_queue_items"("organization_id", "status");
CREATE INDEX "message_queue_items_customer_id_channel_idx" ON "message_queue_items"("customer_id", "channel");
ALTER TABLE "message_queue_items" ADD CONSTRAINT "message_queue_items_send_request_id_fkey"
    FOREIGN KEY ("send_request_id") REFERENCES "message_send_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message_queue_items" ADD CONSTRAINT "message_queue_items_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message_queue_items" ADD CONSTRAINT "message_queue_items_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "message_queue_items" ADD CONSTRAINT "message_queue_items_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "message_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- message_events
-- ----------------------------------------------------------------------------

CREATE TABLE "message_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "queue_item_id" UUID NOT NULL,
    "event_type" "MessageEventType" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    CONSTRAINT "message_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "message_events_queue_item_id_idx" ON "message_events"("queue_item_id");
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_queue_item_id_fkey"
    FOREIGN KEY ("queue_item_id") REFERENCES "message_queue_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- message_links
-- ----------------------------------------------------------------------------

CREATE TABLE "message_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "queue_item_id" UUID NOT NULL,
    "original_url" TEXT NOT NULL,
    "click_count" INTEGER NOT NULL DEFAULT 0,
    "first_clicked_at" TIMESTAMP(3),
    CONSTRAINT "message_links_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "message_links_queue_item_id_idx" ON "message_links"("queue_item_id");
ALTER TABLE "message_links" ADD CONSTRAINT "message_links_queue_item_id_fkey"
    FOREIGN KEY ("queue_item_id") REFERENCES "message_queue_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- customer_push_tokens
-- ----------------------------------------------------------------------------

CREATE TABLE "customer_push_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_push_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_push_tokens_customer_id_token_key" ON "customer_push_tokens"("customer_id", "token");
ALTER TABLE "customer_push_tokens" ADD CONSTRAINT "customer_push_tokens_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- message_frequency_caps
-- ----------------------------------------------------------------------------

CREATE TABLE "message_frequency_caps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "category" "MessageCategory" NOT NULL,
    "max_messages" INTEGER NOT NULL,
    "period_days" INTEGER NOT NULL,
    CONSTRAINT "message_frequency_caps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "message_frequency_caps_organization_id_channel_idx" ON "message_frequency_caps"("organization_id", "channel");

-- ----------------------------------------------------------------------------
-- customer_message_send_log
-- ----------------------------------------------------------------------------

CREATE TABLE "customer_message_send_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "category" "MessageCategory" NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_message_send_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "customer_message_send_log_customer_id_channel_category_sen_idx"
    ON "customer_message_send_log"("customer_id", "channel", "category", "sent_at");
ALTER TABLE "customer_message_send_log" ADD CONSTRAINT "customer_message_send_log_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- brand_voice_profiles
-- ----------------------------------------------------------------------------

CREATE TABLE "brand_voice_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "tone_description" TEXT,
    "example_messages" JSONB,
    CONSTRAINT "brand_voice_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "brand_voice_profiles_organization_id_key" ON "brand_voice_profiles"("organization_id");

-- ----------------------------------------------------------------------------
-- ai_copy_requests
-- ----------------------------------------------------------------------------

CREATE TABLE "ai_copy_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "requested_by_user_id" UUID,
    "prompt_text" TEXT NOT NULL,
    "generated_variants" JSONB NOT NULL,
    "chosen_variant_index" INTEGER,
    "final_edited_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_copy_requests_pkey" PRIMARY KEY ("id")
);
