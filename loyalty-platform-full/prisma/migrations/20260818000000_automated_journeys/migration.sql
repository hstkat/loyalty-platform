-- ============================================================================
-- Migration: automated_journeys
-- Module 8: Automated Journeys
--
-- Depends on: 20260813000000_init_customer_crm (organizations, customers)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

CREATE TYPE "JourneyStatus" AS ENUM ('draft', 'published', 'paused', 'stopped');
CREATE TYPE "ReEnrollmentPolicy" AS ENUM ('once_ever', 'once_per_completion', 'always');
CREATE TYPE "JourneyTriggerType" AS ENUM ('event', 'scheduled_date');
CREATE TYPE "JourneyNodeType" AS ENUM (
  'trigger', 'wait', 'condition', 'segment_condition', 'send_push', 'send_email',
  'send_sms', 'add_credit', 'give_reward', 'add_tag', 'change_tier', 'webhook',
  'split_test', 'end'
);
CREATE TYPE "EnrollmentStatus" AS ENUM (
  'enrolled', 'executing', 'waiting', 'completed', 'goal_reached', 'exited', 'error'
);
CREATE TYPE "NodeExecutionStatus" AS ENUM ('success', 'failed', 'retrying');

-- ----------------------------------------------------------------------------
-- journeys
-- ----------------------------------------------------------------------------

CREATE TABLE "journeys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_standard" BOOLEAN NOT NULL DEFAULT false,
    "status" "JourneyStatus" NOT NULL DEFAULT 'draft',
    "re_enrollment_policy" "ReEnrollmentPolicy" NOT NULL DEFAULT 'once_ever',
    "current_version_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "journeys_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journeys_organization_id_status_idx" ON "journeys"("organization_id", "status");

-- ----------------------------------------------------------------------------
-- journey_versions
-- ----------------------------------------------------------------------------

CREATE TABLE "journey_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "journey_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "trigger_type" "JourneyTriggerType" NOT NULL,
    "event_name" TEXT,
    "event_filter" JSONB,
    "date_field" TEXT,
    "date_offset_days" INTEGER,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journey_versions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journey_versions_journey_id_version_number_idx" ON "journey_versions"("journey_id", "version_number");
ALTER TABLE "journey_versions" ADD CONSTRAINT "journey_versions_journey_id_fkey"
    FOREIGN KEY ("journey_id") REFERENCES "journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- journey_nodes
-- ----------------------------------------------------------------------------

CREATE TABLE "journey_nodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "journey_version_id" UUID NOT NULL,
    "node_type" "JourneyNodeType" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "position_x" INTEGER NOT NULL DEFAULT 0,
    "position_y" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "journey_nodes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journey_nodes_journey_version_id_idx" ON "journey_nodes"("journey_version_id");
ALTER TABLE "journey_nodes" ADD CONSTRAINT "journey_nodes_journey_version_id_fkey"
    FOREIGN KEY ("journey_version_id") REFERENCES "journey_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- journey_edges
-- ----------------------------------------------------------------------------

CREATE TABLE "journey_edges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "journey_version_id" UUID NOT NULL,
    "from_node_id" UUID NOT NULL,
    "to_node_id" UUID NOT NULL,
    "branch_label" TEXT,
    CONSTRAINT "journey_edges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journey_edges_journey_version_id_idx" ON "journey_edges"("journey_version_id");
ALTER TABLE "journey_edges" ADD CONSTRAINT "journey_edges_journey_version_id_fkey"
    FOREIGN KEY ("journey_version_id") REFERENCES "journey_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journey_edges" ADD CONSTRAINT "journey_edges_from_node_id_fkey"
    FOREIGN KEY ("from_node_id") REFERENCES "journey_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journey_edges" ADD CONSTRAINT "journey_edges_to_node_id_fkey"
    FOREIGN KEY ("to_node_id") REFERENCES "journey_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- journey_enrollments
-- ----------------------------------------------------------------------------

CREATE TABLE "journey_enrollments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "journey_id" UUID NOT NULL,
    "journey_version_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'enrolled',
    "current_node_id" UUID,
    "resume_at" TIMESTAMP(3),
    "split_test_branch" TEXT,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "exit_reason" TEXT,
    CONSTRAINT "journey_enrollments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journey_enrollments_journey_id_status_idx" ON "journey_enrollments"("journey_id", "status");
CREATE INDEX "journey_enrollments_status_resume_at_idx" ON "journey_enrollments"("status", "resume_at");
CREATE INDEX "journey_enrollments_customer_id_idx" ON "journey_enrollments"("customer_id");
ALTER TABLE "journey_enrollments" ADD CONSTRAINT "journey_enrollments_journey_id_fkey"
    FOREIGN KEY ("journey_id") REFERENCES "journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journey_enrollments" ADD CONSTRAINT "journey_enrollments_journey_version_id_fkey"
    FOREIGN KEY ("journey_version_id") REFERENCES "journey_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journey_enrollments" ADD CONSTRAINT "journey_enrollments_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- journey_node_executions
-- ----------------------------------------------------------------------------

CREATE TABLE "journey_node_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "enrollment_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "status" "NodeExecutionStatus" NOT NULL,
    "result" JSONB,
    "executed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journey_node_executions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journey_node_executions_enrollment_id_idx" ON "journey_node_executions"("enrollment_id");
CREATE INDEX "journey_node_executions_node_id_idx" ON "journey_node_executions"("node_id");
ALTER TABLE "journey_node_executions" ADD CONSTRAINT "journey_node_executions_enrollment_id_fkey"
    FOREIGN KEY ("enrollment_id") REFERENCES "journey_enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journey_node_executions" ADD CONSTRAINT "journey_node_executions_node_id_fkey"
    FOREIGN KEY ("node_id") REFERENCES "journey_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- journey_goals
-- ----------------------------------------------------------------------------

CREATE TABLE "journey_goals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "journey_id" UUID NOT NULL,
    "goal_event_name" TEXT NOT NULL,
    "goal_condition" JSONB,
    "within_days" INTEGER NOT NULL,
    CONSTRAINT "journey_goals_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "journey_goals" ADD CONSTRAINT "journey_goals_journey_id_fkey"
    FOREIGN KEY ("journey_id") REFERENCES "journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
