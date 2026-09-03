// Ons interne veld -> lijst met veelvoorkomende exportkolomnamen die
// automatisch worden herkend (case-insensitief, spaties/underscores
// genegeerd). De beheerder kan de voorgestelde mapping altijd nog
// handmatig aanpassen — dit is alleen een startpunt, geen garantie.
const FIELD_ALIASES: Record<string, string[]> = {
  first_name: ['firstname', 'first name', 'voornaam'],
  last_name: ['lastname', 'last name', 'achternaam', 'surname'],
  full_name: ['fullname', 'full name', 'naam', 'name'],
  email: ['email', 'e-mail', 'emailaddress', 'email address', 'mail'],
  phone: ['phone', 'phonenumber', 'phone number', 'telefoon', 'telefoonnummer', 'mobile', 'mobiel'],
  date_of_birth: ['dateofbirth', 'date of birth', 'dob', 'geboortedatum', 'birthdate'],
  external_customer_id: ['customerid', 'customer id', 'memberid', 'member id', 'piggyid', 'piggy id', 'externalid', 'id'],
  created_at: ['createdat', 'created at', 'registrationdate', 'registratiedatum', 'signupdate', 'joindate'],
  language: ['language', 'taal', 'locale'],
  points_balance: ['points', 'punten', 'punt', 'pointsbalance', 'points balance', 'balance', 'saldo', 'puntensaldo', 'currentpoints', 'current points'],
  lifetime_earned: ['lifetimeearned', 'lifetime earned', 'totalearned', 'total earned', 'totaalgespaard', 'gespaard'],
  lifetime_redeemed: ['lifetimeredeemed', 'lifetime redeemed', 'totalredeemed', 'total redeemed', 'totaalbesteed', 'besteed'],
  tier: ['tier', 'status', 'level', 'niveau'],
  tags: ['tags', 'labels'],
};

export const IMPORT_FIELDS = Object.keys(FIELD_ALIASES);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

/**
 * Given the raw column headers from the uploaded file, suggests a
 * best-guess mapping to our internal fields. Never applied automatically
 * without confirmation — the wizard always shows this as an editable
 * proposal (section 2 of the spec: "De beheerder moet de mapping altijd
 * kunnen aanpassen").
 */
export function suggestColumnMapping(columns: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const usedColumns = new Set<string>();

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const match = columns.find((col) => !usedColumns.has(col) && aliases.includes(normalize(col)));
    if (match) {
      mapping[field] = match;
      usedColumns.add(match);
    }
  }

  return mapping;
}
