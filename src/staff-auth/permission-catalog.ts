/**
 * Centrale lijst van alle bestaande permissiestrings, met leesbare
 * Nederlandse labels en een groepering per module — gebruikt door zowel
 * het medewerkersbeheer-endpoint (om de catalogus aan de UI te geven)
 * als de validatie bij het aanmaken/wijzigen van een medewerker (een
 * admin kan nooit een permissie toekennen die niet in deze lijst staat).
 *
 * BELANGRIJK: deze lijst is 1-op-1 overgenomen uit de daadwerkelijke
 * @RequirePermissions(...)-strings verspreid door de controllers (zie
 * `grep -rhn "@RequirePermissions" src` voor de brontabel). Eerdere
 * versie van dit bestand had een aantal VERZONNEN/verkeerd gespelde
 * keys (tags.read, occupancy.write, messaging.write, reward_rules.write,
 * enz.) die nergens in de code voorkwamen — een medewerker met alleen
 * die permissies kon dan feitelijk niets. Wijzig deze lijst dus alleen
 * in lockstep met de echte @RequirePermissions-aanroepen.
 */
export interface PermissionCatalogEntry {
  key: string;
  label: string;
  group: string;
}

export const PERMISSION_CATALOG: PermissionCatalogEntry[] = [
  { key: 'customer.read', label: 'Klanten bekijken', group: 'Klanten' },
  { key: 'customer.write', label: 'Klanten aanmaken/wijzigen (incl. labels & eigen velden)', group: 'Klanten' },
  { key: 'customer.merge', label: 'Klanten samenvoegen', group: 'Klanten' },
  { key: 'customer.notes.read', label: 'Interne notities bij klant bekijken', group: 'Klanten' },
  { key: 'customer.notes.write', label: 'Interne notities bij klant toevoegen', group: 'Klanten' },
  { key: 'customer.export', label: 'Klantgegevens exporteren (AVG)', group: 'Klanten' },
  { key: 'customer.anonymize', label: 'Klantgegevens anonimiseren/verwijderen (AVG)', group: 'Klanten' },
  { key: 'consent.write', label: 'Toestemmingen (marketing e.d.) wijzigen', group: 'Klanten' },

  { key: 'transaction.read', label: 'Transacties bekijken', group: 'Transacties' },
  { key: 'transaction.write', label: 'Transacties boeken (incl. kassakoppelingen)', group: 'Transacties' },
  { key: 'transaction.correct', label: 'Transacties corrigeren', group: 'Transacties' },
  { key: 'transaction.void', label: 'Transacties annuleren', group: 'Transacties' },

  { key: 'wallet.read', label: 'Tegoed bekijken', group: 'Tegoed & punten' },
  { key: 'wallet.redeem', label: 'Tegoed inwisselen bij de kassa', group: 'Tegoed & punten' },
  { key: 'wallet.adjust', label: 'Tegoed handmatig corrigeren', group: 'Tegoed & punten' },
  { key: 'credit_rules.read', label: 'Spaarregels bekijken', group: 'Tegoed & punten' },
  { key: 'credit_rules.write', label: 'Spaarregels wijzigen', group: 'Tegoed & punten' },
  { key: 'reward_rule.read', label: 'Beloningsregels bekijken', group: 'Tegoed & punten' },
  { key: 'reward_rule.write', label: 'Beloningsregels wijzigen', group: 'Tegoed & punten' },
  { key: 'reward_calculation.read', label: 'Beloningsberekeningen bekijken', group: 'Tegoed & punten' },

  { key: 'gift_card.read', label: 'Cadeaukaarten bekijken', group: 'Cadeaukaarten' },
  { key: 'gift_card.write', label: 'Cadeaukaarten uitgeven/beheren', group: 'Cadeaukaarten' },
  { key: 'gift_card.redeem', label: 'Cadeaukaarten inwisselen bij de kassa', group: 'Cadeaukaarten' },

  { key: 'loyalty_card.read', label: 'Spaarkaarten bekijken', group: 'Spaarkaarten' },
  { key: 'loyalty_card.write', label: 'Spaarkaarten uitgeven/blokkeren', group: 'Spaarkaarten' },

  { key: 'voucher.read', label: 'Vouchers bekijken', group: 'Vouchers' },
  { key: 'voucher.write', label: 'Vouchers uitgeven/intrekken/templates beheren', group: 'Vouchers' },
  { key: 'voucher.redeem', label: 'Vouchers inwisselen bij de kassa', group: 'Vouchers' },

  { key: 'campaign.read', label: 'Campagnes bekijken', group: 'Campagnes' },
  { key: 'campaign.write', label: 'Campagnes aanmaken', group: 'Campagnes' },
  { key: 'campaign.launch', label: 'Campagnes starten', group: 'Campagnes' },
  { key: 'segment.read', label: 'Doelgroepen bekijken', group: 'Campagnes' },
  { key: 'segment.write', label: 'Doelgroepen beheren', group: 'Campagnes' },
  { key: 'journey.read', label: 'Journeys bekijken', group: 'Campagnes' },
  { key: 'journey.write', label: 'Journeys aanmaken', group: 'Campagnes' },
  { key: 'journey.publish', label: 'Journeys publiceren', group: 'Campagnes' },
  { key: 'journey.pause', label: 'Journeys pauzeren', group: 'Campagnes' },
  { key: 'journey.stop', label: 'Journeys stopzetten', group: 'Campagnes' },

  { key: 'message.read', label: 'Berichten bekijken', group: 'Communicatie' },
  { key: 'message.send', label: 'Berichten versturen', group: 'Communicatie' },
  { key: 'message.template.read', label: 'Berichtsjablonen bekijken', group: 'Communicatie' },
  { key: 'message.template.write', label: 'Berichtsjablonen beheren', group: 'Communicatie' },

  { key: 'reservation.read', label: 'Bezetting/reserveringen bekijken', group: 'Reserveringen' },
  { key: 'reservation.write', label: 'Bezetting/reserveringen beheren', group: 'Reserveringen' },

  { key: 'analytics.read', label: 'Analytics & rapportages bekijken', group: 'Analytics' },
  { key: 'ai_assistant.use', label: 'AI-assistent gebruiken', group: 'Analytics' },
  { key: 'ai_campaign_suggestion.approve', label: 'AI-campagnevoorstellen goedkeuren', group: 'Analytics' },

  { key: 'import.read', label: 'Import-geschiedenis bekijken', group: 'Import' },
  { key: 'import.write', label: 'Klanten importeren', group: 'Import' },

  { key: 'admin.read', label: 'Instellingen & auditlog bekijken', group: 'Beheer' },
  { key: 'admin.write', label: 'Medewerkers en instellingen beheren', group: 'Beheer' },
];

export const VALID_PERMISSION_KEYS = new Set(PERMISSION_CATALOG.map((p) => p.key));
