-- ============================================================================
-- Migration: staff_authentication
-- Vervangt de "auth-stub" (organizationId/permissions/actorId zomaar
-- overgenomen uit client-headers, zonder enige verificatie) door echte,
-- geverifieerde backoffice-accounts met wachtwoord + sessies.
--
-- KRITIEK: dit is een BLOKKERENDE beveiligingsfix (zie security-audit).
-- Zonder deze migratie kan elke bezoeker met de API-URL zichzelf via
-- headers elk rechtenniveau EN elke organisatie toe-eigenen.
-- ============================================================================

CREATE TABLE "staff_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "permissions" TEXT[] NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "staff_users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "staff_users_organization_id_email_key" ON "staff_users"("organization_id", "email");

CREATE TABLE "staff_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "staff_user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_info" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "staff_sessions_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "staff_sessions_token_hash_key" ON "staff_sessions"("token_hash");
CREATE INDEX "staff_sessions_staff_user_id_idx" ON "staff_sessions"("staff_user_id");
