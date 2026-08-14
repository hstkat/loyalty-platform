# Module 4 — Reward Engine (herziene, volledige versie)

> Vervangt de eerdere, vereenvoudigde versie van Module 4. Deze versie ontwerpt een volledige rule engine met meerdere gelijktijdig actieve regeltypen, een expliciet en voorspelbaar calculation model (stacking, exclusiviteit, caps), en een Rule Simulator voor support/debugging. Bouwt voort op Module 2 (Transactions & POS, herziene versie) en levert de trigger voor Module 3 (Wallet & Credit).

---

## 1. Reward rule model

Het kernidee: **elke regel is een zelfstandig object met een type, een bucket (waar hij in de berekening meedoet), een prioriteit en een geldigheidsvenster.** Regels worden niet als losse velden op een "instellingen"-pagina bijgehouden (zoals in de vorige versie van dit ontwerp), maar als rijen in één centrale `reward_rules`-tabel met een `rule_type`-discriminator. Dit maakt het mogelijk om willekeurig veel regels van elk type tegelijk actief te hebben, zonder het datamodel steeds te moeten uitbreiden voor een nieuw regeltype.

```
reward_rules (één rij per regel, ongeacht type)
    │
    ├── rule_type: base | tier | day | time | location |
    │              product | campaign | bonus | challenge
    │
    ├── bucket: percentage | multiplier | flat_bonus | challenge
    │   (bepaalt WAAR in de berekening de regel meedoet — sectie 3)
    │
    ├── priority (bepaalt volgorde binnen een bucket bij conflicten)
    │
    ├── stacking_mode: additive | exclusive | highest_only
    │   (bepaalt HOE de regel zich verhoudt tot andere regels
    │   in dezelfde bucket — sectie 4)
    │
    └── geldigheid: active_from/until, dagen, tijdvenster,
        locatie, tier, product-categorie (afhankelijk van type)
```

Elke regel heeft een **versie** (sectie 15) — regels worden nooit overschreven zodra ze ooit zijn toegepast, alleen als nieuwe versie gepubliceerd, zodat een berekening van drie maanden geleden nog steeds reproduceerbaar is met de regels zoals die toen golden.

---

## 2. Rule types

| Type | Bucket | Voorbeeld uit de opdracht | Werking |
|---|---|---|---|
| `base` | percentage | 5% credit | De standaardregel, geldt tenzij overschreven door een specifiekere regel binnen dezelfde bucket |
| `tier` | percentage | Gold: 6% (i.p.v. 5%), of: Gold: +1% bovenop base | Configureerbaar per organisatie of tier-regels de base **vervangen** of **aanvullen** (zie sectie 4 — dit is precies de vraag uit het voorbeeld) |
| `day` | multiplier | Dinsdag: double credit | Vermenigvuldigt het resultaat van de percentage-bucket |
| `time` | multiplier | 16:00-18:00: 2x credit | Zelfde bucket als `day`, kan gelijktijdig actief zijn (zie stacking, sectie 4) |
| `location` | percentage | Beachclub Noordwijk: extra 2% | Telt op bij de percentage-bucket, net als `tier` |
| `product` | percentage (exclusion) of percentage (bonus) | Cocktails: 10% credit | Werkt op regel-niveau (line item category, uit Module 2) — kan zowel een *hogere* reward op specifieke producten instellen als een *uitsluiting* (alcohol, cadeaubonnen — zie sectie 5) |
| `campaign` | multiplier | Sunny Day: 2x credit op lunch | Zelfde bucket als `day`/`time`; gekoppeld aan Module 5 (Campaign Manager) |
| `bonus` | flat_bonus | Spend €100: €5 extra | Vast bedrag, getriggerd door een drempelvoorwaarde, niet een percentage van de rekening |
| `challenge` | challenge | 3 bezoeken in 60 dagen: €20 bonus | Niet gebonden aan één transactie — evalueert een periode-voorwaarde over meerdere transacties heen (sectie 3, aparte pijplijn) |

### `reward_rules`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organization_id` | UUID (FK) | |
| `location_id` | UUID, nullable (FK) | `null` = organisatiebreed |
| `rule_type` | enum | zie tabel hierboven |
| `bucket` | enum | `percentage`, `multiplier`, `flat_bonus`, `challenge` — afgeleid van `rule_type` maar expliciet opgeslagen t.b.v. query-snelheid in de calculation engine |
| `name` | varchar | |
| `priority` | integer | lager = eerder geëvalueerd binnen dezelfde bucket bij `exclusive`-conflicten |
| `stacking_mode` | enum | `additive`, `exclusive`, `highest_only` (sectie 4) |
| `percentage_value` | decimal(5,2), nullable | voor `percentage`-bucket regels |
| `multiplier_value` | decimal(4,2), nullable | voor `multiplier`-bucket regels |
| `flat_bonus_amount` | decimal(10,2), nullable | voor `flat_bonus`-bucket regels |
| `flat_bonus_threshold` | decimal(10,2), nullable | drempelbedrag dat de flat bonus triggert (bv. "besteed €100") |
| `challenge_condition` | jsonb, nullable | bv. `{"type": "visit_count", "count": 3, "within_days": 60}` |
| `challenge_reward_amount` | decimal(10,2), nullable | |
| `tier_id` | UUID, nullable | voor `rule_type = tier` |
| `applies_on_day` | jsonb, nullable | voor `rule_type = day`, bv. `["tuesday"]` |
| `time_window_start` / `time_window_end` | time, nullable | voor `rule_type = time`/`campaign` |
| `product_categories` | jsonb, nullable | voor `rule_type = product`, matcht tegen `transaction_line_items.category` (Module 2) |
| `is_exclusion` | boolean | default `false` — bij `true` sluit deze `product`-regel de betreffende categorie juist **uit** van reward in plaats van een bonus te geven (implementeert "alcohol/cadeaubonnen uitsluiten") |
| `campaign_id` | UUID, nullable | verwijzing naar Module 5, geen harde FK (zie eerdere versie van dit ontwerp) |
| `active_from` / `active_until` | timestamp, nullable | |
| `is_active` | boolean | |
| `version` | integer | zie sectie 15 |
| `superseded_by_rule_id` | UUID, nullable | |
| `created_at` / `updated_at` | timestamp | |

---

## 3. Calculation order

De berekening loopt in **vaste, expliciete stadia** — dit is het "voorspelbare calculation model" dat de opdracht vraagt. Elk stadium levert een tussenresultaat op dat in de calculation trace (sectie 13) zichtbaar wordt.

```
STADIUM 0 — Eligible spend bepalen
  Input: transaction.completed event (Module 2), met per
  regel-item: bedrag + category + reward_eligible (al door
  Module 2 vooraf gemarkeerd op basis van product-mapping)
  Extra hier: product-exclusieregels (rule_type: product,
  is_exclusion: true) worden ook hier toegepast, als tweede
  controle bovenop wat Module 2 al deed — belangrijk omdat
  Module 2 alleen kijkt naar de POS-mapping, terwijl deze
  module ook organisatie-specifieke uitsluitingsregels kent
  die niets met de POS-koppeling te maken hebben.
  Output: eligible_amount

STADIUM 1 — Percentage-bucket (additief gecombineerd)
  Alle actieve regels met bucket=percentage die van
  toepassing zijn (base, tier, location, product-bonus)
  worden GEADDEERD tot één combined_percentage, TENZIJ
  een regel stacking_mode=exclusive heeft (dan telt alleen
  de hoogst-prioriteit exclusive-regel, en worden overige
  additive-regels in deze bucket genegeerd — zie sectie 4)
  Output: combined_percentage, percentage_subtotal =
  eligible_amount × combined_percentage

STADIUM 2 — Multiplier-bucket
  Alle actieve regels met bucket=multiplier (day, time,
  campaign) worden gecombineerd volgens hun stacking_mode
  (default voor deze bucket: highest_only — zie sectie 4
  voor de onderbouwing van deze keuze)
  Output: effective_multiplier, multiplied_subtotal =
  percentage_subtotal × effective_multiplier

STADIUM 3 — Flat bonus-bucket
  Alle actieve bonus-regels waarvan de drempel is gehaald
  (eligible_amount >= flat_bonus_threshold) worden GEADDEERD
  — deze worden NIET vermenigvuldigd door de multiplier uit
  stadium 2 (business rule, zie sectie 4)
  Output: flat_bonus_total, pre_cap_total =
  multiplied_subtotal + flat_bonus_total

STADIUM 4 — Caps toepassen
  maximum_reward_per_transaction, campaign_cap,
  customer_cap, location_cap — in die volgorde, elke cap
  kan het bedrag alleen verlagen, nooit verhogen
  Output: final_reward_amount

STADIUM 5 — Challenge-regels (aparte pijplijn, niet
  geblend met stadium 0-4)
  Wordt NA de reguliere transactieberekening, als losse
  stap, geëvalueerd: is er een challenge-conditie behaald
  door deze transactie? (bv. dit is bezoek 3 binnen 60
  dagen) Zo ja: aparte reward_calculation-rij met
  rule_type=challenge, eigen bedrag, niet opgeteld bij
  final_reward_amount van stadium 4 — dit blijft een apart,
  herkenbaar type reward in Module 3/de klant-timeline.
```

**Waarom deze volgorde en niet anders:** percentage-regels eerst optellen (stadium 1) en dán pas vermenigvuldigen (stadium 2) is de enige volgorde die het voorbeeld uit de opdracht ("base 5% + Gold 1% + Double Credit") eenduidig maakt — zie het uitgewerkte voorbeeld in sectie 4.

---

## 4. Stacking

Dit is het hart van de vraag uit de opdracht: *"base 5% + Gold 1% + Double Credit campagne — wat gebeurt er precies?"*

### Stacking-regels per bucket

| Bucket | Default stacking | Onderbouwing |
|---|---|---|
| `percentage` | **additive** | Tier- en locatiebonussen zijn bedoeld als *opbouwend* voordeel ("Gold-leden krijgen 1% extra"), niet als vervanging — dit sluit aan bij hoe loyaltyprogramma's doorgaans worden begrepen door gasten ("hoe hoger mijn status, hoe meer ik krijg bovenop de basis") |
| `multiplier` | **highest_only** | Als twee multiplier-regels (bv. een Dinsdag-boost én een Sunny Day-campagne) zouden *vermenigvuldigen* (2× × 2× = 4×), zou een toevallige samenloop van acties de marge-bescherming uit de basisprincipes ondermijnen. Daarom telt bij multipliers **standaard alleen de hoogste**, niet het product van alle actieve multipliers. Dit is per organisatie omzetbaar naar `multiply` (expliciete keuze, met een waarschuwing in de UI over margerisico) |
| `flat_bonus` | **additive** | Drempelbonussen zijn per definitie onafhankelijk van elkaar (spend €100 → €5, spend €200 → nog eens €5) en horen simpelweg opgeteld te worden |
| `challenge` | n.v.t. (aparte pijplijn) | Challenges zijn nooit onderling stapelbaar binnen dezelfde transactie — een challenge wordt hoogstens éénmaal per keer dat de conditie vervuld raakt uitgekeerd |

### `stacking_mode`-waarden (per regel instelbaar, override op de bucket-default)

- **`additive`** — telt op bij andere additive-regels in dezelfde bucket (default voor percentage/flat_bonus)
- **`exclusive`** — als deze regel van toepassing is, worden alle andere regels in dezelfde bucket genegeerd (zelfs als die ook additive zouden zijn); bij meerdere gelijktijdig actieve `exclusive`-regels wint de hoogste `priority`
- **`highest_only`** — van alle regels in de bucket met deze mode, telt alleen de regel met de hoogste waarde mee (default voor multiplier)

### Volledig doorgerekend voorbeeld (exact het voorbeeld uit de opdracht)

```
Input:
  Klant: Gold-tier
  Bedrag: €100 (volledig eligible, geen uitsluitingen)
  Locatie: Beachclub Noordwijk (geen locatie-regel actief
           in dit voorbeeld, om het overzichtelijk te houden)
  Campagne: Double Credit actief (multiplier ×2, stacking_mode:
           highest_only, geen andere multiplier-regel actief)

STADIUM 0: eligible_amount = €100,00

STADIUM 1 (percentage-bucket, additive):
  base rule:  5,00%
  tier rule (Gold): +1,00%  (additive, geen exclusive-regel
                              aanwezig die dit zou blokkeren)
  ─────────────────────────
  combined_percentage = 6,00%
  percentage_subtotal = €100 × 6% = €6,00

STADIUM 2 (multiplier-bucket, highest_only):
  Double Credit campagne: ×2,00  (enige actieve multiplier-
                                   regel, dus automatisch de
                                   "hoogste")
  effective_multiplier = 2,00
  multiplied_subtotal = €6,00 × 2 = €12,00

STADIUM 3 (flat bonus-bucket):
  Geen bonus-regel met gehaalde drempel in dit voorbeeld
  flat_bonus_total = €0,00
  pre_cap_total = €12,00

STADIUM 4 (caps):
  Aangenomen: geen van de caps wordt overschreden
  final_reward_amount = €12,00

RESULTAAT: Total earned = €12,00
```

**Dit is dus het antwoord op de vraag uit de opdracht:** tier-bonussen tellen *op* bij de basis vóórdat een campagne-multiplier wordt toegepast — het resultaat is `(5% + 1%) × 2 = 12%`, **niet** `5% × 2 + 1% = 11%` en ook niet `5% + (1% × 2) = 7%`. Deze keuze (percentage eerst optellen, dán vermenigvuldigen) is expliciet vastgelegd in de calculation order (sectie 3) juist om dit soort dubbelzinnigheid te voorkomen.

---

## 5. Exclusions

Twee soorten uitsluiting, beide via `rule_type: product` met `is_exclusion: true`, maar op een verschillend niveau werkend:

1. **Categorie-uitsluiting (regelniveau)** — bv. "alcohol" of "cadeaubonnen" tellen nooit mee voor reward, ongeacht de rest van de transactie. Toegepast in Stadium 0: de `eligible_amount` wordt al zonder deze regels berekend, dus de uitsluiting werkt door in de hele verdere berekening (de percentage-bucket rekent nooit over het uitgesloten bedrag).
2. **Voorwaardelijke uitsluiting (transactieniveau)** — bijvoorbeeld: als een transactie volledig met een cadeaubon is betaald (`payment_method: voucher`, uit Module 2), kan een organisatie ervoor kiezen de hele transactie uit te sluiten van reward, niet alleen de cadeaubon-regel zelf. Dit is een aparte, organisatiebrede instelling (`exclude_voucher_payments: boolean`), niet een `reward_rules`-rij, omdat het een transactie-brede aan/uit-schakelaar is, geen percentage- of multiplier-regel.

**Uitsluitingen doen nooit mee aan `stacking`** — een uitgesloten bedrag is simpelweg nooit onderdeel van `eligible_amount`, dus er is niets om mee te "stapelen". Dit voorkomt de denkfout dat een uitsluiting een "regel met percentage 0%" zou zijn (wat problemen zou geven bij de additive-optelling in stadium 1).

---

## 6. Caps

Vier cap-niveaus, in vaste volgorde toegepast (stadium 4), elk **verlagend, nooit verhogend**:

| Cap | Veld | Scope | Voorbeeld |
|---|---|---|---|
| **Maximum per transactie** | `reward_rules.maximum_reward_per_transaction` (op de van toepassing zijnde base-regel) | één transactie | "Nooit meer dan €25 reward per rekening, ongeacht stacking" |
| **Campaign cap** | `reward_boosts.max_budget` / `budget_spent` (zie eerdere versie van dit ontwerp, ongewijzigd) | totale campagne, over alle klanten/transacties | "Double Credit-actie kost maximaal €500 aan extra reward" |
| **Customer cap** | nieuw: `reward_customer_caps`-tabel | per klant, per periode | "Maximaal €50 reward per klant per maand" |
| **Location cap** | nieuw: `reward_location_caps`-tabel | per locatie, per periode | "Maximaal €1.000 totale reward-uitgave per dag op deze locatie" |

### `reward_customer_caps` / `reward_location_caps`

Beide tabellen delen dezelfde structuur (apart gehouden omdat de scope — klant vs. locatie — fundamenteel verschilt in hoe de teller wordt bijgehouden):

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organization_id` | UUID (FK) | |
| `customer_id` / `location_id` | UUID (FK) | afhankelijk van tabel |
| `period_type` | enum | `daily`, `weekly`, `monthly` |
| `max_amount` | decimal(10,2) | |
| `current_period_spent` | decimal(10,2) | opgehoogd bij elke toegekende reward, gereset bij periode-overgang (achtergrondjob, net als `reward_boosts.budget_spent`-reset niet nodig is omdat dat al totaal-voor-de-hele-campagneduur is — caps zijn juist periodiek) |
| `current_period_start` | date | |

**Cap-toepassing (stadium 4, in volgorde):**
```
final_amount = pre_cap_total (uit stadium 3)

1. final_amount = MIN(final_amount, maximum_reward_per_transaction)
   indien ingesteld

2. Als reward_boost van toepassing was (stadium 2):
   resterend_campaign_budget = max_budget - budget_spent
   final_amount = MIN(final_amount, resterend_campaign_budget)
   (zelfde principe als in de vorige versie van dit ontwerp)

3. resterend_customer_cap = max_amount - current_period_spent
   (voor de van toepassing zijnde period_type)
   final_amount = MIN(final_amount, resterend_customer_cap)

4. resterend_location_cap = max_amount - current_period_spent
   final_amount = MIN(final_amount, resterend_location_cap)

→ final_reward_amount, met in de calculation trace (sectie 13)
  expliciet vermeld WELKE cap (indien van toepassing) het
  bedrag heeft verlaagd, zodat dit nooit een raadsel is voor
  support
```

---

## 7. Validity

Elke regel heeft een geldigheidsvenster op meerdere assen tegelijk — een regel is alleen van toepassing als **alle** relevante assen kloppen:

| As | Veld(en) | Van toepassing op |
|---|---|---|
| Tijd (absoluut) | `active_from`, `active_until` | alle regeltypen |
| Dag van de week | `applies_on_day` | `day`-regels, optioneel ook combineerbaar met andere typen |
| Tijdvenster binnen de dag | `time_window_start/end` | `time`, `campaign` |
| Locatie | `location_id` (`null` = alle locaties) | alle regeltypen |
| Tier | `tier_id` | `tier`-regels |
| Productcategorie | `product_categories` | `product`-regels |
| `is_active`-vlag | `is_active` | handmatige aan/uit-schakeling, onafhankelijk van de tijdvensters — voor snel een regel kunnen pauzeren zonder de datums te wijzigen |

**Tijdzone-consistentie:** net als in Module 2's blackout-datum-edge-case, worden `time_window_start/end` en `applies_on_day` geïnterpreteerd in de tijdzone van de `location` (uit Module 1's `locations.timezone`), niet in UTC — anders zou "16:00-18:00" op verschillende locaties in verschillende landen een ander daadwerkelijk moment betekenen.

---

## 8. Database

Aanvullend op wat al in secties 2 en 6 is uitgewerkt (`reward_rules`, `reward_customer_caps`, `reward_location_caps`), de resterende tabellen:

### `reward_calculations` (herzien t.o.v. vorige versie — nu met volledige trace)

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organization_id` | UUID | |
| `transaction_id` | UUID, nullable (FK naar Module 2) | `null` bij een simulator-run (sectie 10) |
| `customer_id` | UUID, nullable (FK naar Module 1) | |
| `eligible_amount` | decimal(10,2) | |
| `combined_percentage` | decimal(5,2) | resultaat stadium 1 |
| `percentage_subtotal` | decimal(10,2) | |
| `effective_multiplier` | decimal(4,2) | resultaat stadium 2 |
| `multiplied_subtotal` | decimal(10,2) | |
| `flat_bonus_total` | decimal(10,2) | resultaat stadium 3 |
| `pre_cap_total` | decimal(10,2) | |
| `applied_caps` | jsonb | welke caps zijn geraakt en met welk effect (sectie 6) |
| `final_reward_amount` | decimal(10,2) | |
| `calculation_trace` | jsonb | volledige stap-voor-stap trace, zie sectie 13 |
| `applied_rule_ids` | jsonb | array van `reward_rules.id` + versie, die hebben meegewogen |
| `is_simulation` | boolean | default `false` |
| `superseded_by_correction_id` | UUID, nullable | (ongewijzigd t.o.v. vorige versie) |
| `created_at` | timestamp | |

### `reward_challenge_progress`

Nodig omdat challenges (stadium 5) een voortgang over meerdere transacties bijhouden — dit bestond nog niet in de vorige versie van dit ontwerp.

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `reward_rule_id` | UUID (FK, rule_type=challenge) | |
| `customer_id` | UUID (FK) | |
| `progress_count` | integer | bv. aantal bezoeken tot nu toe binnen het venster |
| `window_started_at` | timestamp | wanneer de telling voor deze klant begon |
| `completed_at` | timestamp, nullable | gevuld zodra de conditie is behaald en de bonus is uitgekeerd |
| `reward_calculation_id` | UUID, nullable (FK) | de challenge-specifieke `reward_calculations`-rij die is aangemaakt bij voltooiing |

---

## 9. Rule builder UI

Eén centraal scherm, met een formulier dat **dynamisch verandert op basis van het gekozen `rule_type`** — zodat een manager nooit velden ziet die niet relevant zijn voor het type regel dat hij aanmaakt:

```
┌─────────────────────────────────────────────────────┐
│  Nieuwe reward-regel                                  │
├─────────────────────────────────────────────────────┤
│  Type: [ Tier-regel ▾ ]                                │
│                                                         │
│  Naam: [ Gold-bonus                              ]     │
│  Tier: [ Gold ▾ ]                                       │
│  Extra percentage: [ 1,00 ]%                            │
│  Stacking: [ ⦿ Optellen bij basisregel               │
│              ○ Vervangt basisregel volledig ]           │
│                                                         │
│  Locatie: [ Alle locaties ▾ ]                           │
│  Geldig vanaf: [ 01-09-2026 ]  tot: [ (onbeperkt) ]     │
│                                                         │
│  [ Simuleer effect ]        [ Annuleren ]  [ Opslaan ]  │
└─────────────────────────────────────────────────────┘
```

**Belangrijkste UX-principe (consistent met basisprincipe "zeer eenvoudig voor restaurantmanagers"):** de stacking-keuze wordt **in mensentaal** gepresenteerd ("Optellen bij basisregel" / "Vervangt basisregel volledig"), niet als technisch jargon ("additive"/"exclusive") — de vertaling naar `stacking_mode` gebeurt onder water. Elke regel-aanmaak-flow heeft een directe **"Simuleer effect"**-knop die naar de Rule Simulator (sectie 10) springt, vooringevuld met een representatief voorbeeldbedrag, zodat een manager vóór het opslaan al ziet wat de regel in de praktijk betekent.

**Overzichtsscherm** toont alle actieve regels gegroepeerd per bucket (percentage/multiplier/flat_bonus/challenge), met een waarschuwingsindicator als er binnen een bucket een `exclusive`-regel is die andere regels overschaduwt — zodat conflicten zichtbaar zijn vóórdat een gast er per ongeluk de dupe van wordt.

---

## 10. Simulator

De simulator hergebruikt **exact dezelfde berekeningscode** als de live transactieverwerking (sectie 3) — geen aparte "simulatie-logica" die kan afwijken van de werkelijkheid. Het enige verschil: de input komt niet uit een `transaction.completed`-event, maar direct uit het simulator-formulier, en het resultaat wordt opgeslagen met `is_simulation: true` (geen `transaction_id`, geen effect op Module 3's saldo).

```
┌─────────────────────────────────────────────────────┐
│  Rule Simulator                                        │
├─────────────────────────────────────────────────────┤
│  Klant-tier: [ Gold ▾ ]                                 │
│  Bedrag: [ €100,00 ]                                    │
│  Locatie: [ Beachclub Noordwijk ▾ ]                      │
│  Tijd: [ 13:00 ]     Dag: [ Zaterdag ▾ ]                │
│  Actieve campagne: [ Sunny Day ▾ ]                       │
│                                                         │
│  [ Bereken ]                                             │
├─────────────────────────────────────────────────────┤
│  RESULTAAT                                              │
│                                                         │
│  Eligible spend           €100,00                        │
│  ─────────────────────────────────                      │
│  Base (5%)                  €5,00                        │
│  + Gold-tier (+1%)          €1,00                        │
│  = Percentage subtotaal     €6,00   (6,00%)               │
│  ─────────────────────────────────                      │
│  × Sunny Day-campagne       ×2,00                         │
│  = Na multiplier            €12,00                        │
│  ─────────────────────────────────                      │
│  + Flat bonussen              €0,00                        │
│  ─────────────────────────────────                      │
│  Caps: geen van toepassing                                 │
│  ═════════════════════════════════                      │
│  TOTAAL VERDIEND             €12,00                        │
│                                                         │
│  [ Bekijk volledige trace (JSON) ]                        │
└─────────────────────────────────────────────────────┘
```

Dit scherm reproduceert exact het voorbeeld uit de opdracht, en toont — conform de eis *"laat exact zien waarom"* — elke stap met het bijbehorende tussenbedrag, niet alleen het eindresultaat.

**Gebruik voor support:** wanneer een gast een vraag heeft over een ontvangen (of juist niet-ontvangen) reward, kan een supportmedewerker dezelfde parameters invoeren als de daadwerkelijke transactie (of, nog directer, de knop **"Simuleer deze transactie opnieuw"** gebruiken vanaf een echte `reward_calculations`-detailpagina, die de simulator vooraf invult met de exacte historische parameters via de bewaarde regel-versies — sectie 15) om te reproduceren wat er is gebeurd.

---

## 11. API

Basis: `/api/v1/organizations/{orgId}`

| Methode | Endpoint | Omschrijving |
|---|---|---|
| `GET` | `/reward-rules` | Lijst, filterbaar op `ruleType`, `bucket`, `locationId`, `isActive` |
| `POST` | `/reward-rules` | Nieuwe regel aanmaken (maakt automatisch versie 1 aan) |
| `PATCH` | `/reward-rules/{id}` | Publiceert een nieuwe versie (zie sectie 15 — geen in-place update van een al-gebruikte regel) |
| `DELETE` | `/reward-rules/{id}` | Deactiveren (`is_active = false`), nooit hard delete |
| `GET` | `/reward-customer-caps` / `/reward-location-caps` | Overzicht ingestelde caps |
| `POST` | `/reward-customer-caps` / `/reward-location-caps` | Cap instellen |
| `POST` | `/reward-simulations` | Simulator-aanroep — body: `{ tierId, amount, locationId, occurredAt, campaignId? }`, response: zie sectie 12 |
| `GET` | `/reward-calculations` | Reward-log (ongewijzigd t.o.v. vorige versie, nu met `calculationTrace` in de detail-response) |
| `GET` | `/reward-calculations/{id}` | Detail, inclusief volledige trace |
| `POST` | `/reward-calculations/{id}/resimulate` | Herhaalt de berekening van een bestaande transactie in de simulator, met de destijds geldende regel-versies (sectie 15) |

---

## 12. Calculation response

Elke berekening — of het nu een live transactie is of een simulatie — retourneert exact dezelfde response-vorm, zodat frontend-componenten (reward-log-detail en simulator) dezelfde weergavecode kunnen hergebruiken:

```json
{
  "eligibleAmount": 100.00,
  "stages": {
    "percentage": {
      "combinedPercentage": 6.00,
      "subtotal": 6.00,
      "appliedRules": [
        { "ruleId": "...", "name": "Basisregel", "value": 5.00, "stackingMode": "additive" },
        { "ruleId": "...", "name": "Gold-bonus", "value": 1.00, "stackingMode": "additive" }
      ]
    },
    "multiplier": {
      "effectiveMultiplier": 2.00,
      "subtotal": 12.00,
      "appliedRule": { "ruleId": "...", "name": "Sunny Day", "value": 2.00, "stackingMode": "highest_only" },
      "ignoredRules": []
    },
    "flatBonus": {
      "total": 0.00,
      "appliedRules": []
    },
    "caps": {
      "applied": [],
      "preCapAmount": 12.00
    }
  },
  "finalRewardAmount": 12.00,
  "isSimulation": true
}
```

`ignoredRules` (in het multiplier-stadium) en `appliedCaps` (indien gevuld) zijn expliciet aanwezig, ook als leeg — dit is bewust, zodat de frontend altijd kan tonen "deze regel was ook actief maar had geen effect, en hier is waarom" in plaats van dat ontbrekende informatie tot giswerk leidt.

---

## 13. Audit/debug trace

`calculation_trace` (jsonb-veld op `reward_calculations`) bevat de meest gedetailleerde laag — een letterlijk logboek van elke evaluatiestap, inclusief regels die **niet** van toepassing waren en waarom niet:

```json
[
  { "stage": "eligibility", "message": "Eligible amount: €100.00 (geen uitsluitingen van toepassing)" },
  { "stage": "percentage", "message": "Basisregel (5.00%) van toepassing — organisatiebreed" },
  { "stage": "percentage", "message": "Tier-regel Gold (+1.00%) van toepassing — klant is Gold-lid, stacking: additive" },
  { "stage": "percentage", "message": "Locatie-regel Beachclub Noordwijk: NIET geëvalueerd — geen actieve locatieregel gevonden" },
  { "stage": "percentage", "message": "Combined percentage: 6.00% → €6.00" },
  { "stage": "multiplier", "message": "Dinsdag-regel: NIET van toepassing — transactiedag is zaterdag" },
  { "stage": "multiplier", "message": "Sunny Day-campagne (×2.00): van toepassing — binnen tijdvenster 12:00-15:00" },
  { "stage": "multiplier", "message": "Stacking: highest_only — enige actieve multiplier, dus effective_multiplier = 2.00" },
  { "stage": "multiplier", "message": "€6.00 × 2.00 = €12.00" },
  { "stage": "flat_bonus", "message": "Geen bonus-regels met gehaalde drempel" },
  { "stage": "caps", "message": "Geen caps overschreden" },
  { "stage": "result", "message": "Final reward amount: €12.00" }
]
```

Dit is precies het "debug trace"-vereiste uit de opdracht: **elke regel die overwogen is, staat erin — ook de regels die niet van toepassing waren, met de reden.** Dit voorkomt de meest voorkomende support-vraag ("waarom kreeg mijn Gold-klant geen dubbele bonus op dinsdag ÉN de campagne tegelijk?") van een raadsel tot een direct aanwijsbaar antwoord.

---

## 14. Performance

- **Regel-matching is geïndexeerd op de meest selectieve velden eerst:** `organization_id` + `is_active` + `rule_type`/`bucket` — bij elke transactie wordt niet de volledige `reward_rules`-tabel doorzocht, maar direct de kleine subset actieve regels voor die organisatie/locatie/bucket.
- **Caps-tellers (`current_period_spent`) zijn denormalized**, niet bij elke berekening opnieuw gesommeerd uit de volledige `reward_calculations`-geschiedenis — een achtergrondjob (of atomaire increment bij elke toekenning) houdt deze actueel, zodat een cap-check een simpele veldvergelijking is, geen aggregatie-query onder tijdsdruk tijdens transactieverwerking.
- **De berekening is volledig synchroon en in-memory per transactie** (geen externe aanroepen tijdens de rekenstappen zelf) — de enige I/O is het ophalen van de actieve regelset (gecached, met korte TTL, per organisatie/locatie) en het wegschrijven van het resultaat. Dit houdt de reward-berekening ruim binnen de latency-marge die nodig is om niet merkbaar te vertragen op de `transaction.completed`-verwerking uit Module 2.
- **Simulator-aanroepen delen dezelfde gecachede regelset** als live berekeningen — geen apart, zwaarder pad voor simulaties, wat ook meteen garandeert dat simulator en werkelijkheid nooit uit elkaar kunnen lopen door een prestatie-optimalisatie die alleen aan één kant is toegepast.

---

## 15. Versioning van regels

Regels worden **nooit in-place overschreven** zodra ze ooit in een `reward_calculations`-rij zijn toegepast — dit is essentieel voor reproduceerbaarheid (de simulator moet een transactie van drie maanden geleden exact kunnen naspelen, ook al is het rewardpercentage sindsdien gewijzigd).

```
reward_rules.version: integer, start op 1

PATCH /reward-rules/{id} met wijzigingen
        │
        ▼
Is deze regel ooit toegepast (bestaat er een
reward_calculations-rij met deze rule_id in
applied_rule_ids)?
        │
   ┌────┴─────┐
  Nee         Ja
   │           │
   ▼           ▼
In-place    Nieuwe rij aanmaken:
update      - zelfde id-groep (via een
toegestaan    parent_rule_id-veld dat naar
(nog geen     de eerste versie wijst)
              - version + 1
              - superseded_by_rule_id op de
                oude versie ingevuld
              - active_from = nu (of een
                door de manager gekozen
                toekomstige datum)
              - oude versie: active_until
                wordt gezet op het moment
                dat de nieuwe versie ingaat
```

`reward_calculations.applied_rule_ids` bevat altijd de **specifieke versie** die is gebruikt (niet alleen het regel-ID), zodat een latere `resimulate`-aanroep (sectie 11) de destijds geldende parameters ophaalt, ook als de regel inmiddels tien keer is aangepast.

**UI-consequentie:** het rule builder-scherm (sectie 9) toont bij het bewerken van een reeds-gebruikte regel expliciet: *"Deze regel is al X keer toegepast. Wijzigen maakt een nieuwe versie aan vanaf [datum]; eerdere berekeningen blijven ongewijzigd."* — zodat een manager begrijpt dat hij geen geschiedenis herschrijft.

---

## Voorstel implementatievolgorde

1. **Fase 1 — Kernmodel + percentage-bucket:** `reward_rules` (alleen `base`/`tier`/`location`/`product`-typen), stadium 0-1 van de calculation engine. Dit levert al een werkend, zij het eenvoudig, rewardsysteem op.
2. **Fase 2 — Multiplier-bucket:** `day`/`time`/`campaign`-typen, stadium 2, inclusief de `highest_only`-default en de expliciete keuze dit configureerbaar te maken naar `multiply`.
3. **Fase 3 — Calculation trace + calculation response:** sectie 12/13 — dit lijkt "achteraf", maar is bewust vroeg in de volgorde omdat elke volgende fase (caps, bonussen) er baat bij heeft om vanaf het begin volledig traceerbaar te zijn, in plaats van dit later te moeten toevoegen aan al bestaande berekeningslogica.
4. **Fase 4 — Caps:** `reward_customer_caps`/`reward_location_caps`, stadium 4. Noodzakelijk vóór er met echte campagnebudgetten gewerkt wordt.
5. **Fase 5 — Flat bonus + challenge:** stadium 3 en 5, inclusief `reward_challenge_progress`. Deze zijn functioneel onafhankelijk van de rest en kunnen als laatste, zonder de kern te raken.
6. **Fase 6 — Rule builder UI + Simulator:** kan parallel aan fase 2-5 gebouwd worden zodra de calculation response (fase 3) stabiel is — de simulator heeft namelijk niets anders nodig dan diezelfde response-vorm.
7. **Fase 7 — Versioning:** kan technisch vanaf het begin (het `version`-veld kost weinig), maar de *workflow* eromheen (UI-waarschuwing, resimulate-knop) is pas zinvol zodra er daadwerkelijk regels zijn die vaak wijzigen — logisch sluitstuk.

---

Wil je dat we hierna de database-migraties voor beide herziene modules (2 en 4) samen bouwen en testen tegen een echte Postgres, zoals we bij Module 1 deden?
