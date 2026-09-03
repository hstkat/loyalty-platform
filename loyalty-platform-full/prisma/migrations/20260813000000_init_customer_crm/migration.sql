-- ============================================================================
-- Migration: init_customer_crm
-- Module 1: Customer & CRM
--
-- Supabase has pgcrypto enabled by default (needed for gen_random_uuid()).
-- If you're running this against a fresh/self-hosted Postgres, uncomment:
-- CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

CREATE TYPE "LoyaltyStatus" AS ENUM ('active', 'inactive', 'blocked', 'merged');
CREATE TYPE "SourceChannel" AS ENUM ('pos', 'qr', 'website', 'reservation', 'wallet', 'manual', 'import');
CREATE TYPE "IdentityType" AS ENUM ('email', 'phone', 'qr_code', 'wallet_pass_id', 'pos_customer_ref', 'external_crm_id');
CREATE TYPE "ConsentType" AS ENUM ('marketing', 'email', 'sms', 'push', 'profiling', 'data_sharing_partners');
CREATE TYPE "ConsentSource" AS ENUM ('signup_form', 'pos_prompt', 'wallet_signup', 'website', 'import', 'manual_staff', 'api');
CREATE TYPE "ConsentAction" AS ENUM ('granted', 'revoked');
CREATE TYPE "TimelineEventType" AS ENUM (
  'account_created', 'profile_updated', 'visit', 'transaction',
  'credit_earned', 'credit_redeemed', 'credit_expired', 'credit_manual_adjustment',
  'reward_granted', 'reward_used',
  'reservation_created', 'reservation_completed', 'reservation_no_show',
  'push_sent', 'push_opened', 'email_sent', 'email_opened', 'sms_sent',
  'campaign_targeted', 'coupon_issued', 'coupon_redeemed',
  'manual_change', 'cs_note_added', 'consent_changed', 'merge_performed',
  'segment_entered', 'segment_left'
);
CREATE TYPE "NoteType" AS ENUM ('general', 'complaint', 'preference', 'allergy', 'vip_flag');
CREATE TYPE "NoteVisibility" AS ENUM ('organization', 'location_only');
CREATE TYPE "CustomFieldType" AS ENUM ('text', 'number', 'boolean', 'date', 'select');
CREATE TYPE "MergeType" AS ENUM ('automatic', 'manual');
CREATE TYPE "AuditAction" AS ENUM ('create', 'update', 'delete', 'merge', 'anonymize', 'export');
CREATE TYPE "ActorType" AS ENUM ('staff', 'system', 'api_key', 'customer_self_service');

-- ----------------------------------------------------------------------------
-- Tenancy
-- ----------------------------------------------------------------------------

CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

CREATE TABLE "locations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "locations_organization_id_idx" ON "locations"("organization_id");
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Forward-looking stub for the future tier system
CREATE TABLE "loyalty_tiers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_tiers_pkey" PRIMARY KEY ("id")
);

-- ----------------------------------------------------------------------------
-- Core customer profile
-- ----------------------------------------------------------------------------

CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "date_of_birth" DATE,
    "language" TEXT NOT NULL DEFAULT 'nl',
    "loyalty_status" "LoyaltyStatus" NOT NULL DEFAULT 'active',
    "tier_id" UUID,
    "current_balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lifetime_earned" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lifetime_redeemed" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "visit_count" INTEGER NOT NULL DEFAULT 0,
    "lifetime_spend" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "average_spend" DECIMAL(10,2),
    "first_visit_at" TIMESTAMP(3),
    "last_visit_at" TIMESTAMP(3),
    "average_visit_frequency_days" INTEGER,
    "favorite_location_id" UUID,
    "favorite_visit_day" TEXT,
    "favorite_visit_time_window" TEXT,
    "favorite_party_size" INTEGER,
    "interests" JSONB NOT NULL DEFAULT '[]',
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "source_channel" "SourceChannel" NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "customers_organization_id_idx" ON "customers"("organization_id");
CREATE INDEX "customers_organization_id_email_idx" ON "customers"("organization_id", "email");
CREATE INDEX "customers_organization_id_phone_idx" ON "customers"("organization_id", "phone");
CREATE INDEX "customers_organization_id_loyalty_status_idx" ON "customers"("organization_id", "loyalty_status");

ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_tier_id_fkey"
    FOREIGN KEY ("tier_id") REFERENCES "loyalty_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_favorite_location_id_fkey"
    FOREIGN KEY ("favorite_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- Identity resolution
-- ----------------------------------------------------------------------------

CREATE TABLE "customer_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "identity_type" "IdentityType" NOT NULL,
    "identity_value" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "source" "SourceChannel" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_identities_pkey" PRIMARY KEY ("id")
);
-- Core anti-duplicate rule: one identity value can only belong to one customer per org.
CREATE UNIQUE INDEX "customer_identities_org_type_value_key"
    ON "customer_identities"("organization_id", "identity_type", "identity_value");
CREATE INDEX "customer_identities_customer_id_idx" ON "customer_identities"("customer_id");
ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- Per-location statistics
-- ----------------------------------------------------------------------------

CREATE TABLE "customer_locations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "visit_count" INTEGER NOT NULL DEFAULT 0,
    "spend_total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "first_visit_at" TIMESTAMP(3),
    "last_visit_at" TIMESTAMP(3),
    CONSTRAINT "customer_locations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_locations_customer_id_location_id_key"
    ON "customer_locations"("customer_id", "location_id");
CREATE INDEX "customer_locations_location_id_idx" ON "customer_locations"("location_id");
ALTER TABLE "customer_locations" ADD CONSTRAINT "customer_locations_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_locations" ADD CONSTRAINT "customer_locations_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- Consent / AVG
-- ----------------------------------------------------------------------------

CREATE TABLE "customer_consents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "consent_type" "ConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "granted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "source" "ConsentSource" NOT NULL,
    "privacy_policy_version" TEXT NOT NULL,
    "ip_address" TEXT,
    CONSTRAINT "customer_consents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_consents_customer_id_consent_type_key"
    ON "customer_consents"("customer_id", "consent_type");
ALTER TABLE "customer_consents" ADD CONSTRAINT "customer_consents_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "customer_consent_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "consent_type" "ConsentType" NOT NULL,
    "action" "ConsentAction" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "ConsentSource" NOT NULL,
    "privacy_policy_version" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    CONSTRAINT "customer_consent_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "customer_consent_history_customer_id_consent_type_idx"
    ON "customer_consent_history"("customer_id", "consent_type");
ALTER TABLE "customer_consent_history" ADD CONSTRAINT "customer_consent_history_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- Timeline
-- ----------------------------------------------------------------------------

CREATE TABLE "customer_timeline_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID,
    "event_type" "TimelineEventType" NOT NULL,
    "event_source_module" TEXT NOT NULL,
    "event_source_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_timeline_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "customer_timeline_events_customer_id_occurred_at_idx"
    ON "customer_timeline_events"("customer_id", "occurred_at");
CREATE INDEX "customer_timeline_events_organization_id_event_type_idx"
    ON "customer_timeline_events"("organization_id", "event_type");
ALTER TABLE "customer_timeline_events" ADD CONSTRAINT "customer_timeline_events_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_timeline_events" ADD CONSTRAINT "customer_timeline_events_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- Notes
-- ----------------------------------------------------------------------------

CREATE TABLE "customer_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "note_type" "NoteType" NOT NULL DEFAULT 'general',
    "content" TEXT NOT NULL,
    "visibility" "NoteVisibility" NOT NULL DEFAULT 'organization',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "customer_notes_customer_id_idx" ON "customer_notes"("customer_id");
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- Tags
-- ----------------------------------------------------------------------------

CREATE TABLE "customer_tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#64748B',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_tags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_tags_organization_id_label_key" ON "customer_tags"("organization_id", "label");
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "customer_tag_map" (
    "customer_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_tag_map_pkey" PRIMARY KEY ("customer_id", "tag_id")
);
ALTER TABLE "customer_tag_map" ADD CONSTRAINT "customer_tag_map_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_tag_map" ADD CONSTRAINT "customer_tag_map_tag_id_fkey"
    FOREIGN KEY ("tag_id") REFERENCES "customer_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- Custom fields
-- ----------------------------------------------------------------------------

CREATE TABLE "customer_custom_fields" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "field_key" TEXT NOT NULL,
    "field_label" TEXT NOT NULL,
    "field_type" "CustomFieldType" NOT NULL,
    "options" JSONB,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_custom_fields_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_custom_fields_organization_id_field_key_key"
    ON "customer_custom_fields"("organization_id", "field_key");
ALTER TABLE "customer_custom_fields" ADD CONSTRAINT "customer_custom_fields_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "customer_custom_field_values" (
    "customer_id" UUID NOT NULL,
    "custom_field_id" UUID NOT NULL,
    "value" JSONB NOT NULL,
    CONSTRAINT "customer_custom_field_values_pkey" PRIMARY KEY ("customer_id", "custom_field_id")
);
ALTER TABLE "customer_custom_field_values" ADD CONSTRAINT "customer_custom_field_values_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_custom_field_values" ADD CONSTRAINT "customer_custom_field_values_custom_field_id_fkey"
    FOREIGN KEY ("custom_field_id") REFERENCES "customer_custom_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- Merge log
-- ----------------------------------------------------------------------------

CREATE TABLE "customer_merge_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "surviving_customer_id" UUID NOT NULL,
    "merged_customer_id" UUID NOT NULL,
    "merged_fields_snapshot" JSONB NOT NULL,
    "match_score" DECIMAL(5,4) NOT NULL,
    "merge_type" "MergeType" NOT NULL,
    "performed_by" UUID,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_merge_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "customer_merge_log_surviving_customer_id_idx" ON "customer_merge_log"("surviving_customer_id");
CREATE INDEX "customer_merge_log_merged_customer_id_idx" ON "customer_merge_log"("merged_customer_id");
ALTER TABLE "customer_merge_log" ADD CONSTRAINT "customer_merge_log_surviving_customer_id_fkey"
    FOREIGN KEY ("surviving_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_merge_log" ADD CONSTRAINT "customer_merge_log_merged_customer_id_fkey"
    FOREIGN KEY ("merged_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- Segmentation (forward-looking stub — full engine is Module 7)
-- ----------------------------------------------------------------------------

CREATE TABLE "segments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_segment_memberships" (
    "customer_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_segment_memberships_pkey" PRIMARY KEY ("customer_id", "segment_id")
);
ALTER TABLE "customer_segment_memberships" ADD CONSTRAINT "customer_segment_memberships_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_segment_memberships" ADD CONSTRAINT "customer_segment_memberships_segment_id_fkey"
    FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- Audit log (shared infrastructure across all modules)
-- ----------------------------------------------------------------------------

CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "before_state" JSONB,
    "after_state" JSONB,
    "reason" TEXT,
    "ip_address" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_log_organization_id_entity_type_entity_id_idx"
    ON "audit_log"("organization_id", "entity_type", "entity_id");
CREATE INDEX "audit_log_organization_id_timestamp_idx" ON "audit_log"("organization_id", "timestamp");
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
