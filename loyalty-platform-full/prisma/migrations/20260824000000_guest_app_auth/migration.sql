-- ============================================================================
-- Migration: guest_app_auth
-- Adds passwordless, email-code-based authentication for the guest-facing
-- mobile app — separate from the internal staff-header-based auth the
-- backoffice uses. Needed because a public app cannot rely on the
-- backoffice's "trusted staff on an internal tool" header pattern.
--
-- Depends on: 20260813000000_init_customer_crm (customers)
-- ============================================================================

CREATE TABLE "guest_login_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guest_login_codes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "guest_login_codes_customer_id_idx" ON "guest_login_codes"("customer_id");
ALTER TABLE "guest_login_codes" ADD CONSTRAINT "guest_login_codes_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "guest_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_info" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guest_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guest_sessions_token_hash_key" ON "guest_sessions"("token_hash");
CREATE INDEX "guest_sessions_customer_id_idx" ON "guest_sessions"("customer_id");
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
