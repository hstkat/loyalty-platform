/**
 * Centrale lijst van alle bestaande permissiestrings, met leesbare
 * Nederlandse labels en een groepering per module — gebruikt door zowel
 * het medewerkersbeheer-endpoint (om de catalogus aan de UI te geven)
 * als de validatie bij het aanmaken/wijzigen van een medewerker (een
 * admin kan nooit een permissie toekennen die niet in deze lijst staat).
 */
export interface PermissionCatalogEntry {
  key: string;
  label: string;
  group: string;
}

export const PERMISSION_CATALOG: PermissionCatalogEntry[] = [
  { key: 'customer.read', label: 'Klanten bekijken', group: 'Klanten' },
  { key: 'customer.write', label: 'Klanten aanmaken/wijzigen', group: 'Klanten' },
  { key: 'customer.merge', label: 'Klanten samenvoegen', group: 'Klanten' },

  { key: 'transaction.read', label: 'Transacties bekijken', group: 'Transacties' },
  { key: 'transaction.write', label: 'Transacties boeken', group: 'Transacties' },

  { key: 'wallet.read', label: 'Tegoed bekijken', group: 'Tegoed & punten' },
  { key: 'wallet.write', label: 'Tegoed aanpassen', group: 'Tegoed & punten' },
  { key: 'credit_rules.read', label: 'Spaarregels bekijken', group: 'Tegoed & punten' },
  { key: 'credit_rules.write', label: 'Spaarregels wijzigen', group: 'Tegoed & punten' },
  { key: 'reward_rules.read', label: 'Beloningsregels bekijken', group: 'Tegoed & punten' },
  { key: 'reward_rules.write', label: 'Beloningsregels wijzigen', group: 'Tegoed & punten' },

  { key: 'gift_card.read', label: 'Cadeaukaarten bekijken', group: 'Cadeaukaarten' },
  { key: 'gift_card.write', label: 'Cadeaukaarten uitgeven/inwisselen', group: 'Cadeaukaarten' },

  { key: 'loyalty_card.read', label: 'Spaarkaarten bekijken', group: 'Spaarkaarten' },
  { key: 'loyalty_card.write', label: 'Spaarkaarten uitgeven/blokkeren', group: 'Spaarkaarten' },

  { key: 'campaign.read', label: 'Campagnes bekijken', group: 'Campagnes' },
  { key: 'campaign.write', label: 'Campagnes aanmaken/starten', group: 'Campagnes' },

  { key: 'analytics.read', label: 'Analytics & rapportages bekijken', group: 'Analytics' },
  { key: 'ai_assistant.use', label: 'AI-assistent gebruiken', group: 'Analytics' },

  { key: 'import.read', label: 'Import-geschiedenis bekijken', group: 'Import' },
  { key: 'import.write', label: 'Klanten importeren', group: 'Import' },

  { key: 'messaging.read', label: 'Berichten bekijken', group: 'Communicatie' },
  { key: 'messaging.write', label: 'Berichten versturen', group: 'Communicatie' },
  { key: 'journeys.read', label: "Journeys bekijken", group: 'Communicatie' },
  { key: 'journeys.write', label: "Journeys aanmaken", group: 'Communicatie' },

  { key: 'occupancy.read', label: 'Bezetting bekijken', group: 'Reserveringen' },
  { key: 'occupancy.write', label: 'Bezetting beheren', group: 'Reserveringen' },

  { key: 'tags.read', label: 'Labels bekijken', group: 'Instellingen' },
  { key: 'tags.write', label: 'Labels beheren', group: 'Instellingen' },
  { key: 'custom_fields.read', label: 'Eigen velden bekijken', group: 'Instellingen' },
  { key: 'custom_fields.write', label: 'Eigen velden beheren', group: 'Instellingen' },
  { key: 'pos_connections.read', label: 'Kassakoppelingen bekijken', group: 'Instellingen' },
  { key: 'pos_connections.write', label: 'Kassakoppelingen beheren', group: 'Instellingen' },

  { key: 'admin.read', label: 'Instellingen & auditlog bekijken', group: 'Beheer' },
  { key: 'admin.write', label: 'Medewerkers en instellingen beheren', group: 'Beheer' },
];

export const VALID_PERMISSION_KEYS = new Set(PERMISSION_CATALOG.map((p) => p.key));
