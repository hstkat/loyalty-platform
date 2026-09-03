-- ============================================================================
-- Migration: reservations_occupancy
-- Module 9: Reservations & Occupancy Booster
--
-- Depends on: 20260813000000_init_customer_crm (organizations, locations, customers)
--             20260816000000_campaign_messaging (IncentiveType enum)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

CREATE TYPE "ServicePeriod" AS ENUM ('lunch', 'dinner', 'all_day');
CREATE TYPE "ReservationStatus" AS ENUM ('confirmed', 'cancelled', 'no_show', 'seated', 'completed');
CREATE TYPE "OpportunityStatus" AS ENUM ('detected', 'recommendation_created', 'dismissed', 'expired');
CREATE TYPE "RecommendationStatus" AS ENUM ('pending_approval', 'approved', 'dismissed', 'expired');

-- ----------------------------------------------------------------------------
-- location_capacity_settings
-- ----------------------------------------------------------------------------

CREATE TABLE "location_capacity_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "location_id" UUID NOT NULL,
    "area" TEXT,
    "service_period" "ServicePeriod" NOT NULL,
    "max_covers" INTEGER NOT NULL,
    CONSTRAINT "location_capacity_settings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "location_capacity_settings_location_id_idx" ON "location_capacity_settings"("location_id");
ALTER TABLE "location_capacity_settings" ADD CONSTRAINT "location_capacity_settings_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- reservation_connections
-- ----------------------------------------------------------------------------

CREATE TABLE "reservation_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reservation_connections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reservation_connections_organization_id_idx" ON "reservation_connections"("organization_id");
ALTER TABLE "reservation_connections" ADD CONSTRAINT "reservation_connections_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- reservations
-- ----------------------------------------------------------------------------

CREATE TABLE "reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "reservation_connection_id" UUID,
    "external_reservation_id" TEXT,
    "customer_id" UUID,
    "date_time" TIMESTAMP(3) NOT NULL,
    "service_period" "ServicePeriod" NOT NULL,
    "covers" INTEGER NOT NULL,
    "table_reference" TEXT,
    "area" TEXT,
    "status" "ReservationStatus" NOT NULL DEFAULT 'confirmed',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reservations_organization_id_idx" ON "reservations"("organization_id");
CREATE INDEX "reservations_location_id_date_time_idx" ON "reservations"("location_id", "date_time");
CREATE INDEX "reservations_customer_id_idx" ON "reservations"("customer_id");
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_reservation_connection_id_fkey"
    FOREIGN KEY ("reservation_connection_id") REFERENCES "reservation_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- weather_forecasts
-- ----------------------------------------------------------------------------

CREATE TABLE "weather_forecasts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "location_id" UUID NOT NULL,
    "forecast_date" DATE NOT NULL,
    "temperature_celsius" DECIMAL(4,1) NOT NULL,
    "condition" TEXT NOT NULL,
    "precipitation_chance" DECIMAL(5,2),
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "weather_forecasts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "weather_forecasts_location_id_forecast_date_idx" ON "weather_forecasts"("location_id", "forecast_date");
ALTER TABLE "weather_forecasts" ADD CONSTRAINT "weather_forecasts_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- forecast_runs
-- ----------------------------------------------------------------------------

CREATE TABLE "forecast_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "location_id" UUID NOT NULL,
    "forecast_date" DATE NOT NULL,
    "service_period" "ServicePeriod" NOT NULL,
    "area" TEXT,
    "model_version" TEXT NOT NULL,
    "forecast_occupancy_percentage" DECIMAL(5,2) NOT NULL,
    "factors_used" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "forecast_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "forecast_runs_location_id_forecast_date_idx" ON "forecast_runs"("location_id", "forecast_date");
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- occupancy_opportunities
-- ----------------------------------------------------------------------------

CREATE TABLE "occupancy_opportunities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "opportunity_date" DATE NOT NULL,
    "service_period" "ServicePeriod" NOT NULL,
    "area" TEXT,
    "forecast_run_id" UUID NOT NULL,
    "forecast_occupancy_percentage" DECIMAL(5,2) NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'detected',
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "occupancy_opportunities_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "occupancy_opportunities_organization_id_idx" ON "occupancy_opportunities"("organization_id");
CREATE INDEX "occupancy_opportunities_location_id_opportunity_date_idx" ON "occupancy_opportunities"("location_id", "opportunity_date");
ALTER TABLE "occupancy_opportunities" ADD CONSTRAINT "occupancy_opportunities_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "occupancy_opportunities" ADD CONSTRAINT "occupancy_opportunities_forecast_run_id_fkey"
    FOREIGN KEY ("forecast_run_id") REFERENCES "forecast_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- occupancy_recommendations
-- ----------------------------------------------------------------------------

CREATE TABLE "occupancy_recommendations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "opportunity_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "suggested_name" TEXT NOT NULL,
    "audience_filter" JSONB NOT NULL,
    "audience_count" INTEGER NOT NULL,
    "incentive_type" "IncentiveType" NOT NULL,
    "incentive_value" JSONB,
    "suggested_message" TEXT NOT NULL,
    "estimated_max_reward_exposure" DECIMAL(10,2) NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'pending_approval',
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "resulting_campaign_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "occupancy_recommendations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "occupancy_recommendations_organization_id_status_idx" ON "occupancy_recommendations"("organization_id", "status");
ALTER TABLE "occupancy_recommendations" ADD CONSTRAINT "occupancy_recommendations_opportunity_id_fkey"
    FOREIGN KEY ("opportunity_id") REFERENCES "occupancy_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- occupancy_attribution_results
-- ----------------------------------------------------------------------------

CREATE TABLE "occupancy_attribution_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "opportunity_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "forecast_occupancy_percentage" DECIMAL(5,2) NOT NULL,
    "actual_occupancy_percentage" DECIMAL(5,2) NOT NULL,
    "occupancy_uplift" DECIMAL(5,2) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "occupancy_attribution_results_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "occupancy_attribution_results_opportunity_id_idx" ON "occupancy_attribution_results"("opportunity_id");
ALTER TABLE "occupancy_attribution_results" ADD CONSTRAINT "occupancy_attribution_results_opportunity_id_fkey"
    FOREIGN KEY ("opportunity_id") REFERENCES "occupancy_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
