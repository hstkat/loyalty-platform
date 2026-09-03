-- ============================================================================
-- Migration: guest_push_tokens
-- Stores Expo push tokens per guest device, so the platform can send real
-- push notifications (campaigns, journeys) to the guest app — not just
-- the simulated push records Module 6 has used until now.
--
-- Depends on: 20260813000000_init_customer_crm (customers)
-- ============================================================================

CREATE TABLE "guest_push_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "expo_push_token" TEXT NOT NULL,
    "device_info" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "guest_push_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guest_push_tokens_expo_push_token_key" ON "guest_push_tokens"("expo_push_token");
CREATE INDEX "guest_push_tokens_customer_id_idx" ON "guest_push_tokens"("customer_id");
ALTER TABLE "guest_push_tokens" ADD CONSTRAINT "guest_push_tokens_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
