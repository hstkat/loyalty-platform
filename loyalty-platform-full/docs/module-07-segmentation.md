# Module 7 — Segmentation Engine

> Onderdeel van het horeca/hospitality loyaltyplatform. Deze module vervangt de lichtgewicht audience-filter die Module 5 (Campaign Manager) tijdelijk zelf definieerde — vanaf nu is dit de centrale, herbruikbare plek voor doelgroepdefinities, geraadpleegd door Module 5, Module 6, Module 8 (Journeys) en toekomstige Analytics-behoeften.

---

## 1. Segment datamodel

```
organizations
    │
    └── segments ──────────────────────┐
            │                           │
            ├── segment_membership       │ (materialized cache, sectie 10)
            └── definition (jsonb,        │
                boomstructuur, sectie 2)   │
                                            │
customers (Module 1) ◄─────────────────────┘

churn_risk_scores (sectie 11, los van segments zelf,
maar de bron voor het "At Risk"-standaardsegment)
```

### `segments`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID (FK) | |
| `name` | varchar | |
| `description` | text, nullable | |
| `segmentType` | enum | `standard` (platform-voorgedefinieerd, aanpasbaar), `custom` (door een manager gebouwd) |
| `definition` | jsonb | de AND/OR-boomstructuur, sectie 2 |
| `evaluationMode` | enum | `realtime`, `cached` — bepaalt sectie 6/10 |
| `refreshFrequency` | enum, nullable | `realtime`, `hourly`, `daily` — alleen relevant bij `cached` |
| `isPinned` | boolean | favoriet/veelgebruikt, sectie 12 |
| `lastComputedAt` | timestamp, nullable | |
| `lastComputedCount` | integer, nullable | denormalized, sectie 8 |
| `createdByUserId` | UUID, nullable | |
| `createdAt` / `updatedAt` | timestamp | |

---

## 2. Rule builder

Een segment-definitie is een **boomstructuur** van condities en subgroepen, opgeslagen als jsonb — dit is precies wat een niet-technische manager via een visuele AND/OR-builder samenstelt, zonder ooit SQL te zien.

```json
{
  "combinator": "AND",
  "conditions": [
    { "field": "lifetimeSpend", "operator": "gt", "value": 1000 },
    { "field": "daysSinceLastVisit", "operator": "gt", "value": 30 },
    { "field": "creditBalance", "operator": "gt", "value": 10 }
  ],
  "groups": []
}
```

**Visuele weergave (Segment Builder-scherm):**
```
┌─────────────────────────────────────────────────────┐
│  Nieuw segment                                           │
├─────────────────────────────────────────────────────┤
│  Voldoe aan  [ ALLE ▾ ]  van de volgende voorwaarden:       │
│                                                             │
│  [ Lifetime spend ▾ ] [ is meer dan ▾ ] [ €1.000    ]  [×]   │
│  [ Laatste bezoek  ▾ ] [ meer dan ▾ ]   [ 30 dagen geleden] [×]│
│  [ Credit balance  ▾ ] [ is meer dan ▾ ] [ €10       ]  [×]    │
│                                                                  │
│  [ + Voorwaarde toevoegen ]   [ + Groep toevoegen (nested) ]      │
│                                                                       │
│  Resultaat: 284 klanten          [ Bekijk voorbeeld ]  [ Opslaan ]     │
└─────────────────────────────────────────────────────┘
```

---

## 3. Operators

Operatoren zijn afhankelijk van het veldtype, zodat de UI nooit een onzinnige combinatie aanbiedt (bv. geen "bevat" op een getal):

| Veldtype | Beschikbare operatoren |
|---|---|
| Getal (bedrag, aantal) | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between` |
| Datum/leeftijd-in-dagen | `gt`, `gte`, `lt`, `lte`, `between`, `withinLastDays`, `olderThanDays`, `isUpcoming` (bv. verjaardag binnen X dagen) |
| Tekst/enum (tier, taal, regio) | `eq`, `neq`, `in`, `notIn` |
| Boolean/aanwezigheid | `isTrue`, `isFalse`, `isNull`, `isNotNull` |
| Lijst-achtig (tags, bezochte categorieën) | `contains`, `containsAny`, `containsAll`, `notContains` |

Elke conditie in de boomstructuur ziet er zo uit: `{ field, operator, value }`. De beschikbare `field`-waarden komen uit sectie 5 hieronder.

---

## 4. AND/OR

Elke groep in de boomstructuur heeft een `combinator`: `AND` of `OR`, van toepassing op **alle** condities en subgroepen binnen die groep. Dit is de directe implementatie van het voorbeeld uit de opdracht:

```json
{
  "combinator": "AND",
  "conditions": [
    { "field": "lifetimeSpend", "operator": "gt", "value": 1000 },
    { "field": "daysSinceLastVisit", "operator": "gt", "value": 30 },
    { "field": "creditBalance", "operator": "gt", "value": 10 }
  ]
}
```
→ "ALLE: Lifetime spend > €1.000 AND Last visit > 30 dagen AND Credit balance > €10" — resultaat 284 klanten, exact zoals in de opdracht.

---

## 5. Nested logic

Groepen kunnen andere groepen bevatten, tot een redelijke diepte (bv. maximaal 3 niveaus, om de UI en de query-generator behapbaar te houden):

```json
{
  "combinator": "AND",
  "conditions": [
    { "field": "tier", "operator": "eq", "value": "gold" }
  ],
  "groups": [
    {
      "combinator": "OR",
      "conditions": [
        { "field": "favoriteVisitDay", "operator": "eq", "value": "saturday" },
        { "field": "favoriteVisitDay", "operator": "eq", "value": "sunday" }
      ]
    }
  ]
}
```
→ "Gold-leden EN (favoriete dag = zaterdag OF favoriete dag = zondag)" — dit is "Weekend Guest, maar alleen Gold" als voorbeeld van hoe nesting standaardsegmenten combineerbaar maakt met extra voorwaarden.

**UX voor nesting:** de "+ Groep toevoegen"-knop uit sectie 2 voegt visueel een ingesprongen sub-blok toe met zijn eigen AND/OR-schakelaar — een manager hoeft de JSON-structuur nooit te zien, alleen geneste kaders.

---

## 6. Realtime vs. batch

Niet elk veld is even goedkoop te bevragen. De module maakt dit onderscheid **automatisch**, niet als keuze die een manager hoeft te maken:

| Veldcategorie | Voorbeeld | Modus |
|---|---|---|
| Direct op `customers`/`wallets` (denormalized, geïndexeerd) | tier, lifetime spend, credit balance, days since last visit | **Realtime** — query rechtstreeks op Module 1/3's cache-velden, geen voorberekening nodig |
| Aggregatie over transacties/reserveringen | "besteedde ooit aan cocktails", "gemiddelde partygrootte" | **Batch** — vereist een scan/aggregatie die te zwaar is om bij elke segment-preview live te draaien |
| Model-gebaseerd | churn risk (At Risk, sectie 11) | **Batch**, altijd — het risico wordt door een achtergrondjob berekend, nooit live |
| Communicatiegedrag (Module 6) | "opende laatste campagne-e-mail" | **Batch** — vereist een join over `message_events`, periodiek herberekend |

**Een segment als geheel is `realtime` als ál zijn condities in de realtime-categorie vallen; zodra één conditie een batch-veld gebruikt, wordt het hele segment `cached`.** Dit is geen technisch detail dat verstopt wordt — de Segment Builder toont het expliciet: *"Dit segment wordt elke nacht bijgewerkt"* versus *"Dit segment is altijd actueel"*.

---

## 7. Segment preview

```
Manager past de builder aan (voorwaarde toegevoegd/gewijzigd)
        │
        ▼
Debounced live-aanroep (bv. 500ms na laatste wijziging)
naar GET .../segments/preview met de conceptdefinitie
        │
        ▼
Realtime-segment? → directe query, resultaat binnen
                     enkele honderden milliseconden
Batch-segment?     → gebruik de MEEST RECENTE cache
                     (sectie 10) als benadering, met een
                     label "gebaseerd op gegevens van
                     [tijdstip laatste berekening]" —
                     nooit een volledige herberekening
                     tijdens het intypen, dat zou de UI
                     onbruikbaar traag maken
        │
        ▼
Toon: aantal klanten + voorbeeldlijst (eerste 10, geen
volledige export vanuit dit scherm — dat is een aparte,
audit-gelogde actie)
```

---

## 8. Customer count

- **Realtime segmenten:** `COUNT(*)` als onderdeel van dezelfde query die ook de preview/audience ophaalt — geen apart veld nodig, altijd actueel.
- **Cached segmenten:** `segments.lastComputedCount`, bijgewerkt door de batch-job (sectie 10) — getoond met de laatst-berekend-tijdstip erbij, zodat er nooit een vals gevoel van "live" ontstaat.

---

## 9. Performance

- **Query-generator, geen dynamische SQL-string-concatenatie:** de boomstructuur wordt vertaald naar geparametriseerde Prisma/SQL `WHERE`-clausules — dit voorkomt zowel SQL-injectie als de noodzaak om elke mogelijke conditie-combinatie met de hand te schrijven.
- **Indexen op alle veelgebruikte realtime-velden:** `customers.lifetimeSpend`, `customers.lastVisitAt`, `wallets.availableBalance`, etc. — grotendeels al aanwezig dankzij Module 1/3's eigen ontwerp (die velden waren al geïndexeerd met het oog op precies dit soort filtering).
- **Batch-segmenten draaien buiten piekuren** (bv. 02:00-04:00), met een queue zodat niet alle cached segmenten van alle organisaties gelijktijdig herberekend worden.
- **Maximale nesting-diepte en een maximumaantal condities per segment** (bv. 20) — een harde grens, niet omdat het niet zou kunnen, maar om te voorkomen dat één segment de query-planner in de knoop laat raken.

---

## 10. Caching

### `segment_membership`

De materialized cache voor `cached`-segmenten (en optioneel ook voor realtime-segmenten, als leesoptimalisatie voor Module 5/6/8 die niet elke keer een volledige query willen draaien).

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `segmentId` | UUID (FK) | |
| `customerId` | UUID (FK) | |
| `matchedAt` | timestamp | wanneer deze klant voor het laatst is bevestigd als lid |

**Twee manieren van bijwerken, beide ondersteund:**

1. **Volledige herberekening** (batch-job, volgens `refreshFrequency`): draai de hele segmentquery opnieuw, vervang de volledige `segment_membership`-set voor dat segment.
2. **Incrementele, event-gedreven herevaluatie** (voor near-realtime gevoel zonder de kosten van een volledige herberekening): wanneer een relevant event binnenkomt (`transaction.completed`, `wallet.balance_changed`, etc.) voor klant X, wordt **alleen klant X** opnieuw tegen alle `cached`-segmenten geëvalueerd die van dat soort veld afhankelijk zijn — geen volledige tabel-scan, alleen een gerichte check.

**Segment-mutatie-events (sectie 15) ontstaan uit het verschil tussen de oude en nieuwe `segment_membership`-set** — dit is hoe "klant betreedt/verlaat een segment" gedetecteerd wordt, essentieel voor Module 8's toekomstige journey-triggers ("wanneer een klant 'At Risk' wordt, stuur een win-back-bericht").

---

## 11. Churn logic (At Risk)

**Geen vaste termijn — persoonlijke cadans als uitgangspunt**, precies zoals de opdracht vraagt.

```
Voor elke klant met voldoende geschiedenis
(customers.visitCount >= 2, zodat er een
zinvol gemiddelde is):
        │
        ▼
personal_cadence = customers.averageVisitFrequencyDays
(al aanwezig in Module 1's schema)
        │
        ▼
days_since_last_visit = nu − customers.lastVisitAt
        │
        ▼
risk_ratio = days_since_last_visit / personal_cadence
        │
        ▼
risk_ratio > 1,5?  →  At Risk (binaire vlag, voor
                       eenvoudige segmentatie)
        │
        ▼
churn_risk_score (continue schaal 0-100, voor
fijnmaziger gebruik dan alleen aan/uit):
  - basis: risk_ratio geschaald (bv. ratio 1,0 → score 30,
    ratio 2,0 → score 70, ratio 3,0+ → score 95, met een
    sigmoïde-achtige curve zodat het niet lineair
    ontspoort bij extreme uitschieters)
  - trend-correctie: als de laatste 3 bezoekintervallen
    van deze klant een oplopende trend tonen (elk bezoek
    iets later dan verwacht), verhoogt dit de score verder
    — een klant die geleidelijk afhaakt is risicovoller
    dan een klant met van oudsher wisselende bezoekpatronen
        │
        ▼
Klanten ZONDER voldoende geschiedenis (< 2 bezoeken):
  fallback op een organisatie- of locatiebreed gemiddelde
  bezoekinterval (berekend over alle klanten met
  voldoende geschiedenis) in plaats van een individueel
  cijfer — een nieuwe klant krijgt zo nog steeds een
  zinvolle risico-inschatting, gebaseerd op wat "normaal"
  is voor deze organisatie, niet op een arbitraire
  platformbrede default
```

### `churn_risk_scores`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `customerId` | UUID (FK, uniek) | |
| `organizationId` | UUID | |
| `riskRatio` | decimal(6,2) | |
| `churnRiskScore` | integer | 0-100 |
| `isAtRisk` | boolean | `riskRatio > 1.5` (drempel organisatie-configureerbaar) |
| `basedOnPersonalCadence` | boolean | `false` als de fallback (organisatiegemiddelde) is gebruikt |
| `computedAt` | timestamp | |

**Waarom niet één vaste termijn (bv. altijd "35 dagen"):** een gast die normaliter elke 60 dagen komt en nu 50 dagen wegblijft, is *niet* zorgwekkend — hij zit nog binnen zijn eigen patroon. Een gast die normaliter elke 10 dagen komt en nu 20 dagen wegblijft, is dat wél, ook al is 20 dagen op zichzelf een kort tijdsbestek. Het voorbeeld uit de opdracht (elke 20 dagen, nu 35) resulteert in `risk_ratio = 1,75`, ruim boven de 1,5-drempel — precies het gedrag dat gevraagd werd, nu onderbouwd met een algoritme in plaats van een geharde constante.

Het `At Risk`-standaardsegment (sectie 13) is simpelweg: `{ field: "isAtRisk", operator: "isTrue" }` — een dun laagje bovenop deze uitgebreidere score, zodat een manager zowel de simpele aan/uit-versie kan gebruiken (voor segmentatie) als de genuanceerde score (voor toekomstige AI-prioritering, bv. "welke 20 At Risk-klanten hebben de hoogste kans om echt te vertrekken").

---

## 12. Saved segments

Elk segment is by design "opgeslagen" (het is een rij in `segments`, geen tijdelijke query). Extra comfort-features:
- **Pin/favoriet** (`isPinned`) — toont bovenaan het segmentoverzicht.
- **Dupliceren** — een manager kan een bestaand segment (eigen of standaard) kopiëren en aanpassen, zonder het origineel te wijzigen — vooral relevant voor standaardsegmenten (sectie 13), die je typisch als startpunt gebruikt.
- **Versiehistorie is bewust NIET uitgewerkt hier** (in tegenstelling tot Module 4's reward-regels) — een segmentdefinitie wijzigen heeft geen retroactieve financiële consequentie zoals een rewardregel dat heeft, dus de noodzaak tot strikte versiebeheer is hier lager. Wel wordt elke wijziging in het gedeelde `audit_log` vastgelegd (sectie 16).

---

## 13. Standard segments

Platform-voorgedefinieerd (net als Module 5's campagne-templates), per organisatie kopieerbaar en aanpasbaar — nooit hardcoded in applicatiecode, altijd als gewone `segments`-rijen met `segmentType: standard`:

| Segment | Definitie (vereenvoudigd) |
|---|---|
| **New** | `visitCount == 1` |
| **Returning** | `visitCount BETWEEN 2 AND 4` |
| **Regular** | `visitCount >= 5 AND daysSinceLastVisit <= 60` |
| **VIP** | `tier == "gold" OR lifetimeSpend > [organisatie-drempel]` |
| **High Spender** | `averageSpend > [organisatie-drempel, bv. 90e percentiel]` |
| **At Risk** | `isAtRisk == true` (sectie 11) |
| **Dormant** | `daysSinceLastVisit > (personalCadence × 3)` — een verdergevorderde versie van At Risk |
| **High Balance** | `creditBalance > [organisatie-drempel]` |
| **Credit Expiring** | `creditExpiringWithinDays <= 7` (rechtstreeks Module 3's expiratie-data) |
| **Birthday Soon** | `birthdayWithinDays <= 14` |
| **Lunch Guest** | `favoriteVisitTimeWindow overlapt met 12:00-15:00` (batch, vereist transactie-tijdstip-aggregatie) |
| **Dinner Guest** | idem, 18:00-22:00 |
| **Weekend Guest** | `favoriteVisitDay IN (saturday, sunday)` |
| **Cocktail Guest** | `heeft ooit product-categorie 'cocktails' besteld` (batch, Module 2's `transaction_line_items.category`) |

**Organisatie-specifieke drempels** (zoals "VIP" of "High Spender") zijn geen hardcoded getallen — ze worden bij het activeren van het standaardsegment automatisch voorgesteld op basis van de eigen klantverdeling van de organisatie (bv. 90e percentiel van lifetime spend), maar blijven aanpasbaar.

---

## 14. API

Basis: `/api/v1/organizations/{orgId}/segments`

| Methode | Endpoint | Omschrijving |
|---|---|---|
| `GET` | `/segments` | Lijst, filterbaar op `segmentType` |
| `POST` | `/segments` | Nieuw segment aanmaken |
| `GET` | `/segments/{id}` | Detail inclusief definitie |
| `PATCH` | `/segments/{id}` | Bijwerken |
| `DELETE` | `/segments/{id}` | Verwijderen (zacht, met controle of het segment niet actief gebruikt wordt door een campagne/journey) |
| `POST` | `/segments/preview` | Sectie 7 — accepteert een conceptdefinitie zonder op te slaan |
| `GET` | `/segments/{id}/members` | Gepagineerde ledenlijst (uit cache of live) |
| `POST` | `/segments/{id}/recompute` | Handmatig een batch-segment forceren te herberekenen |
| `POST` | `/segments/{id}/duplicate` | Sectie 12 |
| `GET` | `/standard-segment-templates` | Sectie 13 |
| `GET` | `/customers/{customerId}/churn-risk` | Sectie 11, losse opvraging voor het klantprofielscherm |
| `GET` | `/fields` | Metadata: welke velden/operatoren beschikbaar zijn, voor de builder-UI om zichzelf op te bouwen (geen hardcoded frontend-lijst die kan verouderen) |

---

## 15. Events

**Publiceert:**
- `segment.customer_entered` — payload: `segmentId`, `customerId`. De directe trigger-bron voor Module 8's toekomstige journeys ("wanneer iemand 'At Risk' wordt...")
- `segment.customer_left`
- `segment.recomputed` — payload: `segmentId`, nieuwe `count`, `computedAt`

**Consumeert:** een brede set events van Module 1 (klant-profielwijzigingen), Module 2 (transacties), Module 3 (wallet-mutaties), Module 6 (message-engagement) — telkens om te bepalen of een incrementele herevaluatie nodig is (sectie 10). Dit is de meest "luisterende" module van het platform tot nu toe, wat inherent is aan haar rol: overal verandert iets dat relevant kan zijn voor wie in welk segment zit.

---

## 16. Privacy

- **Leeftijd, verjaardag, postcode/regio zijn alleen bruikbaar als segmentveld als de klant daarvoor toestemming heeft gegeven** — dit koppelt direct aan Module 1's `profiling`-consenttype (al aanwezig in dat schema, precies met dit doel ontworpen: "gebruik van klantdata voor geautomatiseerde segmentatie/targeting"). Een klant zonder profiling-consent wordt simpelweg nooit meegenomen in de telling voor een segment dat op zulke velden filtert, zonder dat dit ergens zichtbaar hoeft te "falen" — hij ontbreekt gewoon stilzwijgend uit die specifieke telling.
- **Segment-ledenlijsten zijn nooit vrij exporteerbaar** zonder een aparte, audit-gelogde actie (consistent met Module 1's `customer.export`-permissie) — het bekijken van "284 klanten" is iets anders dan het downloaden van hun namen en contactgegevens.
- **Geen segment op basis van gevoelige kenmerken** die niet in het datamodel voorkomen (geen etniciteit, gezondheid, seksuele geaardheid — dat soort velden bestaat simpelweg niet in Module 1's klantprofiel, dus kunnen ze ook nooit per ongeluk een segmentveld worden).
- **Churn-risicoscores zijn intern gebruikt voor retentie-doeleinden, nooit getoond aan de klant zelf** als een "u dreigt te vertrekken"-boodschap — dat zou een klant onnodig confronteren met een intern risicomodel; het model stuurt hoogstens een vriendelijke, contextuele actie (via Module 5/8), niet een expliciete risico-label.
- **Alle privacy-regels van Module 1 (recht op vergetelheid, dataminimalisatie) werken door in deze module**: een geanonimiseerde klant (Module 1 sectie 11) verdwijnt automatisch uit alle `segment_membership`-caches bij de eerstvolgende herberekening, en wordt bij een incrementele event-trigger direct verwijderd.

---

## Voorstel implementatievolgorde

1. **Fase 1 — Kernmodel + realtime segmenten:** `segments`, de query-generator voor AND/OR/nested condities op realtime-velden (sectie 1-5, 6 realtime-tak, 7-9). Dit dekt al een groot deel van de standaardsegmenten (New, Returning, VIP, High Balance, Weekend Guest).
2. **Fase 2 — Standaardsegmenten:** sectie 13, zodra fase 1 staat — snel te seeden.
3. **Fase 3 — Caching + batch-segmenten:** `segment_membership`, de batch-job, incrementele herevaluatie (sectie 6 batch-tak, 10). Nodig voor Dormant, Cocktail Guest, Lunch/Dinner Guest.
4. **Fase 4 — Churn-logica:** `churn_risk_scores`, het At Risk-algoritme (sectie 11) — functioneel onafhankelijk van de rest, kan parallel aan fase 2-3.
5. **Fase 5 — Events + incrementele herevaluatie:** sectie 15, essentieel zodra Module 8 (Journeys) er komt, niet blokkerend voor standalone segmentatiegebruik daarvoor.
6. **Fase 6 — Privacy-verfijning:** consent-filtering (sectie 16) — belangrijk genoeg om niet te lang uit te stellen, maar technisch een laag bovenop een al werkend systeem.

---

Wil je dat we hierna de database-migratie voor Module 7 bouwen en testen, zoals bij de vorige modules?
