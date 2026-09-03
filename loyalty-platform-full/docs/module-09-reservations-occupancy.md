# Module 9 — Reservations & Occupancy Booster

> Onderdeel van het horeca/hospitality loyaltyplatform. Dit is de module die het platform specifiek horeca-sterk maakt: reserveringsdata + weer + historische patronen worden gecombineerd tot een voorspelling, en waar capaciteit dreigt onbenut te blijven, stelt het systeem een campagne voor — nooit autonoom uitvoert. Bouwt voort op Module 2 (Transactions), Module 5 (Campaign Manager), Module 7 (Segmentation).

**Architecturale kern, letterlijk uit de opdracht:** drie strikt gescheiden stappen — **recommendation** (dit module stelt iets voor) → **approval** (een mens keurt goed) → **campaign execution** (Module 5's bestaande, ongewijzigde launch-mechanisme). Deze module **creëert nooit zelf een actieve campagne** — ze maakt hoogstens een `draft`-campagne aan in Module 5 zodra een voorstel is goedgekeurd, en de daadwerkelijke start blijft altijd Module 5's eigen, expliciete launch-actie.

---

## 1. Reservation integration

Zelfde architectuurpatroon als Module 2's POS-integratielaag: een generieke ingestion-pijplijn met per-provider adapters (OpenTable, Formitable, of vergelijkbare reserveringssystemen), plus handmatige invoer als fallback — geen kassa-koppeling nodig, net zoals bij Module 2 desgewenst uitgesteld kan worden.

```
Reserveringssysteem (extern)          Handmatige invoer
        │                                    │
        ▼                                    ▼
┌─────────────────────────────────────────────────┐
│         Reservation Integration Layer               │
│  (zelfde opzet als Module 2: webhook/poll/bulk,        │
│  reservation_events ruwe payload-opslag,                 │
│  idempotency op external_reservation_id)                  │
└─────────────────────┬───────────────────────────────┘
                       ▼
                 reservations (genormaliseerd)
                       │
                       ▼
              occupancy_calculation (sectie 2)
```

### `reservation_connections`

Functioneel identiek aan Module 2's `pos_connections` (provider, connectionMode, credentials, status) — hier niet opnieuw volledig uitgeschreven, zie dat ontwerp voor het patroon.

---

## 2. Occupancy calculation

```
Voor een gegeven locatie + datum + service-periode
(lunch/diner) + eventueel gebied (terras):
        │
        ▼
capacity = location_capacity_settings.maxCovers
(geconfigureerd per locatie/gebied/periode)
        │
        ▼
booked_covers = SOM(reservations.covers) WAAR
  status IN ('confirmed', 'seated', 'completed')
  AND location/datum/periode/gebied matcht
  (cancelled en no-show tellen NIET mee)
        │
        ▼
occupancy_percentage = booked_covers / capacity × 100
```

### `location_capacity_settings`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `locationId` | UUID (FK) | |
| `area` | varchar, nullable | `null` = hele locatie; anders bv. `"terras"` |
| `servicePeriod` | enum | `lunch`, `dinner`, `all_day` |
| `maxCovers` | integer | |

**Dit is exact het "MORGEN"-scherm uit de opdracht:** voor elke combinatie van locatie/periode/gebied wordt dit percentage berekend, en samen met het weer (sectie 10) getoond op het managerdashboard (sectie 9).

---

## 3. Forecast model

**Simpel, regelgebaseerd startmodel — expliciet ontworpen om later te kunnen worden vervangen door ML, zonder dat de rest van het platform hoeft te veranderen.**

```
Voorspelde bezetting voor locatie X, datum Y, periode Z
        │
        ▼
Basis: historisch gemiddelde
  = gemiddelde occupancy_percentage van de afgelopen
    N weken op DEZELFDE dag van de week + periode
    (bv. "elke donderdag-lunch van de afgelopen 8 weken")
        │
        ▼
Seizoenscorrectie
  = vermenigvuldigingsfactor per maand/seizoen,
    berekend uit een langere historische reeks
    (bv. augustus scoort structureel hoger dan januari)
        │
        ▼
Weerscorrectie (sectie 10)
  = vermenigvuldigingsfactor gebaseerd op de weersvoorspelling
    versus het historische gemiddelde weer op vergelijkbare
    dagen (zonnig + warm boven een bepaalde drempel verhoogt
    de factor voor terrassen/lunch, bijvoorbeeld)
        │
        ▼
Reserverings-signaal (lead-time-curve)
  = huidige boekingen-tot-nu-toe vergeleken met het
    historische patroon van "hoeveel reserveringen waren
    er normaliter al binnen op dit aantal dagen vooraf"
    (bv. "normaliter is 60% van de lunch-reserveringen
    3 dagen van tevoren al binnen; nu zien we pas 25%
    van dat historische gemiddelde — signaal voor een
    stillere dag dan gebruikelijk")
        │
        ▼
Events/feestdagen-correctie
  = handmatig ingevoerde of geïmporteerde lijst met
    lokale evenementen/feestdagen die de vraag structureel
    verhogen/verlagen (bv. Koningsdag, een lokaal festival)
        │
        ▼
forecast_occupancy_percentage = basis × seizoenscorrectie
  × weerscorrectie × reserverings-signaal-correctie
  × events-correctie (elke factor rond 1.0, samen een
  redelijke bijstelling van de historische basis)
```

### `forecast_runs`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `locationId` | UUID (FK) | |
| `forecastDate` | date | |
| `servicePeriod` | enum | |
| `area` | varchar, nullable | |
| `modelVersion` | varchar | bv. `"rule_based_v1"` — expliciet gelabeld zodat een toekomstig ML-model naast/in plaats van dit model kan draaien zonder de rest van de tabel te breken |
| `forecastOccupancyPercentage` | decimal(5,2) | |
| `factorsUsed` | jsonb | elke factor uit de berekening hierboven, apart bewaard — traceerbaarheid, zelfde principe als Module 4's calculation trace |
| `computedAt` | timestamp | |

**Uitbreidbaarheid naar ML (expliciet ontworpen, niet toevallig):** `modelVersion` maakt het mogelijk om meerdere forecastmodellen naast elkaar te laten draaien (bv. tijdens een validatieperiode het regelgebaseerde model én een ML-model parallel te laten voorspellen), en later simpelweg over te schakelen door welk `modelVersion` als "actief" geldt voor sectie 4's opportunity-detectie. Geen enkele andere module hoeft te weten *hoe* de voorspelling tot stand kwam, alleen wat de uitkomst is.

---

## 4. Opportunity detection

```
Dagelijkse/meerdere-keren-per-dag job (bv. elk uur,
voor de komende 24-72 uur)
        │
        ▼
Voor elke locatie/periode/gebied-combinatie met een
recente forecast_run:
        │
        ▼
forecast_occupancy_percentage < organisatie-drempel?
(bv. < 45%, configureerbaar per organisatie/locatie/
periode — een terras heeft wellicht een andere drempel
dan een dinerservice)
        │
   ┌────┴─────┐
  Nee         Ja
   │           │
   ▼           ▼
Geen         occupancy_opportunities-rij aangemaakt
opportunity  (tenzij er al een niet-afgehandelde
             opportunity voor dezelfde locatie/datum/
             periode bestaat — geen duplicaten)
```

### `occupancy_opportunities`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID | |
| `locationId` | UUID (FK) | |
| `opportunityDate` | date | |
| `servicePeriod` | enum | |
| `area` | varchar, nullable | |
| `forecastRunId` | UUID (FK) | |
| `forecastOccupancyPercentage` | decimal(5,2) | |
| `status` | enum | `detected`, `recommendation_created`, `dismissed`, `expired` |
| `detectedAt` | timestamp | |

---

## 5. Campaign recommendations

```
Nieuwe occupancy_opportunity gedetecteerd
        │
        ▼
Bereken doelgroep (sectie 6)
        │
        ▼
Bereken incentive-voorstel (sectie 7)
        │
        ▼
occupancy_recommendations-rij aangemaakt:
  status: 'pending_approval'
  — dit is EXPLICIET GEEN campagne, alleen een voorstel
        │
        ▼
Zichtbaar op het managerdashboard (sectie 9), NOOIT
automatisch uitgevoerd
```

### `occupancy_recommendations`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `opportunityId` | UUID (FK) | |
| `organizationId` | UUID | |
| `suggestedName` | varchar | bv. "Sunny Lunch Booster" |
| `audienceFilter` | jsonb | zelfde DSL als Module 5/7 |
| `audienceCount` | integer | berekend op het moment van voorstel |
| `incentiveType` | enum | zelfde enum-waarden als Module 5 (`multiplier`, `flat_bonus`, etc.) |
| `incentiveValue` | jsonb | |
| `suggestedMessage` | text | het volledige, kant-en-klare pushbericht (zoals het voorbeeld: "Morgen wordt het strandweer...") |
| `estimatedMaxRewardExposure` | decimal(10,2) | zelfde berekeningswijze als Module 5's preview (sectie 10 van dat ontwerp) |
| `status` | enum | `pending_approval`, `approved`, `dismissed`, `expired` |
| `reviewedByUserId` | UUID, nullable | |
| `reviewedAt` | timestamp, nullable | |
| `resultingCampaignId` | UUID, nullable | gevuld zodra goedgekeurd (sectie 8) |
| `createdAt` | timestamp | |

**Expiratie:** een voorstel dat niet vóór de betreffende datum is beoordeeld, wordt automatisch `expired` — een AI-voorstel voor "morgen lunch" heeft geen waarde meer na morgen.

---

## 6. Audience recommendation

Exact de criteria uit het voorbeeld, uitgedrukt in dezelfde filter-DSL als Module 7:

```json
{
  "combinator": "AND",
  "conditions": [
    { "field": "lastVisitDaysAgo", "operator": "lte", "value": 180 },
    { "field": "favoriteVisitTimeWindow", "operator": "overlapsLunch", "value": true },
    { "field": "postcodeRegion", "operator": "in", "value": ["<relevante regio's>"] },
    { "field": "daysSinceLastVisit", "operator": "gt", "value": 14 },
    { "field": "marketingConsent", "operator": "isTrue" },
    { "field": "creditBalance", "operator": "gt", "value": 5 }
  ]
}
```

**Doelgroepgrootte wordt berekend via dezelfde query-engine als Module 7** (geen tweede implementatie van "hoeveel klanten voldoen hieraan") — dit levert het "624 gasten" uit het voorbeeld op.

**Regio-criterium** vereist dat `customers` een postcode/regio-veld heeft — dit valt onder Module 1's privacy-gevoelige velden (leeftijd/postcode alleen bruikbaar met profiling-consent, zoals al vastgelegd in Module 7 sectie 16) — deze module erft die beperking automatisch, geen aparte regel nodig.

---

## 7. Incentive recommendation

```
Forecast-tekort bepaalt de urgentie
        │
        ▼
Hoe lager de forecast_occupancy_percentage, hoe
sterker het voorgestelde incentive (binnen vooraf
door de organisatie ingestelde GRENZEN — het
systeem kiest nooit vrij een bedrag)
        │
        ▼
Organisatie-configuratie (occupancy_incentive_policy):
  - bij occupancy < 30%: voorstel "triple credit"
  - bij occupancy 30-45%: voorstel "double credit"
  - bij occupancy 45-60%: voorstel "10% extra credit"
  (drie configureerbare drempels/incentives, geen
  vrije AI-keuze)
        │
        ▼
estimatedMaxRewardExposure = audienceCount ×
gemiddelde besteding van deze doelgroep ×
reward-percentage × incentive-multiplier
(zelfde rekenwijze als Module 5's preview, sectie 10
van dat ontwerp — hergebruikt, niet opnieuw uitgevonden)
```

**Dit is de directe implementatie van "AI mag niet autonoom onbeperkte korting uitdelen":** het systeem kiest een incentive uit een vooraf door een mens gedefinieerde, begrensde lijst — het genereert nooit een vrij, willekeurig kortingspercentage.

---

## 8. Approval flow

```
Manager bekijkt een pending_approval-voorstel op
het dashboard (sectie 9)
        │
        ▼
   ┌────┴─────┐
Goedkeuren    Afwijzen
   │           │
   ▼           ▼
STAP 1:      status → 'dismissed'
Maak een      (geen verdere actie,
Module 5-     opportunity blijft
campagne AAN, gemarkeerd zodat
status:       hetzelfde voorstel
'draft',      niet nogmaals
VOLLEDIG      verschijnt)
VOORINGEVULD
met de
audienceFilter,
incentiveType/
Value, en het
suggestedMessage
als template-body
   │
   ▼
occupancy_recommendations.resultingCampaignId
gevuld, status → 'approved'
   │
   ▼
STAP 2 (APART, in Module 5, NIET automatisch):
Manager gaat naar de Module 5-campagne (nu in
draft), doorloopt desgewenst de preview (Module 5
sectie 10), en klikt ZELF op "Launch"
```

**Waarom goedkeuren niet meteen lanceert:** dit behoudt de bestaande, al zorgvuldig ontworpen Module 5-flow (preview, budgetcontrole, eventuele extra goedkeuring bij grote campagnes — sectie 9 van dat ontwerp) volledig intact. Eén voorstel goedkeuren betekent "ja, dit idee is goed" — het betekent nog niet "en ik heb ook net de laatste preview-cijfers gecontroleerd vlak vóór verzending". Die twee momenten bewust gescheiden houden voorkomt dat een snel weggeklikte goedkeuring per ongeluk een live campagne wordt zonder laatste controle.

---

## 9. Manager dashboard

**Het "MORGEN"-scherm, exact zoals de opdracht het toont:**

```
┌─────────────────────────────────────────────────┐
│  Beachclub Noordwijk — Morgen (zaterdag 15 aug)        │
├─────────────────────────────────────────────────┤
│  Lunch:            42% bezetting   ⚠ Kans gedetecteerd    │
│  Diner:             81% bezetting                           │
│  Terras:             35% bezetting  ⚠ Kans gedetecteerd       │
│                                                                  │
│  Weer:  26°C, zonnig ☀️                                          │
├─────────────────────────────────────────────────┤
│  Voorgestelde campagne: "Sunny Lunch Booster"                     │
│                                                                       │
│  Doelgroep: 624 gasten                                                │
│  Incentive: Double Beach Credit                                         │
│  Geschatte max. reward-kosten: €1.180                                     │
│                                                                              │
│  Bericht: "Morgen wordt het strandweer ☀️ Je hebt nog                        │
│  €12,40 Beach Credit. Kom lunchen en verdien morgen                            │
│  dubbel tegoed."                                                                  │
│                                                                                        │
│  [ Afwijzen ]                              [ Goedkeuren → naar Module 5 ]                │
└─────────────────────────────────────────────────┘
```

**Weekoverzicht (aanvullend scherm):** dezelfde cijfers voor de komende 7 dagen, per locatie/periode, zodat een manager niet elke dag hoeft in te loggen om patronen te zien aankomen.

---

## 10. Weather integration

Zelfde generieke provider-aanpak als elders in het platform (Module 2/6): een `weather_provider`-configuratie per organisatie (bv. gekoppeld aan een externe weer-API), met een dagelijkse (of vaker) opgehaalde voorspelling per locatie.

### `weather_forecasts`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `locationId` | UUID (FK) | |
| `forecastDate` | date | |
| `temperatureCelsius` | decimal(4,1) | |
| `condition` | varchar | bv. `"sunny"`, `"rainy"`, `"cloudy"` |
| `precipitationChance` | decimal(5,2), nullable | |
| `fetchedAt` | timestamp | |

**Weerscorrectie-logica (sectie 3):** elke organisatie/locatie kan (optioneel) een eenvoudige regeltabel instellen die weer aan een vermenigvuldigingsfactor koppelt (bv. "zonnig + >22°C → terras-factor ×1,4") — net als Module 4's reward-regels, configureerbaar in plaats van hardcoded, met een verstandige platformdefault.

---

## 11. Campaign results

Zodra een voorstel is goedgekeurd en de resulterende Module 5-campagne is gelanceerd, **meet Module 5 de resultaten volledig zelf** (recipients, delivered, revenue, reward issued/redeemed, incremental revenue via controlegroep — zie Module 5 sectie 13). Deze module dupliceert dat niet — ze **leest** het terug via `occupancy_recommendations.resultingCampaignId` om de aanvullende, occupancy-specifieke vraag te beantwoorden: sectie 12.

---

## 12. Attribution

De unieke toegevoegde meetwaarde van deze module, bovenop wat Module 5 al meet: **heeft de campagne de voorspelde leegstand daadwerkelijk gedicht?**

```
Voor elke occupancy_opportunity met een resulterende,
uitgevoerde campagne:
        │
        ▼
forecast_occupancy_percentage (vóór de campagne,
sectie 3) vergelijken met
actual_occupancy_percentage (ACHTERAF berekend,
zelfde methode als sectie 2, maar dan met de
daadwerkelijke boekingen/bezoeken van die dag)
        │
        ▼
occupancy_uplift = actual − forecast
        │
        ▼
Gecombineerd met Module 5's incrementele omzet
(controlegroep-gebaseerd) geeft dit een compleet
antwoord op: "heeft deze booster gewerkt, en hoeveel
extra omzet/bezetting leverde het concreet op?"
```

### `occupancy_attribution_results`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `opportunityId` | UUID (FK) | |
| `campaignId` | UUID | Module 5's campagne |
| `forecastOccupancyPercentage` | decimal(5,2) | |
| `actualOccupancyPercentage` | decimal(5,2) | |
| `occupancyUplift` | decimal(5,2) | |
| `computedAt` | timestamp | |

---

## 13. Integrations

| Systeem | Rol |
|---|---|
| Reserveringssysteem (extern, sectie 1) | Brondata voor `reservations` |
| Weerprovider (sectie 10) | Brondata voor forecast-correctie |
| Module 2 (Transactions) | Werkelijke bezoeken/omzet, voor `actual_occupancy_percentage` (sectie 12) en voor de historische basis van het forecastmodel (sectie 3) |
| Module 5 (Campaign Manager) | Ontvangt goedgekeurde voorstellen als draft-campagnes; enige plek waar campagnes daadwerkelijk worden uitgevoerd |
| Module 7 (Segmentation) | Levert de query-engine voor doelgroepberekening (sectie 6) |
| Module 1 (Customer & CRM) | Bron voor alle klantvelden in de doelgroepfilter, inclusief consent-check |

---

## 14. Database

```
locations (Module 1)
    │
    ├── location_capacity_settings
    ├── weather_forecasts
    ├── reservation_connections
    └── reservations ──────────────┐
                                     │
forecast_runs ◄──────────────────────┤ (locatie/datum/periode)
    │                                 │
    ▼                                 │
occupancy_opportunities ◄─────────────┘
    │
    ▼
occupancy_recommendations ──► campaigns (Module 5, via resultingCampaignId)
    │
    ▼
occupancy_attribution_results
```

### `reservations`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID | |
| `locationId` | UUID (FK) | |
| `reservationConnectionId` | UUID, nullable (FK) | `null` bij handmatige invoer |
| `externalReservationId` | varchar, nullable | |
| `customerId` | UUID, nullable (FK naar Module 1) | via dezelfde identity-resolution als Module 2 |
| `dateTime` | timestamp | |
| `servicePeriod` | enum | `lunch`, `dinner`, `all_day` |
| `covers` | integer | aantal personen |
| `tableReference` | varchar, nullable | |
| `area` | varchar, nullable | bv. `"terras"` |
| `status` | enum | `confirmed`, `cancelled`, `no_show`, `seated`, `completed` |
| `createdAt` | timestamp | |

---

## 15. API/events

Basis: `/api/v1/organizations/{orgId}`

| Methode | Endpoint | Omschrijving |
|---|---|---|
| `GET` | `/locations/{id}/occupancy?date=...` | Sectie 2/9 — het "MORGEN"-scherm |
| `GET` | `/locations/{id}/occupancy/forecast?date=...` | Sectie 3 |
| `GET` | `/occupancy-opportunities` | Sectie 4, filterbaar op status |
| `GET` | `/occupancy-recommendations` | Sectie 5, filterbaar op status |
| `GET` | `/occupancy-recommendations/{id}` | Detail, inclusief doelgroep- en incentive-onderbouwing |
| `POST` | `/occupancy-recommendations/{id}/approve` | Sectie 8 — maakt de Module 5-draft-campagne aan |
| `POST` | `/occupancy-recommendations/{id}/dismiss` | Sectie 8 |
| `POST` | `/reservations` | Handmatige/generieke ingestion, zelfde patroon als Module 2 |
| `GET` | `/reservations` | Lijst |
| `PATCH` | `/reservations/{id}/status` | Statuswijziging (bv. `seated`, `no_show`) |
| `GET` | `/reservation-connections` | Sectie 1 |
| `GET` | `/occupancy-recommendations/{id}/attribution` | Sectie 12, na afloop van de campagne |

**Publiceert:** `reservation.created`/`cancelled`/`no_show`/`completed` (relevant voor Module 8's toekomstige No-Show Recovery-journey), `occupancy.opportunity_detected`, `occupancy.recommendation_created`, `occupancy.recommendation_approved`, `occupancy.recommendation_dismissed`.

**Consumeert:** `transaction.completed` (Module 2, voor werkelijke bezetting/omzet-attributie), `campaign.completed` (Module 5, om sectie 12's attributieberekening te triggeren).

---

## Voorstel implementatievolgorde

1. **Fase 1 — Reservation ingestion + occupancy calculation:** `reservations`, `location_capacity_settings`, sectie 1-2. Levert al het "MORGEN"-scherm op zonder enige voorspelling — puur wat er nu al geboekt is.
2. **Fase 2 — Weer-integratie:** sectie 10, relatief zelfstandig, voegt direct waarde toe aan het dashboard.
3. **Fase 3 — Simpel forecastmodel:** sectie 3, `rule_based_v1` — de historische-gemiddelde-basis alleen (zonder weer-/events-correctie) is al bruikbaar; correcties kunnen incrementeel worden toegevoegd.
4. **Fase 4 — Opportunity detection + audience/incentive-recommendatie:** sectie 4, 6, 7 — hergebruikt Module 5/7's bestaande rekenwijzen, dus relatief snel te bouwen zodra fase 1-3 staan.
5. **Fase 5 — Approval flow:** sectie 8, de koppeling naar Module 5's draft-campagnes.
6. **Fase 6 — Attribution:** sectie 12 — heeft per definitie pas zin nadat er campagnes zijn uitgevoerd, dus logisch sluitstuk.
7. **Fase 7 — ML-forecastmodel:** vervangt/vult `rule_based_v1` aan met een data-gedreven model, mogelijk gemaakt door het `modelVersion`-ontwerp uit sectie 3 — een toekomstig project, geen blokkerende afhankelijkheid voor de rest.

---

Wil je dat we hierna de database-migratie voor Module 9 bouwen en testen, zoals bij de vorige modules?
