-- ============================================================================
-- Migration: wallet_reservations_table
-- Vervangt de in-process JavaScript Map die WalletService gebruikte voor
-- redemption-reserveringen (reserve -> confirm/cancel) door een echte
-- tabel. Vercel's serverless functies delen geen geheugen tussen
-- aanroepen/instances, dus de oude Map kon een actieve reservering
-- "verliezen" of een idempotencyKey niet herkennen als een retry op een
-- andere instance belandde.
-- ============================================================================

CREATE TABLE "wallet_redemption_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "locked_entry_ids" UUID[] NOT NULL,
    "transaction_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_redemption_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_redemption_reservations_organization_id_idempotency_key_key"
    ON "wallet_redemption_reservations"("organization_id", "idempotency_key");

CREATE INDEX "wallet_redemption_reservations_organization_id_status_idx"
    ON "wallet_redemption_reservations"("organization_id", "status");
