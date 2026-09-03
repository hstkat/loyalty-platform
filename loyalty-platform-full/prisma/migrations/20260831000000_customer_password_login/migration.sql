-- ============================================================================
-- Migration: customer_password_login
-- Adds an OPTIONAL password login for the "Mijn Tegoed" customer portal,
-- alongside (never replacing) the existing e-mail-code login. A customer
-- who never sets a password keeps using the code flow unchanged.
--
-- Only a bcrypt hash is ever stored, never the password itself.
--
-- Depends on: 20260830000000_customer_portal
-- ============================================================================

ALTER TABLE "customers" ADD COLUMN "password_hash" TEXT;
ALTER TABLE "customers" ADD COLUMN "password_failed_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "customers" ADD COLUMN "password_locked_until" TIMESTAMP(3);
