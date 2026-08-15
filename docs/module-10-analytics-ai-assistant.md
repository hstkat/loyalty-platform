# Module 10 — Analytics & AI Campaign Assistant

> Onderdeel van het horeca/hospitality loyaltyplatform. Het laatste van de tien kernmodules — het centrale managementdashboard, en de AI-assistent die er bovenop zit. Deze module **rekent zelf geen nieuwe waarheid uit**: ze leest, aggregeert en presenteert wat de andere negen modules al hebben vastgelegd. De AI-assistent volgt exact hetzelfde recommendation-approval-execution-patroon dat in Module 9 is vastgelegd — nooit autonoom een campagne starten.

---

## 1. Dashboard

Het scherm waar een manager binnen 30 seconden de kernvraag beantwoord krijgt: "hoe staat loyalty ervoor?"

```
┌─────────────────────────────────────────────────────────┐
│  Beach Hospitality Group — Overzicht                          │
├─────────────────────────────────────────────────────────┤
│  LEDEN                    NIEUWE LEDEN DEZE MAAND                │
│  1.284                     +186                                    │
│                                                                       │
│  LOYALTY OMZET             GEMIDDELDE BESTEDING                       │
│  €42.380                    €87                                         │
│                                                                             │
│  REPEAT VISIT RATE          OUTSTANDING CREDIT                              │
│  38%                         €18.420                                          │
│                                                                                   │
│  CREDIT VERLOOPT <14 DAGEN    AT RISK              VIP                             │
│  €2.140                        84 gasten            126 gasten                       │
├─────────────────────────────────────────────────────────┤
│  [ Campagnes ]  [ Klanten ]  [ Credit ]  [ Locaties ]  [ AI Assistant ]    │
└─────────────────────────────────────────────────────────┘
```

Elke tegel is **klikbaar** en leidt naar de bijbehorende detailsectie (sectie 5-9) — het dashboard is een samenvatting, geen doodlopend eindpunt.

---

## 2. KPI definitions

Elke KPI wordt hier **expliciet** gedefinieerd — dit voorkomt de klassieke situatie waarin twee schermen "hetzelfde cijfer" tonen dat toch net anders berekend blijkt.

| KPI | Formule | Bron |
|---|---|---|
| **Leden** | `COUNT(customers) WHERE loyaltyStatus = 'active' AND deletedAt IS NULL` | Module 1 |
| **Nieuwe leden deze maand** | `COUNT(customers) WHERE createdAt IN huidige kalendermaand` | Module 1 |
| **Loyalty omzet** | `SUM(transactions.totalAmount) WHERE customerId IS NOT NULL AND status = 'completed' AND occurredAt IN periode` | Module 2 |
| **Gemiddelde besteding** | `Loyalty omzet / aantal transacties met customerId` (periode-gebonden, dus **niet** hetzelfde als Module 1's lifetime `averageSpend`) | Module 2 |
| **Repeat visit rate** | `COUNT(customers met >=2 transacties in periode) / COUNT(customers met >=1 transactie in periode)` | Module 2 |
| **Outstanding credit** | `SOM(wallets.availableBalance + wallets.pendingBalance)` over alle wallets | Module 3 |
| **Credit verloopt binnen 14 dagen** | `SOM(wallet_ledger_entries.remainingAmount) WHERE status = 'available' AND expiresAt BETWEEN nu EN nu+14 dagen` | Module 3 |
| **At Risk** | `COUNT(churn_risk_scores) WHERE isAtRisk = true` | Module 7 |
| **VIP** | `COUNT(segment_membership) WHERE segmentId = het VIP-standaardsegment` | Module 7 |

**Periode-gevoelige KPI's** (loyalty omzet, gemiddelde besteding, repeat visit rate) hebben altijd een zichtbare periodekiezer (deze maand/kwartaal/aangepast) — een KPI zonder duidelijke periode-context is een veelvoorkomende bron van misverstanden in dashboards, en wordt hier bewust vermeden.

---

## 3. Reporting model

```
Realtime-KPI's (goedkoop, direct van
denormalized cache-velden — Module 1/3's
eigen ontwerp maakt dit al mogelijk):
  Leden, Outstanding credit, At Risk, VIP
        │
        ▼
Periodieke/aggregatie-KPI's (te zwaar om
live te berekenen bij elke dashboardweergave):
  Loyalty omzet, repeat visit rate, credit-
  analytics, cohort-analyse, campagne-ROI-
  ranglijsten
        │
        ▼
analytics_snapshots — dagelijks (of vaker)
herberekend per organisatie/locatie/periode,
zelfde denormalisatie-principe als elders
in het platform (Module 2/5/9's *_snapshots-
tabellen)
```

### `analytics_snapshots`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID | |
| `locationId` | UUID, nullable | `null` = organisatiebreed |
| `snapshotDate` | date | |
| `periodType` | enum | `daily`, `monthly` |
| `memberCount` | integer | |
| `newMembersInPeriod` | integer | |
| `loyaltyRevenue` | decimal(10,2) | |
| `averageSpend` | decimal(10,2) | |
| `repeatVisitRate` | decimal(5,2) | |
| `outstandingCredit` | decimal(10,2) | |
| `creditExpiringSoon` | decimal(10,2) | |
| `atRiskCount` | integer | |
| `vipCount` | integer | |
| `creditIssued` / `creditRedeemed` / `creditExpired` | decimal(10,2) | sectie 7 |
| `computedAt` | timestamp | |

---

## 4. Attribution

Deze module **verzint geen nieuwe attributiemechaniek** — ze hergebruikt en aggregeert wat al bestaat:
- Module 5's campagne-attributie (controlegroep-gebaseerde incrementele omzet)
- Module 8's journey-attributie (`journeyId`-referenties op transacties/rewards)
- Module 9's occupancy-attributie (forecast vs. actual)

De toegevoegde waarde hier is **cross-campagne/journey-vergelijking**: welke van al deze losse attributiemetingen presteert het best, geaggregeerd in één ranglijst (sectie 8).

---

## 5. Cohort analysis

Een cohort = alle klanten met hetzelfde eerste-bezoek-maand. Cohort-retentie toont hoeveel procent van elke cohort nog steeds actief is, maand na maand na hun eerste bezoek.

```
┌─────────────────────────────────────────────────┐
│  Cohort-retentie                                     │
├─────────────────────────────────────────────────┤
│           Maand 0  Maand 1  Maand 2  Maand 3           │
│  Jan '26   100%     42%      31%      28%                 │
│  Feb '26   100%     38%      29%      —                     │
│  Mrt '26   100%     45%      —        —                       │
└─────────────────────────────────────────────────┘
```

### `cohort_retention_snapshots`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID | |
| `cohortMonth` | date | eerste dag van de cohort-maand |
| `monthsSinceCohort` | integer | `0`, `1`, `2`, ... |
| `cohortSize` | integer | oorspronkelijke grootte |
| `activeCount` | integer | hoeveel daarvan nog een transactie hadden in deze maand |
| `retentionPercentage` | decimal(5,2) | |
| `computedAt` | timestamp | |

**Gebruik:** direct het antwoord op "waarom daalt repeat visit?" (sectie 10-voorbeeld) — als recente cohorts een lagere maand-1-retentie tonen dan oudere cohorts, wijst dat op een probleem met de eerste-bezoek-ervaring of de Welcome-journey (Module 8), niet op een probleem met bestaande klanten.

---

## 6. Customer analytics

- **Retention** — sectie 5
- **Visit frequency** — verdeling van `customers.averageVisitFrequencyDays` (Module 1), getoond als histogram
- **Average spend** — verdeeld per tier/segment
- **Lifetime value (LTV)** — `customers.lifetimeSpend`, met een eenvoudige voorspelde LTV (`averageSpend × verwacht aantal toekomstige bezoeken op basis van huidige cadans`, hetzelfde soort trendmatige projectie als Module 9's forecastmodel — bewust geen zwaar ML-model in deze fase)
- **Tier performance** — omzet/frequentie/retentie per tier, laat zien of een hoger tier daadwerkelijk ander gedrag oplevert
- **Location performance** — sectie 9

---

## 7. Credit analytics

| Metric | Formule |
|---|---|
| **Issued** | `SOM(wallet_ledger_entries.amount) WHERE entryType IN ('earn','bonus','campaign_bonus')` |
| **Redeemed** | `SOM(amount) WHERE entryType = 'redeem'` |
| **Outstanding** | `SOM(remainingAmount) WHERE status = 'available'` |
| **Expired** | `SOM(amount) WHERE entryType = 'expiration'` |
| **Redemption percentage** | `Redeemed / Issued` |
| **Breakage** | `Expired / Issued` — het percentage verdiend tegoed dat nooit is besteed; een standaardbegrip in loyaltyprogramma's, hier voor het eerst expliciet als KPI |
| **Liability** | `Outstanding` — dezelfde waarde als "outstanding", maar getoond in een financiële context: dit is het bedrag waarvoor de organisatie een toekomstige verplichting heeft |

Deze cijfers komen **rechtstreeks** uit Module 3's ledger — geen aparte boekhouding, exact het principe "één bron van waarheid" dat door het hele platform is volgehouden.

---

## 8. Campaign analytics

Aggregatie over alle `campaign_metrics_snapshots` (Module 5) plus journey-resultaten (Module 8) en occupancy-attributie (Module 9), in één vergelijkbare ranglijst:

```
┌─────────────────────────────────────────────────┐
│  Campagnes — gerangschikt op ROI                     │
├─────────────────────────────────────────────────┤
│  1. Win Back           ROI 3,4×   Omzet €4.280           │
│  2. Sunny Lunch Booster ROI 2,8×   Omzet €2.140            │
│  3. Double Credit       ROI 1,2×   Omzet €6.900              │
│  4. Cocktail Hour       ROI 0,4×   Omzet €890  ⚠ Lage ROI       │
└─────────────────────────────────────────────────┘
```

Directe input voor de AI-assistent-vraag "welke campagne gaf de beste ROI?" (sectie 10).

---

## 9. Location comparison

Dezelfde KPI-set als het hoofddashboard (sectie 1-2), maar naast elkaar per locatie:

```
┌─────────────────────────────────────────────────┐
│                Noordwijk    Scheveningen   Leiden      │
├─────────────────────────────────────────────────┤
│  Leden           620           412           252            │
│  Repeat visit    42%           35%           31%              │
│  Gem. besteding  €94           €81           €76                │
│  Outstanding     €8.200        €5.100        €5.120                │
└─────────────────────────────────────────────────┘
```

Nuttig voor organisaties met meerdere locaties (basisprincipe van het platform vanaf het begin) om te zien welke locatie het loyaltyprogramma het best benut.

---

## 10. AI architecture

```
Manager typt een vraag in natuurlijke taal
("Morgen slecht weer, lunch staat maar 30% vol.
Wat kunnen we doen?")
        │
        ▼
AI Assistant Service ontvangt de vraag
        │
        ▼
LLM bepaalt welke tools (sectie 11) nodig zijn
om de vraag te beantwoorden — bv. hier:
getOccupancyForecast(), getSegmentCount(filter)
        │
        ▼
Tools worden daadwerkelijk aangeroepen tegen
ECHTE platform-endpoints (Module 9's forecast-
API, Module 7's segment-preview-API, etc.)
— NOOIT verzonnen cijfers
        │
        ▼
LLM formuleert een antwoord GEBASEERD OP de
tool-resultaten, met de ruwe cijfers zichtbaar
meegegeven (sectie 16 — explainability)
        │
        ▼
Als het antwoord een campagnevoorstel bevat:
        │
        ▼
ai_campaign_suggestions-rij aangemaakt,
status: 'pending_approval' — EXACT hetzelfde
patroon als Module 9's occupancy_recommendations
(recommendation, geen campagne)
        │
        ▼
Manager ziet het antwoord + een "Start
campaign"-knop die NAAR Module 5 leidt
(draft-campagne, net als Module 9 sectie 8)
— nooit een automatische lancering
```

**Kernregel, letterlijk uit de opdracht:** *"AI mag de campagne nooit zonder toestemming starten tenzij daar later expliciet een bevoegde automationregel voor bestaat."* Dit betekent: de huidige architectuur staat **geen** autonome uitvoering toe; een toekomstige, apart in te stellen "automation rule" (buiten de scope van dit ontwerp, expliciet benoemd als toekomstige uitbreiding in sectie 20) zou dat ooit kunnen veranderen, maar alleen als een aparte, bewuste, door een Organization Admin geconfigureerde regel — nooit als impliciet gedrag van de AI zelf.

---

## 11. AI tools/functions

Elke tool is een **directe wrapper om een bestaand, echt platform-endpoint** — de AI kan niets opvragen dat niet al via de normale API bestaat, en niets verzinnen wat niet uit een tool-resultaat komt.

| Tool | Roept aan | Gebruikt voor |
|---|---|---|
| `getOccupancyForecast(locationId, date)` | Module 9 `GET .../occupancy/forecast` | "Lunch staat maar 30% vol" |
| `getHistoricalOccupancy(locationId, dayOfWeek)` | Module 9 (historische basis) | "Normal Thursday: 56%" |
| `getSegmentPreview(filterDefinition)` | Module 7 `POST .../segments/preview` | Doelgroepgrootte + criteria |
| `getChurnRiskCustomers(threshold)` | Module 7 `GET .../churn-risk` (geaggregeerd) | "Welke groep dreigen we te verliezen?" |
| `getCampaignRoiRanking(period)` | Module 5 (sectie 8 hierboven) | "Welke campagne gaf de beste ROI?" |
| `getCreditLiability()` | Module 3 (sectie 7 hierboven) | "Hoeveel tegoed verloopt binnenkort?" |
| `getCohortRetention()` | Sectie 5 | "Waarom daalt repeat visit?" |
| `getLocationPerformance()` | Sectie 9 | Locatievergelijking |
| `getVipCustomers(inactiveDays)` | Module 1/7 | "Welke VIP's zijn al lang niet geweest?" |
| `simulateIncentive(percentage, audienceFilter)` | Module 4's Rule Simulator | "Welk incentivepercentage lijkt rendabel?" |
| `proposeCampaign(name, audienceFilter, incentive, message)` | **Schrijft** een `ai_campaign_suggestions`-rij (geen externe aanroep — dit is de enige tool die iets aanmaakt, en het aangemaakte object is altijd `pending_approval`, nooit actief) | Het "Start campaign"-voorstel |

**Alle tools behalve `proposeCampaign` zijn read-only.** Dit is een bewuste architecturale grens: de AI kan overal "lezen", maar "schrijven" doet ze uitsluitend via één enkele, altijd-goedkeuring-vereisende actie.

---

## 12. Prompt architecture

```
Systeemprompt bevat (niet uitputtend):
- "Gebruik ALTIJD een tool om cijfers op te
  halen — noem nooit een getal dat niet uit
  een tool-resultaat komt"
- "Als een tool geen of onvoldoende data
  teruggeeft, zeg dat expliciet — verzin
  geen plausibel klinkend antwoord"
- "Incentive-voorstellen moeten binnen de
  organisatie-ingestelde grenzen blijven
  (dezelfde occupancy_incentive_policy-
  achtige configuratie als Module 9 sectie 7)
  — jij kiest nooit vrij een percentage"
- "Toon altijd de onderliggende cijfers naast
  je conclusie, niet alleen de conclusie"
- "Jij start nooit zelf een campagne — je
  stelt hoogstens voor"
        │
        ▼
Elke conversatie wordt volledig gelogd
(sectie 16) — vraag, welke tools zijn
aangeroepen met welke parameters, wat de
tools teruggaven, en het uiteindelijke
antwoord
```

### `ai_assistant_conversations` / `ai_assistant_messages` / `ai_tool_calls`

| Tabel | Kernvelden |
|---|---|
| `ai_assistant_conversations` | `id`, `organizationId`, `userId`, `startedAt` |
| `ai_assistant_messages` | `id`, `conversationId`, `role` (`user`/`assistant`), `content`, `createdAt` |
| `ai_tool_calls` | `id`, `messageId`, `toolName`, `parameters` (jsonb), `result` (jsonb), `calledAt` |

---

## 13. Permissions

| Rol | Rechten |
|---|---|
| **Organization Admin** | Volledige toegang tot dashboard, alle detailanalyses, AI-assistent, en goedkeuringsbevoegdheid voor AI-voorstellen |
| **Location Manager** | Dashboard/analyses beperkt tot eigen locatie(s); AI-assistent bruikbaar, voorstellen voor eigen locatie kunnen zelf goedkeuren binnen dezelfde drempels als Module 5's approval-beleid (sectie 9 van dat ontwerp) |
| **Marketing** | Volledige analytics-toegang organisatiebreed, AI-assistent bruikbaar, geen goedkeuringsbevoegdheid boven de drempel (consistent met Module 5) |
| **Staff** | Geen toegang tot dit dashboard — analytics is een management-functie |

Permissie-primitieven: `analytics.read`, `analytics.read.own_location`, `ai_assistant.use`, `ai_campaign_suggestion.approve`.

---

## 14. Guardrails

- **Harde caps zijn nooit AI-bepaald** — elk incentive-voorstel wordt getoetst aan dezelfde organisatie-ingestelde grenzen als Module 9's `occupancy_incentive_policy` (bv. "nooit meer dan €10 bonus, nooit meer dan 3× multiplier zonder Admin-goedkeuring").
- **Rate-limiting op AI-voorstellen** — maximaal N nieuwe `ai_campaign_suggestions` per dag per organisatie, om te voorkomen dat een overijverige AI (of een manager die de assistent herhaaldelijk dezelfde vraag stelt) het voorstellenoverzicht laat overstromen.
- **Alleen-lezen tools kunnen niet per ongeluk schrijven** — technisch afgedwongen op API-niveau (de tool-implementaties roepen uitsluitend `GET`/preview-achtige endpoints aan), niet alleen als prompt-instructie.
- **Tenant-isolatie** — elke tool-aanroep is impliciet gescoped aan de organisatie van de manager die de vraag stelt; de AI kan nooit data van een andere organisatie zien of erover praten, ongeacht hoe de vraag geformuleerd is.
- **Geen scenario waarin de AI direct op de betaalinfrastructuur/wallet-ledger kan schrijven** — `proposeCampaign` is de enige schrijfactie, en die schrijft een voorstel, nooit een ledger-mutatie.

---

## 15. Approval flow

Identiek aan Module 9 sectie 8, hier kort herhaald met de AI-specifieke bron:

```
ai_campaign_suggestions (status: pending_approval)
        │
        ▼
Manager bekijkt het voorstel + de onderliggende
tool-resultaten (sectie 16)
        │
   ┌────┴─────┐
Goedkeuren    Afwijzen
   │           │
   ▼           ▼
Module 5-    status → 'dismissed'
draft-
campagne
aangemaakt,
status →
'approved'
   │
   ▼
Manager gaat naar Module 5, doorloopt de
preview, klikt zelf op "Launch" — APARTE,
bewuste actie
```

### `ai_campaign_suggestions`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID | |
| `conversationId` | UUID (FK) | de conversatie waaruit dit voortkwam |
| `suggestedName` | varchar | |
| `audienceFilter` | jsonb | |
| `audienceCount` | integer | |
| `incentiveType` | enum | zelfde als Module 5 |
| `incentiveValue` | jsonb | |
| `suggestedMessage` | text | |
| `estimatedMaxExposure` | decimal(10,2) | |
| `underlyingDataSnapshot` | jsonb | **alle** tool-resultaten die tot dit voorstel leidden, bewaard zodat het voorstel ook later nog volledig te verklaren is, ook als de onderliggende live-cijfers inmiddels zijn veranderd |
| `status` | enum | `pending_approval`, `approved`, `dismissed`, `expired` |
| `reviewedByUserId` | UUID, nullable | |
| `resultingCampaignId` | UUID, nullable | |
| `createdAt` | timestamp | |

---

## 16. Explainability

**Elk AI-antwoord toont de onderliggende data expliciet, niet alleen de conclusie** — dit is geen los "extra" scherm, maar standaard onderdeel van het antwoord zelf:

```
┌─────────────────────────────────────────────────┐
│  AI Assistant                                         │
├─────────────────────────────────────────────────┤
│  Jij: Morgen slecht weer, lunch staat maar 30% vol.       │
│  Wat kunnen we doen?                                        │
│                                                                 │
│  AI: Opportunity detected                                        │
│                                                                     │
│  Lunch occupancy morgen:     31%                                    │
│  Normale donderdag:          56%                                      │
│  Gap:                        25 procentpunt                             │
│                                                                              │
│  Aanbevolen doelgroep:       412 klanten                                     │
│  Criteria:                                                                     │
│  - lunch-bezoek in afgelopen 90 dagen                                            │
│  - geen bezoek laatste 21 dagen                                                    │
│  - marketing-consent                                                                 │
│  - binnen geselecteerde regio                                                          │
│                                                                                            │
│  Aanbevolen incentive: €7,50 bonus bij besteding vanaf €50                                  │
│  Geschatte max. exposure: €3.090                                                               │
│                                                                                                    │
│  Voorgestelde push:                                                                                 │
│  "🌧 Geen strandweer? Binnen maken we het gezellig.                                                    │
│  Lunch morgen en ontvang €7,50 extra Beach Credit bij                                                    │
│  een besteding vanaf €50."                                                                                 │
│                                                                                                                │
│  [ Bekijk brongegevens ]         [ Afwijzen ]    [ Start campaign → ]                                          │
└─────────────────────────────────────────────────┘
```

**"Bekijk brongegevens"** toont de ruwe `ai_tool_calls`-resultaten die tot dit antwoord leidden — exact getraceerd, net als Module 4's calculation trace en Module 9's `factorsUsed`. Dit is hetzelfde platformbrede principe consequent doorgevoerd: **elk berekend/voorgesteld getal moet herleidbaar zijn tot zijn bron**, of het nu een reward-bedrag is (Module 4), een forecast (Module 9), of een AI-advies (hier).

---

## 17. Data privacy

- **Aggregaat boven individueel:** AI-tools retourneren standaard geaggregeerde cijfers (aantallen, percentages, sommen) — nooit ruwe lijsten met namen/contactgegevens, tenzij de manager expliciet doorklikt naar een onderliggend, apart-gepermissioneerd scherm (bv. Module 7's ledenlijst-export, met zijn eigen audit-log).
- **Consent-filtering werkt door:** elke `getSegmentPreview`/`getVipCustomers`-tool-aanroep respecteert automatisch Module 1's profiling-consent-regels (Module 7 sectie 16) — de AI ziet nooit een groter of vollediger beeld dan een manager via de normale UI zou zien.
- **Geen PII naar de externe LLM-provider tenzij noodzakelijk:** waar mogelijk worden geaggregeerde cijfers (bv. "412 klanten") aan het taalmodel doorgegeven in plaats van individuele klantgegevens — een vraag als "welke VIP's zijn lang niet geweest" kan beantwoord worden met aantallen en globale kenmerken zonder namen te hoeven noemen, tenzij de manager expliciet om een naamlijst vraagt (die dan via een apart, audit-gelogd pad loopt, niet via de open LLM-conversatie).
- **Conversatie-logging (sectie 12) valt onder dezelfde bewaartermijnen en toegangsregels als de rest van het platform's audit-infrastructuur.**

---

## 18. Suggestiesysteem

Naast **reactief** (manager stelt een vraag) ondersteunt deze module ook **proactieve** signalering — vergelijkbaar met Module 9's opportunity-detectie, maar breder dan alleen bezettingsgraad:

```
Periodieke job (bv. dagelijks) scant op
opvallende patronen:
        │
        ├─► Repeat visit rate deze maand >5
        │   procentpunt lager dan vorige maand
        │
        ├─► Een campagne presteert opvallend
        │   slecht (ROI < 0,5×, sectie 8)
        │
        ├─► Het aantal At Risk-klanten is
        │   sterk gestegen
        │
        └─► Credit-liability nadert een
            organisatie-ingestelde
            waarschuwingsdrempel
        │
        ▼
proactive_insights-rij aangemaakt, zichtbaar
op het dashboard (niet opdringerig — een klein
"3 inzichten deze week"-badge, geen pop-up)
```

### `proactive_insights`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID | |
| `insightType` | varchar | bv. `repeat_visit_decline`, `underperforming_campaign` |
| `summary` | text | |
| `underlyingDataSnapshot` | jsonb | zelfde principe als sectie 15/16 |
| `severity` | enum | `info`, `attention`, `warning` |
| `dismissedAt` | timestamp, nullable | |
| `createdAt` | timestamp | |

---

## 19. Forecasting

Op analytics-niveau (in tegenstelling tot Module 9's bezettingsgraad-forecast) betreft dit vooral **trendmatige projecties** van de hoofd-KPI's: ledenaantal-groei, verwachte omzet komende maand, verwachte credit-liability-ontwikkeling — berekend met hetzelfde soort eenvoudige, uitbreidbare model als Module 9 (historisch gemiddelde + trendlijn, met een `modelVersion`-veld dat later ML mogelijk maakt zonder de rest van het platform te raken).

```
┌─────────────────────────────────────────────────┐
│  Verwachting komende maand                            │
├─────────────────────────────────────────────────┤
│  Leden:            1.284 → ~1.340 (op basis van             │
│                    huidige aanwastrend)                       │
│  Loyalty omzet:     €42.380 → ~€44.100                           │
│  Credit-liability:   €18.420 → ~€19.800                             │
└─────────────────────────────────────────────────┘
```

---

## 20. Toekomstige uitbreidingen

- **Autonome campagne-uitvoering via expliciete automationregels** — zoals in sectie 10 vermeld: een apart, door een Organization Admin bewust ingesteld mechanisme ("als opportunity X en Y, start automatisch campagne Z binnen deze grenzen") — een grote architecturale stap, met eigen goedkeurings-/audit-eisen, bewust buiten de scope van dit ontwerp.
- **Cross-organisatie benchmarking** (geanonimiseerd, "jouw repeat visit rate vs. vergelijkbare horecabedrijven") — vereist zorgvuldige privacy-architectuur, niet triviaal binnen de huidige strikte tenant-isolatie.
- **ML-gebaseerde forecasting**, zoals al voorbereid via het `modelVersion`-patroon in Module 9 en hier in sectie 19.
- **Predictieve churn-interventie** — in plaats van alleen Module 7's churn-score te tonen, proactief een gepersonaliseerde interventie voorstellen per At Risk-klant (nog steeds met verplichte goedkeuring).
- **Meertalige AI-assistent** — voor internationale horecagroepen, aansluitend op Module 1's bestaande taal-/lokalisatie-architectuur.

---

## Voorstel implementatievolgorde

1. **Fase 1 — Kerndashboard + KPI-definities:** sectie 1-3, met de realtime-KPI's eerst (goedkoop) en de periodieke `analytics_snapshots`-job daarna.
2. **Fase 2 — Credit- en campagne-analytics:** sectie 7-8, direct herbruikbaar uit bestaande Module 3/5-data.
3. **Fase 3 — Cohort- en klantanalyse:** sectie 5-6, iets zwaardere aggregaties.
4. **Fase 4 — Locatievergelijking:** sectie 9, relatief eenvoudige uitbreiding van fase 1-3.
5. **Fase 5 — AI-tools (read-only):** sectie 11, elk tool een dunne wrapper — kan grotendeels parallel aan fase 2-4 gebouwd worden zodra de onderliggende endpoints bestaan.
6. **Fase 6 — AI-conversatie-engine + explainability-logging:** sectie 10, 12, 16 — de kern van de assistent-ervaring.
7. **Fase 7 — `proposeCampaign` + approval flow:** sectie 15, de meest gevoelige fase (financiële/marge-impact), zorgvuldig na fase 5-6.
8. **Fase 8 — Suggestiesysteem (proactief):** sectie 18, bouwt voort op alles ervoor.
9. **Fase 9 — Forecasting:** sectie 19, kan relatief laat, geen blokkerende afhankelijkheid voor de rest.

---

Wil je dat we hierna de database-migratie voor Module 10 bouwen en testen, zoals bij de vorige modules — en daarmee alle tien kernmodules van het platform compleet maken?
