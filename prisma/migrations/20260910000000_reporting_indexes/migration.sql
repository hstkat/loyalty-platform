-- ============================================================================
-- Migration: reporting_indexes
-- De financiële rapportagemodule (en andere admin-schermen) filteren
-- deze twee grote ledger-tabellen zwaar op organizationId + een
-- datumbereik. gift_card_ledger_entries had daar helemaal geen index
-- voor (alleen giftCardId+occurredAt) — elke rapportagequery deed dus
-- een volledige tabel-scan. wallet_ledger_entries had alleen een losse
-- index op organizationId; de bestaande wordt hier vervangen door een
-- samengestelde variant (die de losse-kolom-use-case ook gewoon blijft
-- dekken via prefix-matching, dus geen functieverlies).
-- ============================================================================

CREATE INDEX "gift_card_ledger_entries_organization_id_occurred_at_idx" ON "gift_card_ledger_entries"("organization_id", "occurred_at");

DROP INDEX IF EXISTS "wallet_ledger_entries_organization_id_idx";
CREATE INDEX "wallet_ledger_entries_organization_id_occurred_at_idx" ON "wallet_ledger_entries"("organization_id", "occurred_at");
