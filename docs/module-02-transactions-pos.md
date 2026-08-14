# Module 2 — Transactions & POS

> Onderdeel van het horeca/hospitality loyaltyplatform. Bouwt voort op Module 1 (Customer & CRM). Deze module is de databron die `visit_count`, `lifetime_spend`, `favoriteLocationId` en de bezoekmomenten op het klantprofiel daadwerkelijk gaat vullen, en levert de brongegevens waarop Module 4 (Reward Engine) straks Beach Credit gaat berekenen.

**Scope-afbakening voor deze fase:** een daadwerkelijke koppeling met een kassasysteem (Lightspeed, Untill, Zettle, etc.) wordt hier **niet** gebouwd. In plaats daarvan ontwerpen we de module API-first en kanaal-onafhankelijk: transacties kunnen nu handmatig (via een simpel scherm) of via een generieke API worden ingevoerd. Zodra een concrete kassakoppeling nodig is, is dat een kwestie van een nieuwe integratie die tegen dezelfde `POST /transactions`-endpoint praat — er hoeft niets aan het datamodel te veranderen.

---

## 1. Functionele beschrijving

De Transactions-module registreert elke financiële interactie tussen een gast en een locatie: een rekening, de samenstelling ervan, en de koppeling naar de gast (indien bekend). Dit is de "grondwaarheid" van omzet binnen het platform.

Kernverantwoordelijkheden:

1. **Transacties vastleggen** — bedrag, locatie, tijdstip, regel-items, betaalmethode, gekoppelde gast (optioneel).
2. **Identity resolution aanroepen** — bij het invoeren van een transactie wordt Module 1's `resolve-identity`-endpoint gebruikt om te bepalen welke klant het betreft (of een nieuwe aan te maken).
3. **Events publiceren** — zodat Module 1 (CRM-cache), Module 4 (Reward Engine) en Module 10 (Analytics) kunnen reageren op nieuwe omzet.
4. **Correcties en annuleringen ondersteunen** — rekeningen worden soms achteraf aangepast (fooien, split-bills, terugboekingen); dat moet traceerbaar zijn, niet destructief.
5. **Basis leggen voor bezettingsgraad** — transactietijdstippen per locatie voeden later de yield-management-functionaliteit (Module 9).

Deze module berekent zelf **geen** Beach Credit (dat is Module 4) en beheert **geen** saldo (dat is Module 3) — ze levert alleen de brongegevens waarop die modules reageren via events.

---

## 2. Schermen

**Manager/staff-omgeving (handmatige invoer, MVP zonder POS-koppeling):**

1. **Nieuwe transactie invoeren** — eenvoudig formulier: locatie (vooringevuld als medewerker aan één locatie hangt), bedrag, gast (zoeken via `resolve-identity` of "geen lid"), betaalmethode, optioneel regel-items
2. **Transactieoverzicht per locatie** — lijst, filterbaar op datum/medewerker/gast/status
3. **Transactiedetail** — volledige weergave inclusief regel-items, gekoppelde gast, correctiehistorie
4. **Correctie/annulering-scherm** — reden verplicht, alleen door managers

**Admin (organisatiebreed):**

5. **Omzetoverzicht** — geaggregeerd per locatie/periode (basis voor Analytics-module, hier alleen de brondata)
6. **Integratie-instellingen** — placeholder-scherm waar later een POS-koppeling geconfigureerd kan worden (API-key genereren, webhook-URL tonen) — nu leeg/uitgeschakeld, maar het datamodel en de endpoint bestaan al

---

## 3. UX-flow

**Handmatige transactie-invoer (huidige MVP-flow, geen kassa nodig):**

```
Medewerker klikt "Nieuwe transactie"
        │
        ▼
Voert bedrag in (verplicht) + locatie
(vooringevuld indien 1 locatie)
        │
        ▼
Gast koppelen?
        │
   ┌────┴─────┐
  Ja          Nee
   │            │
   ▼            ▼
Zoek via      Transactie
telefoon/     zonder
naam/QR       customer_id
(resolve-     (anoniem,
identity)     telt niet mee
   │          voor loyalty)
   ▼
Match
gevonden?
   │
┌──┴──┐
Ja   Nee
│      │
▼      ▼
Koppel  "Nieuwe klant
transactie  aanmaken?"
aan bestaand  (optioneel,
profiel       via Module 1)
   │              │
   └──────┬───────┘
          ▼
   Transactie opslaan
          │
          ▼
   Event gepubliceerd:
   transaction.completed
          │
          ▼
   Module 1 werkt cache bij
   (visit_count, lifetime_spend,
   last_visit_at, favoriete
   locatie/moment)
          │
          ▼
   Module 4 berekent Beach
   Credit (indien van
   toepassing) — aparte flow
```

**Correctie-flow (transactie achteraf aanpassen):**

```
Manager opent transactiedetail
        │
        ▼
Klikt "Corrigeren"
(nooit direct bewerken —
zie business rule #1)
        │
        ▼
Voert nieuw bedrag/reden in
        │
        ▼
Systeem maakt nieuwe
transaction_correction-rij
(origineel blijft ongewijzigd
bewaard)
        │
        ▼
Event: transaction.corrected
        │
        ▼
Module 1 en Module 4 herberekenen
afgeleide velden/reward op basis
van het gecorrigeerde bedrag
```

**Ontwerpprincipes:**
- Handmatige invoer moet **net zo snel** zijn als straks een kassa-koppeling: bedrag intypen, gast koppelen (of niet), opslaan — 3 stappen, geen overbodige velden verplicht.
- Regel-items (line items) zijn **optioneel** in deze fase — een simpel totaalbedrag is voldoende om Beach Credit te berekenen. Regel-items worden pas relevant zodra productcategorieën een rol gaan spelen in reward-uitsluitingen (Module 4, "uitgesloten producten").

---

## 4. Database schema (overzicht)

```
organizations
    │
    └── locations
            │
            └── transactions ──────────────┐
                    │                       │
                    ├── transaction_line_items
                    ├── transaction_corrections
                    └── (customer_id → verwijst naar Module 1's customers)
```

Ontwerpkeuze: `transactions` hoort bij een `location`, niet direct bij een `organization` — omzet is per definitie locatie-gebonden (een rekening wordt op één plek afgerekend), terwijl de klant organisatiebreed is (Module 1). Dat sluit aan bij het multi-location-principe uit de basisarchitectuur.

---

## 5. Belangrijkste tabellen en velden

### `transactions`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organization_id` | UUID (FK) | Denormalized t.b.v. query-snelheid (locatie hoort al bij organisatie, maar veel queries filteren organisatiebreed) |
| `location_id` | UUID (FK) | |
| `customer_id` | UUID, nullable (FK naar Module 1 `customers`) | `null` = anonieme/niet-gekoppelde transactie |
| `amount` | decimal(10,2) | Totaalbedrag van de rekening |
| `currency` | varchar(3) | default `EUR`, vooruitgedacht voor internationale uitbreiding |
| `payment_method` | enum | `cash`, `card`, `ideal`, `other` |
| `status` | enum | `completed`, `voided` |
| `source` | enum | `manual`, `pos`, `api`, `import` — **nu altijd `manual`**, klaar voor later |
| `source_reference` | varchar, nullable | vrij veld voor een extern kassa-bonnummer, zodra dat relevant wordt |
| `entered_by_user_id` | UUID, nullable | medewerker die de transactie invoerde (bij `source = manual`) |
| `occurred_at` | timestamp | wanneer de rekening plaatsvond (kan afwijken van `created_at` bij late invoer) |
| `created_at` | timestamp | |

> **Ontwerpkeuze — `source`-veld nu al aanwezig, ongebruikt buiten `manual`:** dit is precies de "vooruitdenken zonder over-engineeren"-afspraak uit de basisprincipes. We bouwen geen POS-koppeling, maar sluiten hem ook niet uit — het veld kost nu niets, en voorkomt een breaking migration zodra een kassasysteem wordt aangesloten.

### `transaction_line_items`

Optioneel te vullen — zie UX-sectie. Belangrijk voor toekomstige reward-uitsluitingen per product.

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `transaction_id` | UUID (FK) | |
| `description` | varchar | vrije tekst, bv. "Cocktail Aperol Spritz" |
| `category` | varchar, nullable | vrij veld, later koppelbaar aan reward-uitsluitingsregels (Module 4) |
| `quantity` | integer | |
| `unit_price` | decimal(10,2) | |
| `line_total` | decimal(10,2) | |

### `transaction_corrections`

Append-only — een correctie overschrijft nooit de oorspronkelijke transactie (zie business rule #1).

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `transaction_id` | UUID (FK) | |
| `previous_amount` | decimal(10,2) | |
| `new_amount` | decimal(10,2) | |
| `reason` | text | verplicht |
| `performed_by_user_id` | UUID | |
| `created_at` | timestamp | |

Bij annulering (`status = voided`) wordt eveneens een correctie-rij aangemaakt met `new_amount = 0` en de reden, in plaats van de transactie te verwijderen.

---

## 6. Relaties

- `locations 1—N transactions`
- `customers (Module 1) 1—N transactions` (optioneel, `customer_id` mag `null` zijn)
- `transactions 1—N transaction_line_items`
- `transactions 1—N transaction_corrections`

---

## 7. Business rules

1. **Transacties zijn nooit direct te bewerken, alleen te corrigeren.** Elke wijziging aan het bedrag na het opslaan verloopt via `transaction_corrections` — dit is essentieel voor financiële auditeerbaarheid (fiscale bewaarplicht, zie ook Module 1's AVG-sectie over transactiedata).
2. **Alleen `completed`-transacties tellen mee voor loyalty.** Een `voided`-transactie wordt uitgesloten van `visit_count`/`lifetime_spend`-herberekening.
3. **Een transactie zonder gekoppelde klant (`customer_id = null`) genereert geen Beach Credit** en telt niet mee in het klantprofiel — dit is bewust: niet elke rekening hoort bij een lid.
4. **`occurred_at` mag afwijken van `created_at`** — bijvoorbeeld bij einde-dienst-invoer van meerdere rekeningen tegelijk. Reward-berekeningen (Module 4) gebruiken `occurred_at` als referentiepunt, niet `created_at`.
5. **Koppeling aan een klant kan achteraf** — een aanvankelijk anonieme transactie mag later alsnog aan een `customer_id` gekoppeld worden (bijvoorbeeld: gast belt achteraf om te vragen of de rekening nog gekoppeld kan worden). Dit triggert alsnog de volledige cache-herberekening in Module 1 en de reward-berekening in Module 4.
6. **`amount` moet positief zijn.** Terugboekingen/restituties verlopen via `transaction_corrections`, niet via een negatief bedrag in een nieuwe transactie.
7. **Regel-items zijn optioneel maar, indien aanwezig, moeten optellen tot het transactiebedrag** — validatie bij opslaan (met een kleine marge voor afronding/fooi, configureerbaar).
8. **`source` is alleen wijzigbaar bij het aanmaken, nooit achteraf** — het geeft aan hóe de transactie ontstond en is relevant voor audit/debugging, niet iets om achteraf te "herschrijven".

---

## 8. API endpoints

Basis: `/api/v1/organizations/{orgId}/locations/{locationId}/transactions`

| Methode | Endpoint | Omschrijving |
|---|---|---|
| `POST` | `/transactions` | Nieuwe transactie aanmaken. Body: `amount`, `customerId` (optioneel), `paymentMethod`, `occurredAt`, `lineItems` (optioneel) |
| `GET` | `/transactions` | Lijst, filterbaar op `customerId`, `status`, datumrange, `enteredByUserId` |
| `GET` | `/transactions/{id}` | Detail inclusief regel-items en correctiehistorie |
| `POST` | `/transactions/{id}/correct` | Correctie toevoegen. Body: `newAmount`, `reason` |
| `POST` | `/transactions/{id}/void` | Annuleren. Body: `reason` |
| `POST` | `/transactions/{id}/link-customer` | Achteraf koppelen aan een klant. Body: `customerId` |
| `GET` | `/organizations/{orgId}/transactions/summary` | Organisatiebrede omzet-aggregatie (basis voor Analytics) |

> Dit is bewust dezelfde soort endpoint die een toekomstige POS-integratie zou aanroepen — alleen is `source` dan `pos` in plaats van `manual`, en zou `sourceReference` het kassabonnummer bevatten. Er is geen apart "POS-endpoint" nodig.

---

## 9. Events

**Publiceert:**
- `transaction.completed` — payload: `transactionId`, `customerId` (indien aanwezig), `locationId`, `amount`, `occurredAt`
- `transaction.corrected` — payload: `transactionId`, `previousAmount`, `newAmount`, `reason`
- `transaction.voided` — payload: `transactionId`, `reason`
- `transaction.customer_linked` — payload: `transactionId`, `customerId` (voor de achteraf-koppel-flow)

**Consumeert:**
- Geen — deze module is de bron van waarheid voor omzet en luistert zelf niet naar andere modules' events.

**Wie luistert naar `transaction.completed`:**
- **Module 1 (Customer & CRM):** werkt `visit_count`, `lifetime_spend`, `average_spend`, `last_visit_at`, `favorite_location_id`, `favorite_visit_day/time_window` bij — precies de velden die in het Module 1-ontwerp als "denormalized cache, bijgewerkt via events" staan omschreven.
- **Module 4 (Reward Engine):** berekent Beach Credit op basis van `amount` × rewardpercentage (indien `customerId` aanwezig).
- **Module 9 (Reservations & Occupancy):** gebruikt `occurred_at` + `locationId` als datapunt voor bezettingsgraad-berekeningen.
- **Module 10 (Analytics):** voedt omzetrapportages.

---

## 10. Permissions

| Rol | Rechten |
|---|---|
| **Organization Admin** | Volledige CRUD, correcties, annuleringen, organisatiebrede rapportage |
| **Location Manager** | CRUD binnen eigen locatie, correcties/annuleringen binnen eigen locatie |
| **Staff (kassa/bediening)** | Alleen `POST /transactions` (nieuwe transactie invoeren) — géén correcties, géén annuleren, géén lijst van andere medewerkers' transacties inzien (afhankelijk van organisatie-instelling) |
| **API/Integration key** | Scoped tot `POST /transactions` — dit is exact het aanknopingspunt voor een toekomstige POS-koppeling, zonder dat er nu al een aparte rol voor hoeft te bestaan |

Permissie-primitieven (consistent met Module 1): `transaction.write`, `transaction.read`, `transaction.correct`, `transaction.void`.

---

## 11. Edge cases

1. **Transactie ingevoerd, maar gast wordt pas ná meerdere andere transacties als lid herkend** (bv. via een e-mail-actie "was dit toch jouw bezoek?") — de achteraf-koppel-flow (business rule #5) lost dit expliciet op, met terugwerkende kracht op de CRM-cache én rewardberekening.
2. **Twee medewerkers voeren gelijktijdig dezelfde rekening in** (dubbele invoer bij een storing) — geen automatische deduplicatie op transactieniveau (in tegenstelling tot Module 1's klant-identity); dit wordt een handmatige correctie/annulering door een manager. Reden: transactiebedragen zijn niet uniek te identificeren zoals een e-mailadres dat is.
3. **Transactie met `occurred_at` in de toekomst** — geweigerd bij validatie; `occurred_at` mag in het verleden liggen (late invoer) maar niet na `created_at`.
4. **Klant wordt gemerged (Module 1) nadat er al transacties aan het "verliezende" profiel gekoppeld waren** — Module 1's merge-logica re-parent de `customer_id` op transacties naar het overlevende profiel (zoals al vastgelegd in Module 1's ontwerp, sectie 14 "Integratie met overige modules").
5. **Regel-items tellen niet op tot het totaalbedrag** (bijvoorbeeld door een fooi die niet als line item is ingevoerd) — binnen een configureerbare marge (default €0,50) geaccepteerd, daarbuiten een waarschuwing (geen harde blokkade, om invoer niet onnodig te frustreren).
6. **Annulering van een transactie die al reward heeft gegenereerd** — `transaction.voided`-event moet door Module 4 worden opgevangen om de toegekende Beach Credit navenant te corrigeren/intrekken (uitgewerkt in Module 4's eigen ontwerp, niet hier — deze module publiceert alleen het event).
7. **Bulk-invoer aan het einde van een dienst** (meerdere transacties tegelijk, elk met eigen `occurred_at`) — ondersteund via herhaalde `POST /transactions`-calls; geen aparte bulk-endpoint nodig in deze fase, kan later worden toegevoegd als de handmatige workload dat rechtvaardigt.

---

## 12. Audit logging

Dezelfde gedeelde `audit_log`-infrastructuur als Module 1 (zie dat ontwerp, sectie 13). Voor deze module altijd verplicht gelogd:
- Elke correctie (`action: update`, met `before_state`/`after_state` op basis van `transaction_corrections`)
- Elke annulering (`action: delete`, met verplichte `reason`)
- Elke achteraf-koppeling aan een klant

---

## 13. Analytics (basisvelden die deze module levert)

Deze module berekent zelf geen KPI's (dat is Module 10), maar levert de brongegevens voor:
- Omzet per locatie/periode
- Aantal transacties per locatie/periode
- Gemiddelde transactiewaarde
- Percentage transacties gekoppeld aan een loyaltylid ("omzet via loyaltyleden" uit de basisprincipes)
- Piekmomenten per locatie (basis voor bezettingsgraad, Module 9)

---

## 14. Integratie met overige modules

| Module | Relatie met Transactions & POS |
|---|---|
| **1. Customer & CRM** | `resolve-identity` wordt aangeroepen bij transactie-invoer om een klant te koppelen; `transaction.completed`-event werkt de denormalized cache-velden bij |
| **3. Wallet & Credit** | Geen directe relatie — Wallet & Credit reageert op Module 4's rewardberekening, niet rechtstreeks op transacties |
| **4. Reward Engine** | Primaire consument van `transaction.completed` — berekent Beach Credit op basis van `amount` |
| **9. Reservations & Occupancy Booster** | Gebruikt transactietijdstippen/locatie als bezettingsgraad-datapunt |
| **10. Analytics & AI** | Bronmodule voor alle omzetgerelateerde rapportages |

**Toekomstige POS-koppeling (niet nu gebouwd, wel voorbereid):** wanneer een kassasysteem wordt aangesloten, verandert er niets aan het datamodel — alleen `source` wordt `pos`, `source_reference` bevat het kassabonnummer, en de aanroep naar `POST /transactions` gebeurt automatisch door de kassa-integratie in plaats van handmatig door een medewerker. Precies zoals bij Module 1's auth-stub (headers → straks een echte auth-module), is dit één vervangbaar onderdeel, geen architecturale wijziging.

---

## Voorstel implementatievolgorde

1. **Fase 1 — Kern transactiemodel:** `transactions`-tabel, `POST`/`GET /transactions`, koppeling met `resolve-identity` uit Module 1. Zonder dit heeft Module 1's cache niets om op te reageren.
2. **Fase 2 — Events:** `transaction.completed` publiceren, Module 1's event-consumer bijwerken zodat `visit_count`/`lifetime_spend` daadwerkelijk gaan vullen (dit is de directe aanleiding voor deze module).
3. **Fase 3 — Correcties & annulering:** `transaction_corrections`, `/correct`, `/void`-endpoints — nodig zodra er echt met geld gewerkt wordt, maar mag na de eerste werkende basisflow.
4. **Fase 4 — Regel-items:** `transaction_line_items` — pas relevant zodra Module 4's reward-uitsluitingen per product gebouwd worden; kan uitgesteld worden tot dat moment.
5. **Fase 5 — Achteraf-koppeling:** `/link-customer`-endpoint — comfort-feature, niet blokkerend voor de rest.

**Op platformniveau** is de logische volgende stap **Module 3 (Wallet & Credit)** of **Module 4 (Reward Engine)** — beide hebben nu pas zin, omdat ze afhankelijk zijn van `transaction.completed`-events die deze module gaat publiceren.

---

Wil je dat we hierna direct de database-migratie voor Module 2 bouwen en testen (zoals we deden bij Module 1), of eerst het ontwerp van **Module 4 (Reward Engine)** uitwerken zodat de twee samen één compleet beeld geven van "transactie → Beach Credit"?
