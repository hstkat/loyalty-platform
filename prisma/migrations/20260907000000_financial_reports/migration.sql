-- ============================================================================
-- Migration: financial_reports
-- Bewaart alleen rapportPARAMETERS (nooit berekende bedragen of bestanden
-- zelf) — elk rapport wordt bij het opnieuw opvragen vers uit de bestaande
-- ledgers herberekend. Zie schema-commentaar bij FinancialReportHistory.
-- ============================================================================

CREATE TABLE "financial_report_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "report_type" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "location_id" UUID,
    "format" TEXT NOT NULL,
    "generated_by_staff_id" UUID,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_report_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "financial_report_history_organization_id_generated_at_idx" ON "financial_report_history"("organization_id", "generated_at");
