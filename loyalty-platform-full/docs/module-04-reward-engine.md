# Module 4 — Reward Engine

> Onderdeel van het horeca/hospitality loyaltyplatform. Bouwt voort op Module 1 (Customer & CRM) en Module 2 (Transactions & POS). Deze module is de rekenkern: ze luistert naar `transaction.completed`-events en bepaalt hoeveel Beach Credit een gast verdient — binnen de marge-beschermende regels uit de basisprincipes. Ze kent zelf geen saldo toe (dat is Module 3, Wallet & Credit) — ze berekent en publiceert een reward-event.

**Scope-afbakening:** deze module bepaalt *hoeveel* een gast verdient en *of* dat mag, gegeven de regels van de organisatie. Het daadwerkelijk vasthouden en muteren van het saldo, vervaldatums en inwisseling gebeurt in Module 3. Deze knip is bewust — een organisatie kan haar rewardregels aanpassen (bv. van 5% naar 7%) zonder dat de saldo-boekhouding zelf ooit hoeft te wijzigen.

---

## 1. Functionele beschrijving

De Reward Engine is de plek waar het rewardpercentage, de uitsluitingsregels en de marge-bescherming uit de basisprincipes ("geen permanente kortingsmachine") samenkomen tot één berekening per transactie.

Kernverantwoordelijkheden:

1. **Reward-regels beheren** — per organisatie, optioneel per locatie: rewardpercentage, minimumbesteding, uitgesloten dagen/producten, blackout dates, maximum campagnekosten.
2. **Reward berekenen bij elke voltooide transactie** — luistert naar `transaction.completed`, past de van toepassing zijnde regel toe, en publiceert het resultaat.
3. **Tijdelijke boosts ondersteunen** — "Double Credit"-acties, Sunny Day-bonussen etc. (de acties zelf worden in Module 5, Campaign Manager, gedefinieerd; deze module past de vermenigvuldigingsfactor toe op het moment van berekening).
4. **Budget bewaken** — een campagne of blackout-regel kan een maximum reward-budget hebben; de engine weigert (of begrenst) rewards zodra dat budget bereikt is.
5. **Correcties verwerken** — reageert op `transaction.corrected`/`transaction.voided` om eerder toegekende rewards terug te draaien.
6. **AI-voorstellen mogelijk maken, nooit AI-uitvoering** — de engine is de plek waar business rules en budgetgrenzen hard worden afgedwongen, ook als een AI-module (Module 10) een "volgende beste actie" voorstelt. AI stelt voor; de Reward Engine beslist binnen de grenzen die een mens heeft ingesteld.

---

## 2. Schermen

**Manager/admin-omgeving:**

1. **Reward-regels overzicht** — huidige regel(s) per locatie, met "actief sinds"-datum
2. **Reward-regel bewerken** — rewardpercentage, minimumbesteding, maximum inwisselpercentage (relevant voor Module 3, hier alleen gedefinieerd), uitgesloten dagen, blackout dates
3. **Actieve boosts** — lijst van tijdelijke vermenigvuldigingsfactoren (gekoppeld aan Module 5-campagnes), met resterend budget zichtbaar
4. **Reward-log per transactie** — audit-achtig overzicht: welke regel is toegepast, welk bedrag, eventuele weigering en de reden
5. **Budget-dashboard** — resterend campagnebudget, "reward liability" (totaal aan nog niet ingewisseld tegoed — leest uit Module 3, hier alleen getoond als context bij regel-instelling)

---

## 3. UX-flow

**Reward-berekening bij een voltooide transactie (het hoofdproces, volledig automatisch):**

```
transaction.completed event ontvangen
        │
        ▼
Heeft de transactie een customer_id?
        │
   ┌────┴─────┐
  Nee         Ja
   │           │
   ▼           ▼
Stop, geen   Zoek van toepassing zijnde
reward       reward-regel (locatie > 
(niet-lid)   organisatie, meest
             specifieke regel wint)
                  │
                  ▼
             Regel gevonden en actief?
                  │
             ┌────┴─────┐
            Nee         Ja
             │           │
             ▼           ▼
        Stop, geen    Voldoet transactie aan
        reward        voorwaarden? (minimum-
        (geen regel   besteding, niet op
        geconfigureerd) blackout date/dag,
                       product niet uitgesloten)
                            │
                       ┌────┴─────┐
                      Nee         Ja
                       │           │
                       ▼           ▼
                  Stop, geen   Bereken basisbedrag
                  reward       (amount × percentage)
                  (reden
                  gelogd)      │
                               ▼
                          Actieve boost van
                          toepassing? (bv.
                          Double Credit)
                               │
                          ┌────┴─────┐
                         Nee         Ja
                          │           │
                          │           ▼
                          │      Budget van boost
                          │      nog beschikbaar?
                          │           │
                          │      ┌────┴────┐
                          │     Nee        Ja
                          │      │          │
                          │      ▼          ▼
                          │  Gebruik     Pas vermenig-
                          │  basisbedrag vuldiger toe,
                          │  (boost      verlaag boost-
                          │  uitgeput,   budget
                          │  gelogd)
                          └──────┬──────┘
                                 ▼
                          Publiceer event:
                          reward.calculated
                          (bedrag, regel-id,
                          eventuele boost-id)
                                 │
                                 ▼
                          Module 3 kent saldo toe
```

**Ontwerpprincipe:** dit hele proces is **volledig automatisch en synchroon** op het `transaction.completed`-event — geen handmatige stap nodig voor de normale flow. Managers zien alleen het resultaat (reward-log) en stellen vooraf de regels in; ze "keuren" geen individuele rewards goed. Dat past bij de eis "zeer eenvoudig voor restaurantmanagers" uit de basisprincipes.

---

## 4. Database schema (overzicht)

```
organizations
    │
    ├── locations
    │
    ├── reward_rules ──────────────┐
    │       │                       │
    │       └── (location_id nullable = organisatiebreed)
    │
    ├── reward_boosts
    │       │
    │       └── (koppeling naar Module 5 campaign_id, hier alleen referentie)
    │
    └── reward_calculations ───────┐
            │                       │
            ├── (transaction_id → Module 2)
            ├── (customer_id → Module 1)
            └── (reward_rule_id, reward_boost_id → binnen deze module)
```

---

## 5. Belangrijkste tabellen en velden

### `reward_rules`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organization_id` | UUID (FK) | |
| `location_id` | UUID, nullable (FK) | `null` = geldt organisatiebreed; een locatie-specifieke regel overschrijft de organisatiebrede |
| `name` | varchar | bv. "Standaard rewardregel", "Zomerseizoen Noordwijk" |
| `reward_percentage` | decimal(5,2) | bv. `5.00` voor 5% |
| `minimum_spend` | decimal(10,2), nullable | onder dit bedrag geen reward |
| `maximum_reward_per_transaction` | decimal(10,2), nullable | cap per transactie, ongeacht percentage |
| `excluded_days` | jsonb | bv. `["monday"]`, leeg = geen uitsluiting |
| `excluded_product_categories` | jsonb | vrije lijst, matcht tegen `transaction_line_items.category` (Module 2) indien aanwezig |
| `blackout_dates` | jsonb | array van datums of datumranges |
| `is_active` | boolean | default `true` |
| `active_from` | date, nullable | |
| `active_until` | date, nullable | |
| `created_at` / `updated_at` | timestamp | |

> **Ontwerpkeuze — locatie-specifiek overschrijft organisatiebreed:** dit implementeert direct de eis uit de basisprincipes ("centrale campagnes mogelijk, maar ook per locatie") voor reward-regels specifiek. Bij het zoeken naar de van toepassing zijnde regel wordt eerst gekeken naar een actieve regel met `location_id = de locatie van de transactie`; alleen als die ontbreekt, valt het systeem terug op de organisatiebrede regel (`location_id = null`).

### `reward_boosts`

Tijdelijke vermenigvuldigingsfactoren — het technische fundament onder acties als "Double Credit" en "Sunny Day".

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organization_id` | UUID (FK) | |
| `location_id` | UUID, nullable (FK) | |
| `campaign_id` | UUID, nullable | verwijzing naar Module 5 (Campaign Manager) — hier alleen referentie, geen FK-constraint naar een module die nog niet bestaat |
| `name` | varchar | bv. "Dubbel tegoed tijdens lunch" |
| `multiplier` | decimal(4,2) | bv. `2.00` voor dubbel |
| `valid_from` | timestamp | |
| `valid_until` | timestamp | |
| `time_window_start` | time, nullable | bv. `12:00`, voor "alleen tijdens de lunch" |
| `time_window_end` | time, nullable | |
| `max_budget` | decimal(10,2), nullable | maximale totale extra rewardkosten van deze boost |
| `budget_spent` | decimal(10,2) | default `0`, opgehoogd bij elke toepassing |
| `is_active` | boolean | |

### `reward_calculations`

De uitkomst van elke berekening — ook wanneer er **geen** reward is toegekend (met reden), zodat het reward-log (scherm 4) compleet is.

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organization_id` | UUID | |
| `transaction_id` | UUID (FK naar Module 2) | |
| `customer_id` | UUID, nullable (FK naar Module 1) | |
| `reward_rule_id` | UUID, nullable (FK) | `null` als er geen regel van toepassing was |
| `reward_boost_id` | UUID, nullable (FK) | `null` als er geen boost was |
| `base_amount` | decimal(10,2) | het transactiebedrag waarop berekend is |
| `calculated_reward` | decimal(10,2) | het uiteindelijk toegekende bedrag (`0` bij weigering) |
| `outcome` | enum | `granted`, `skipped_no_rule`, `skipped_below_minimum`, `skipped_blackout`, `skipped_excluded_day`, `skipped_excluded_product`, `skipped_no_customer`, `capped_at_maximum` |
| `superseded_by_correction_id` | UUID, nullable | verwijst naar een latere herberekening als de onderliggende transactie is gecorrigeerd |
| `created_at` | timestamp | |

> **Ontwerpkeuze — ook "skipped"-uitkomsten loggen:** dit is essentieel voor het "data-driven"-basisprincipe. Zonder dit zou een manager nooit kunnen zien *waarom* een gast geen tegoed kreeg — en dat is precies het soort vraag die managers stellen ("waarom heeft deze VIP-gast geen credit gekregen?").

---

## 6. Relaties

- `organizations 1—N reward_rules`
- `locations 1—N reward_rules` (optioneel, via `location_id`)
- `organizations 1—N reward_boosts`
- `transactions (Module 2) 1—1 reward_calculations` (in de praktijk 1-op-1 per transactie, tenzij herberekend na correctie)
- `customers (Module 1) 1—N reward_calculations`
- `reward_rules 1—N reward_calculations`
- `reward_boosts 1—N reward_calculations`

---

## 7. Business rules

1. **Meest specifieke regel wint.** Locatie-specifieke `reward_rules` overschrijven organisatiebrede regels; binnen hetzelfde niveau wint de regel met de meest recente `active_from`.
2. **Geen reward zonder gekoppelde klant.** Een transactie met `customer_id = null` resulteert altijd in `outcome: skipped_no_customer` — consistent met Module 2's business rule #3.
3. **`maximum_reward_per_transaction` is een harde cap**, ook als percentage × bedrag hoger zou uitkomen — dit is de kern van "geen permanente kortingsmachine" uit de basisprincipes.
4. **Boosts zijn nooit een vervanging van een reward-regel, alleen een vermenigvuldiging erop.** Een boost zonder onderliggende actieve `reward_rule` heeft geen effect (`outcome` blijft `skipped_no_rule`).
5. **Boost-budget is een harde grens.** Zodra `budget_spent >= max_budget`, wordt de boost niet meer toegepast — de reward valt terug op de normale regel (niet op nul), met `outcome: granted` maar zonder `reward_boost_id`.
6. **Correcties op transacties triggeren een herberekening**, nooit een handmatige aanpassing van `reward_calculations`. Een nieuwe rij wordt aangemaakt; de oude krijgt `superseded_by_correction_id` gevuld — append-only, consistent met de audit-eisen elders in het platform.
7. **AI-voorgestelde boosts moeten altijd binnen een bestaand budget/regel-kader vallen.** De Reward Engine accepteert geen "vrij" bedrag van een AI-suggestie (Module 10) — een AI-voorstel resulteert hooguit in het *aanmaken* van een `reward_boost`-rij (door een manager bevestigd, zie Module 5), waarna dezelfde harde regels van hierboven gelden. Dit implementeert direct de eis "AI mag nooit zelfstandig onbeperkte korting uitdelen" uit de basisprincipes.
8. **Rewardpercentage en regels zijn per organisatie en optioneel per locatie configureerbaar** — nooit hardcoded, consistent met het architectuurprincipe "vermijd hardcoded businesslogica".

---

## 8. API endpoints

Basis: `/api/v1/organizations/{orgId}/reward-rules` en `/api/v1/organizations/{orgId}/reward-boosts`

| Methode | Endpoint | Omschrijving |
|---|---|---|
| `GET` | `/reward-rules` | Lijst (organisatiebreed + per locatie) |
| `POST` | `/reward-rules` | Nieuwe regel aanmaken |
| `PATCH` | `/reward-rules/{id}` | Regel bijwerken |
| `DELETE` | `/reward-rules/{id}` | Regel deactiveren (soft, `is_active = false`, nooit hard delete i.v.m. audit van eerdere berekeningen) |
| `GET` | `/reward-boosts` | Lijst actieve/geplande boosts |
| `POST` | `/reward-boosts` | Nieuwe boost aanmaken (handmatig of via Module 5-campagne) |
| `PATCH` | `/reward-boosts/{id}` | Boost bijwerken (bv. budget verhogen) |
| `GET` | `/reward-calculations` | Reward-log, filterbaar op `customerId`, `outcome`, datumrange |
| `GET` | `/reward-calculations/{id}` | Detail van één berekening |
| `POST` | `/transactions/{transactionId}/recalculate` | Handmatig herberekenen (bv. na een late regel-wijziging) — normaal gesproken triggert dit automatisch via events |

> Er is bewust **geen** `POST /reward-calculations`-endpoint — berekeningen ontstaan alleen als reactie op `transaction.completed`, nooit door een directe API-call. Dit voorkomt dat iemand per ongeluk (of kwaadwillend) rewards buiten de transactie-flow om aanmaakt.

---

## 9. Events

**Consumeert:**
- `transaction.completed` (Module 2) → triggert de volledige berekeningsflow uit sectie 3
- `transaction.corrected` (Module 2) → herberekening, oude `reward_calculations`-rij gemarkeerd als superseded
- `transaction.voided` (Module 2) → reward wordt op `0` herberekend, `outcome` wordt overschreven met een nieuwe rij (niet de oude verwijderd)

**Publiceert:**
- `reward.calculated` — payload: `transactionId`, `customerId`, `calculatedReward`, `outcome`, `rewardRuleId`, `rewardBoostId`. Dit is het event waar Module 3 (Wallet & Credit) op reageert om daadwerkelijk saldo toe te kennen.
- `reward.boost_budget_exhausted` — payload: `boostId`, `spentAmount`. Relevant voor Module 5/6 om een manager te waarschuwen dat een actie is "opgebruikt".

---

## 10. Permissions

| Rol | Rechten |
|---|---|
| **Organization Admin** | Volledige CRUD op reward-regels en boosts, organisatiebreed |
| **Location Manager** | CRUD op regels/boosts binnen eigen locatie; kan geen organisatiebrede regel aanmaken/wijzigen |
| **Staff** | Alleen leesrechten op het reward-log (t.b.v. het beantwoorden van gastvragen aan de balie) |
| **Marketing** | Boosts aanmaken/bewerken (i.s.m. Module 5-campagnes), geen wijzigingsrecht op de basis-`reward_rules` |
| **API/Integration key** | Geen — deze module heeft geen extern aanroepbare schrijf-endpoints buiten de reguliere admin-rollen; de trigger is altijd een intern event |

Permissie-primitieven: `reward_rule.read`, `reward_rule.write`, `reward_boost.read`, `reward_boost.write`, `reward_calculation.read`.

---

## 11. Edge cases

1. **Twee gelijk-specifieke regels actief op hetzelfde niveau** (bv. twee organisatiebrede regels door een configuratiefout) — de engine kiest de meest recent aangemaakte (`created_at` desc) en logt een waarschuwing; dit zou in de UI (scherm 2) al voorkomen moeten worden door bij het aanmaken te waarschuwen voor overlap, maar de engine faalt nooit hard hierop.
2. **Transactie valt op de grens van een blackout-datum** (bv. `occurred_at` om 23:59 op de laatste dag van een blackout-periode) — blackout-datums worden geïnterpreteerd in de tijdzone van de locatie (`locations.timezone`, uit Module 1's schema), niet in UTC, om verrassingen te voorkomen.
3. **Boost-budget raakt precies tijdens de berekening op** (race condition bij gelijktijdige transacties rond het budgetplafond) — de budget-ophoging gebeurt in dezelfde database-transactie als de berekening zelf, met een `SELECT ... FOR UPDATE`-achtige lock, zodat er nooit meer wordt uitgegeven dan het ingestelde maximum, ook niet bij gelijktijdige requests.
4. **Klant wordt gemerged (Module 1) nadat rewards al berekend waren voor beide profielen** — `reward_calculations`-rijen volgen de `customer_id`-re-parenting die Module 1's merge-logica al uitvoert; er is geen aparte mergelogica nodig binnen deze module.
5. **Een reward-regel wordt gewijzigd terwijl er nog transacties "in de wacht" staan voor verwerking** (bv. bij bulk-invoer aan einde dienst, zie Module 2 edge case #7) — elke transactie wordt beoordeeld tegen de regel die **op het moment van verwerking** actief is, niet tegen de regel die gold op `occurred_at`. Dit is een bewuste, gedocumenteerde keuze: reward-regels zijn geen met-terugwerkende-kracht-toepasbare wetgeving, en het alternatief (regel-op-`occurred_at`) zou onvoorspelbaar gedrag geven bij late invoer.
6. **`excluded_product_categories` verwijst naar een categorie die niet als line item is ingevoerd** (want line items zijn optioneel, zie Module 2) — zonder line items kan een product-uitsluiting niet worden gecontroleerd; de engine past in dat geval de regel toe op het totaalbedrag zonder productuitsluiting, en dit gedrag wordt inzichtelijk gemaakt in de UI ("uitsluitingen niet gecontroleerd: geen regel-items aanwezig") zodat een manager weet dat hij line items moet invoeren als productuitsluiting echt gehandhaafd moet worden.

---

## 12. Audit logging

Gedeelde `audit_log`-infrastructuur (zie Module 1, sectie 13). Verplicht gelogd:
- Elke wijziging aan een `reward_rule` (percentage, minimum, uitsluitingen)
- Elke wijziging aan een `reward_boost`, met name budgetverhogingen
- Herberekeningen als gevolg van transactiecorrecties (`reason` bevat automatisch een verwijzing naar de onderliggende correctie)

`reward_calculations` zelf is al append-only en dient als het functionele log — de `audit_log` legt daarnaast wie de **regels** heeft aangepast, niet elke individuele berekening (dat zou de audit-tabel onnodig laten exploderen bij hoog transactievolume).

---

## 13. Analytics (basisvelden die deze module levert)

- Totaal uitgegeven rewards per periode/locatie
- Redemption-relevante brondata: hoeveel is *toegekend* (deze module) versus *ingewisseld* (Module 3) — het verschil is de "outstanding credit" uit de basisprincipes
- Verdeling van `outcome`-waarden (hoeveel transacties kregen géén reward, en waarom) — direct bruikbaar voor het "waarom" achter reward-liability-rapportages
- Boost-effectiviteit: omzet tijdens actieve boost-periodes vs. daarbuiten (ruwe data; de daadwerkelijke ROI-berekening incl. campagnekosten hoort bij Module 5/10)

---

## 14. Integratie met overige modules

| Module | Relatie met Reward Engine |
|---|---|
| **1. Customer & CRM** | Rewardberekening gebruikt `customer_id`; resultaat (via Module 3) verschijnt uiteindelijk in de klant-timeline als `reward_granted`/`reward_used` |
| **2. Transactions & POS** | Primaire trigger — elke `transaction.completed` doorloopt deze engine |
| **3. Wallet & Credit** | Consument van `reward.calculated` — kent het daadwerkelijke saldo toe, beheert vervaldatum en inwisseling |
| **5. Campaign Manager** | Creëert/beheert `reward_boosts` namens marketingacties ("Double Credit", "Sunny Day") |
| **6. Messaging** | Kan `reward.calculated` gebruiken om een directe bevestiging te sturen ("Je hebt €9,20 Beach Credit verdiend...") |
| **9. Reservations & Occupancy Booster** | Kan reward-boosts triggeren op basis van bezettingsgraad (bv. "dubbel tegoed bij lage lunchbezetting") — de koppeling zelf hoort bij Module 9's ontwerp, deze module levert alleen het boost-mechanisme |
| **10. Analytics & AI** | Leest `reward_calculations` voor rapportages; AI-voorstellen resulteren hooguit in nieuwe `reward_boost`-concepten die een mens moet bevestigen (business rule #7) |

---

## Voorstel implementatievolgorde

1. **Fase 1 — Kern reward-regels:** `reward_rules`-tabel, CRUD-endpoints, de matching-logica (locatie > organisatie). Zonder dit kan er niets berekend worden.
2. **Fase 2 — Berekeningsflow op transacties:** luisteren naar `transaction.completed`, `reward_calculations` wegschrijven, `reward.calculated`-event publiceren. Dit is de kern van deze module en de directe aanleiding om haar te bouwen.
3. **Fase 3 — Correcties/annuleringen verwerken:** reageren op `transaction.corrected`/`transaction.voided`. Kan iets later, maar niet te lang uitstellen zodra er met echt geld gewerkt wordt.
4. **Fase 4 — Boosts:** `reward_boosts`-tabel, vermenigvuldigingslogica, budgetbewaking. Pas relevant zodra Module 5 (Campaign Manager) er is om boosts daadwerkelijk vanuit een actie aan te maken — tot die tijd kunnen boosts handmatig via de API getest worden.
5. **Fase 5 — Reward-log UI en analytics-basisvelden:** comfort/inzicht-features, niet blokkerend voor de kernwerking.

**Op platformniveau:** Module 3 (Wallet & Credit) is nu de logische volgende stap — pas als die er is, resulteert een `reward.calculated`-event daadwerkelijk in zichtbaar, bruikbaar tegoed voor de gast. Zonder Module 3 berekent deze engine wel correct, maar "landt" het bedrag nergens.

---

Wil je dat we hierna Module 3 (Wallet & Credit) ontwerpen — de laatste schakel om het complete plaatje "transactie → reward → zichtbaar tegoed" rond te maken — of gaan we eerst de database-migraties voor Module 2 en 4 samen bouwen en testen?
