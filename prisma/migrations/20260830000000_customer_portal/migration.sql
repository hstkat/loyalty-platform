-- ============================================================================
-- Migration: customer_portal
-- Adds what's needed for the branded "Mijn Tegoed" customer portal:
--   - Location.slug, to distinguish Het Strand / Zomers branding on one
--     shared centralized portal
--   - CustomerQrToken, a deliberately SEPARATE, short-lived token system
--     from the physical LoyaltyCard tokens — a portal QR must be
--     re-displayable on every login, which the "raw token only exists
--     once, at creation" physical-card model doesn't support. Scoped to
--     identification only, never full account access.
--
-- Depends on: 20260813000000_init_customer_crm (customers, locations)
-- ============================================================================

ALTER TABLE "locations" ADD COLUMN "slug" TEXT;
CREATE UNIQUE INDEX "locations_slug_key" ON "locations"("slug");

CREATE TABLE "customer_qr_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_qr_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_qr_tokens_token_hash_key" ON "customer_qr_tokens"("token_hash");
CREATE INDEX "customer_qr_tokens_customer_id_idx" ON "customer_qr_tokens"("customer_id");
ALTER TABLE "customer_qr_tokens" ADD CONSTRAINT "customer_qr_tokens_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "guest_registration_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guest_registration_codes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "guest_registration_codes_organization_id_email_idx" ON "guest_registration_codes"("organization_id", "email");
