# Module 5 — Campaign Manager

> Onderdeel van het horeca/hospitality loyaltyplatform. Bouwt voort op Module 1 (Customer & CRM), Module 4 (Reward Engine) en levert straks werk aan Module 6 (Messaging) en Module 7 (Segmentation, nog niet gebouwd). Deze module is waar een manager zonder marketingkennis in enkele minuten een actie als "Sunny Day" of "Double Credit" kan starten — met marge-bescherming en meetbaarheid als vaste onderdelen, niet als losse extra's.

**Belangrijke afhankelijkheid:** Module 7 (Segmentation) bestaat nog niet als aparte module. Deze module definieert daarom een **lichtgewicht, ingebouwde audience-filter** (sectie 5) die later kan worden vervangen door/gekoppeld aan een volwaardige segmentatie-engine, zonder dat het campagnemodel zelf hoeft te veranderen — hetzelfde soort vooruitdenkende ontkoppeling als bij eerdere modules (bv. Module 2's `source`-veld voor POS-providers).

---

## 1. Campaign data model

```
organizations
    │
    ├── campaign_templates (Sunny Day, Double Credit, ...)
    │
    └── campaigns ──────────────────────────┐
            │                                │
            ├── campaign_audience_snapshot   │
            ├── campaign_incentive            │ (1-op-1 of 1-op-weinig)
            ├── campaign_channels              │
            ├── campaign_budget_limits          │
            ├── campaign_schedule                │
            ├── campaign_recipients                │ (1 rij per gast x campagne)
            ├── campaign_control_group_members       │
            └── campaign_metrics_snapshots             │ (periodieke rapportage-cache)
                                                         │
reward_rules (Module 4) ◄───────────────────────────────┘
    (campaignId-veld, al aanwezig in Module 4's schema)
```

**Kernprincipe:** een campagne is **geen** eigen reward-rekenlogica — ze is een **orkestratielaag** bovenop bestaande bouwstenen: Module 4's `reward_rules`/multipliers voor de incentive, en (straks) Module 6 voor de verzending. Dit voorkomt dat rewardlogica op twee plekken in het platform zou bestaan.

---

## 2. Campaign lifecycle

```
        draft
          │
          ▼
   (optioneel) pending_approval ──── afgekeurd ──► draft (met feedback)
          │
          ▼ goedgekeurd / geen goedkeuring nodig
       scheduled
          │
          ▼ scheduled moment bereikt
        active
          │
     ┌────┼──────────────┐
     ▼    ▼               ▼
  paused  completed    budget/cap
   │      (periode      bereikt →
   │      voorbij of     automatisch
   │      eenmalige       'completed'
   │      run klaar)       (sectie 7)
   ▼
 (hervat) → active
   │
   ▼
 cancelled (permanent, vanuit elke
 actieve status behalve completed)
          │
          ▼
      archived (na een bewaartermijn,
      blijft leesbaar voor rapportage)
```

**Statussen:** `draft`, `pending_approval`, `scheduled`, `active`, `paused`, `completed`, `cancelled`, `archived`.

**Onderscheid pause vs. cancel:** `paused` is tijdelijk en omkeerbaar (bv. een manager merkt een fout op en wil eerst iets aanpassen) — reeds uitgereikte rewards blijven geldig, nieuwe uitreiking stopt. `cancelled` is definitief — ook hier blijven reeds uitgereikte rewards staan (nooit met terugwerkende kracht afpakken, consistent met Module 3's reversal-beleid), maar de campagne kan nooit meer hervat worden.

---

## 3. Builder UX

Acht stappen, exact zoals in de opdracht, ontworpen als wizard met een permanent zichtbare voortgangsbalk en de mogelijkheid om op elk moment terug te stappen zonder ingevoerde data te verliezen:

```
┌──────────────────────────────────────────────────────────┐
│  ① Doel → ② Doelgroep → ③ Incentive → ④ Moment →            │
│  ⑤ Kanalen → ⑥ Budget → ⑦ Preview → ⑧ Launch                │
└──────────────────────────────────────────────────────────┘
```

**Stap 1 — Doel.** Eenvoudige keuzelijst (geen vrij tekstveld — dit stuurt namelijk verstandige defaults in latere stappen):
`meer_bezoekers`, `lunch_vullen`, `slapende_gasten_activeren`, `credit_laten_inwisselen`, `omzet_verhogen`, `vip_event_vullen`. Elke keuze vult stap 2/3 alvast slim voor (bv. "slapende gasten activeren" selecteert automatisch het "Dormant"-filter in stap 2 en stelt een hoger incentive voor in stap 3).

**Stap 2 — Doelgroep.** Zie sectie 5.

**Stap 3 — Incentive.** Zie sectie 6.

**Stap 4 — Moment.** Zie sectie 8.

**Stap 5 — Kanalen.** Multi-select: push, Wallet, e-mail, SMS — met een live-tellertje per kanaal ("X van de Y geselecteerde gasten hebben push aanstaan", gebaseerd op Module 1's consent-data), zodat een manager meteen ziet als een kanaal weinig bereik heeft.

**Stap 6 — Budget en limieten.** Zie sectie 7.

**Stap 7 — Preview.** Zie sectie 10.

**Stap 8 — Launch.** Eén knop, met een laatste bevestigingsdialoog die de kernrisico's samenvat ("Deze campagne bereikt 624 gasten en kan tot €1.248 aan reward kosten. Doorgaan?").

**Ontwerpprincipe — "binnen enkele minuten", geconcretiseerd:** elke stap heeft een verstandige default die een manager gewoon kan overslaan door op "Volgende" te klikken. Een manager die alleen stap 1 (doel) en stap 8 (launch) actief invult, met de rest op default, moet een werkende campagne kunnen starten. Dit is precies waarom templates (sectie 4) bestaan: die slaan de hele wizard feitelijk over.

---

## 4. Templates

### `campaign_templates`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID, nullable | `null` = platform-brede standaardtemplate (Sunny Day etc. komen als voorgeladen platform-templates, door een organisatie te kopiëren/aan te passen) |
| `name` | varchar | bv. "Sunny Day" |
| `icon` | varchar | voor de UI-tegel |
| `defaultGoal` | enum | zie sectie 3 |
| `defaultAudienceFilter` | jsonb | vooraf ingevulde filter (sectie 5) |
| `defaultIncentiveType` | enum | zie sectie 6 |
| `defaultIncentiveValue` | jsonb | bv. `{"multiplier": 2}` of `{"flatBonus": 5}` |
| `defaultChannels` | jsonb | bv. `["push"]` |
| `defaultScheduleType` | enum | zie sectie 8 |
| `suggestedBudgetLimits` | jsonb | verstandige startwaarden, geen harde limiet |
| `createdAt` | timestamp | |

**Platform-standaardtemplates (vooraf geladen, `organizationId = null`):**

| Template | Doel | Standaard-incentive | Standaardkanaal |
|---|---|---|---|
| Sunny Day | Meer bezoekers | 2× credit tijdens lunch | Push |
| Rainy Day | Meer bezoekers | 1,5× credit | Push |
| Double Credit | Omzet verhogen | 2× credit | Push + Wallet |
| Quiet Tuesday | Lunch vullen | 2× credit op dinsdag | Push |
| Cocktail Hour | Omzet verhogen | 10% credit op cocktails (product rule, Module 4) | Push |
| Sunset Special | Omzet verhogen | Vaste €5 bonus bij besteding tijdens sunset-uren | Push |
| Last Minute Tables | Bezettingsgraad opvullen | Geen incentive (puur informatief bericht) | Push |
| Birthday Campaign | Meer bezoekers | €5 bonus | E-mail + push |
| Expiring Credit | Credit laten inwisselen | Geen incentive (herinnering) | Push + Wallet |
| Win Back | Slapende gasten activeren | 3× credit | E-mail + SMS |
| VIP Event | VIP-event vullen | Exclusieve toegang (geen credit-incentive) | E-mail |

**Eén-klik-start:** het aanklikken van een template opent de wizard **vooraf volledig ingevuld**, direct bij stap 7 (preview) — de manager hoeft dus letterlijk alleen te bevestigen, tenzij hij iets wil aanpassen (dan kan hij terug naar een eerdere stap).

---

## 5. Audiences

Omdat Module 7 (Segmentation) nog niet bestaat, definieert deze module een eigen, simpele filter-DSL — bewust ontworpen zodat hij later 1-op-1 vervangen kan worden door een verwijzing naar een volwaardig Module 7-segment, zonder het campagnemodel te breken.

### `campaign_audience_filter` (opgeslagen als jsonb op de campagne, geen aparte tabel)

```json
{
  "type": "filter",
  "conditions": [
    { "field": "lastVisitDaysAgo", "operator": "gt", "value": 30 },
    { "field": "tier", "operator": "eq", "value": "gold" },
    { "field": "locationId", "operator": "eq", "value": "<uuid>" },
    { "field": "availableCredit", "operator": "gt", "value": 0 },
    { "field": "creditExpiringWithinDays", "operator": "lte", "value": 7 }
  ],
  "combinator": "AND"
}
```

Ondersteunde velden (rechtstreeks uit Module 1's klantprofiel en Module 3's wallet, geen nieuwe databron nodig): `lastVisitDaysAgo`, `visitCount`, `tier`, `locationId`, `favoriteVisitDay`, `averageSpend`, `availableCredit`, `creditExpiringWithinDays`, `loyaltyStatus`, `tags` (Module 1's `customer_tags`).

**Twee audience-modi:**

1. **Snapshot (default, voor eenmalige/geplande campagnes):** bij launch wordt de filter één keer uitgevoerd, en het resultaat vastgelegd in `campaign_audience_snapshot` — zodat rapportage achteraf altijd verwijst naar wie *daadwerkelijk* is aangesproken, ook al verandert een gast nadien van tier.
2. **Dynamisch (voor recurring campagnes, sectie 8):** de filter wordt bij elke herhaling opnieuw uitgevoerd, met een eigen snapshot per run.

### `campaign_audience_snapshot`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `campaignId` | UUID (FK) | |
| `runNumber` | integer | `1` voor eenmalige campagnes, oplopend bij recurring |
| `customerId` | UUID (FK naar Module 1) | |
| `matchedAt` | timestamp | |
| `inControlGroup` | boolean | zie hieronder |

**Control groups:** bij het samenstellen van de snapshot kan een manager een percentage (bv. 10%) van de gematchte doelgroep aanwijzen als controlegroep — deze gasten worden **wel** meegeteld in de snapshot voor rapportagedoeleinden, maar krijgen **geen** incentive en **geen** bericht. Dit is wat "incremental revenue" (sectie 12) meetbaar maakt: het verschil in gedrag tussen de behandelde groep en de controlegroep.

---

## 6. Incentives

| Type | Werking | Koppeling naar Module 4 |
|---|---|---|
| `flat_bonus` | Vast bedrag (bv. €5) bij een gekwalificeerd bezoek binnen de campagneperiode | Maakt een `reward_rules`-rij aan met `bucket: flat_bonus`, `campaignId` gevuld |
| `multiplier` | 2×/3×/etc. credit | `reward_rules` met `bucket: multiplier`, `campaignId` gevuld — functioneel identiek aan de "Double Credit"-boost uit Module 4's ontwerp |
| `percentage_bonus` | Extra vast percentage bovenop de basisregel (bv. "10% credit" op cocktails) | `reward_rules` met `bucket: percentage`, `stackingMode: additive`, eventueel met `productCategories` gevuld voor product-specifieke campagnes zoals Cocktail Hour |
| `coupon` | Eenmalig inwisselbare korting/gratis product, **niet** via de creditledger | Aparte, lichte `campaign_coupons`-tabel (code, geldigheidsduur, gebruikt-vlag) — bewust buiten Module 3's ledger gehouden, want dit is geen tegoed maar een eenmalig recht |
| `none` | Puur informatief bericht (bv. Last Minute Tables, VIP Event) | Geen `reward_rules`-koppeling |

> **Ontwerpkeuze — audience-restrictie op een campagne-gekoppelde reward-regel:** Module 4's `reward_rules` kent van zichzelf geen "alleen voor deze specifieke gasten"-beperking (een regel geldt voor de hele organisatie/locatie). Voor campagne-incentives is dat een probleem: "Win Back" moet alleen voor de aangeschreven slapende gasten gelden, niet voor iedereen. **Oplossing:** de Reward Engine (Module 4) wordt uitgebreid met een optionele check — als een `reward_rule.campaignId` is gevuld, wordt bij de berekening gecontroleerd of de klant in de bijbehorende `campaign_audience_snapshot` voorkomt (en niet in de controlegroep zit) vóór de regel wordt toegepast. Dit is een **noodzakelijke, kleine uitbreiding op Module 4**, hier expliciet benoemd zodat hij niet vergeten wordt bij implementatie.

**Frequency cap ("1 keer per klant"):** geïmplementeerd als een veld op de campagne (`maxIncentivePerCustomer`, default `1`) dat bij de audience-restrictie-check hierboven wordt meegenomen — een klant die de incentive al heeft ontvangen binnen deze campagne, komt niet nogmaals in aanmerking, ook al voldoet hij nog aan de voorwaarden.

---

## 7. Budget controls

Vier limiet-typen, elk optioneel maar sterk aanbevolen (de UI waarschuwt bij een campagne zonder enige limiet):

| Limiet | Veld | Handhaving |
|---|---|---|
| **Max recipients** | `campaign_budget_limits.maxRecipients` | Audience-resolutie (sectie 5) stopt bij het bereiken van dit aantal — bij een grotere doelgroep wordt (configureerbaar) willekeurig of op prioriteit geselecteerd wie de eerste N zijn |
| **Max reward exposure** | `maxRewardExposure` | Het **potentiële maximum** — audience-grootte × maximale incentive per persoon — mag dit niet overschrijden; berekend vóór launch (preview, sectie 10) en geblokkeerd als het te hoog is |
| **Max redemption cost** | `maxRedemptionCost` | Het **daadwerkelijk bestede** bedrag (niet het toegekende, maar het door gasten ingewisselde deel — een subtiel maar belangrijk verschil, aansluitend op Module 3's "outstanding credit"-concept) wordt live gevolgd; bij overschrijding pauzeert de campagne automatisch |
| **Max per klant** | `maxIncentivePerCustomer` | Zie sectie 6 |

### `campaign_budget_limits`

| Veld | Type |
|---|---|
| `id` | UUID (PK) |
| `campaignId` | UUID (FK) |
| `maxRecipients` | integer, nullable |
| `maxRewardExposure` | decimal(10,2), nullable |
| `maxRedemptionCost` | decimal(10,2), nullable |
| `maxIncentivePerCustomer` | integer, default `1` |
| `currentRewardExposure` | decimal(10,2), default `0` — denormalized, bijgewerkt bij elke toegekende reward |
| `currentRedemptionCost` | decimal(10,2), default `0` — denormalized, bijgewerkt bij elke inwisseling (via Module 3's `wallet.balance_changed`-event, gefilterd op deze campagne) |

**Deze limieten zijn niet los van Module 4's eigen cap-mechanisme (sectie 6 van dat ontwerp) — ze zijn er een specialisatie van:** een campagne-incentive's onderliggende `reward_rule` krijgt automatisch een `maximumRewardPerTransaction` en wordt gekoppeld aan een campagnebudget dat functioneel identiek werkt aan Module 4's `reward_boosts.max_budget`. Geen dubbele budgetlogica, alleen een campagne-vriendelijke laag eromheen.

---

## 8. Scheduling

| Type | Werking |
|---|---|
| `direct` | Launch = onmiddellijke uitvoering |
| `datetime` | Eenmalige uitvoering op een gekozen datum/tijd |
| `period` | Incentive actief gedurende een start-tot-einddatum (bv. "hele weekend Double Credit") — audience-resolutie en verzending gebeuren bij de start, de incentive zelf (de onderliggende `reward_rule`) blijft actief tot het einde |
| `recurring` | Herhaalt volgens een patroon (bv. "elke dinsdag", cron-achtige expressie) — elke herhaling genereert een eigen `campaign_audience_snapshot` (`runNumber` oplopend) en eigen metrics, zodat "Quiet Tuesday" van deze week apart meetbaar is van vorige week |

### `campaign_schedule`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `campaignId` | UUID (FK) | |
| `scheduleType` | enum | `direct`, `datetime`, `period`, `recurring` |
| `startAt` | timestamp, nullable | |
| `endAt` | timestamp, nullable | |
| `recurrenceRule` | varchar, nullable | iCal-achtige RRULE-notatie (bv. `FREQ=WEEKLY;BYDAY=TU`) |
| `timezone` | varchar | erft standaard van de locatie (Module 1's `locations.timezone`) |

---

## 9. Approvals

Optioneel, organisatie-configureerbaar (`campaign_approval_threshold` op organisatieniveau — geen aparte tabel nodig, één instelling):

```
Manager klikt "Launch" (stap 8)
        │
        ▼
Overschrijdt de campagne een van de
geconfigureerde drempels? (bv.
maxRewardExposure > €500, of
maxRecipients > 1.000)
        │
   ┌────┴─────┐
  Nee         Ja
   │           │
   ▼           ▼
Direct       Status → pending_approval
naar         Notificatie naar Organization
scheduled/   Admin(s)
active            │
             ┌────┴─────┐
            Goedgekeurd  Afgekeurd
             │           (met verplichte reden)
             ▼               │
          scheduled/         ▼
          active         Terug naar draft,
                          reden zichtbaar
                          voor de opsteller
```

**Ontwerpkeuze — drempel-gebaseerd, niet verplicht voor elke campagne:** dit voorkomt dat een goedkeuringsproces de "binnen enkele minuten"-belofte ondermijnt voor kleine, laag-risico acties (bv. een Location Manager die "Quiet Tuesday" voor zijn eigen locatie start), terwijl het wél bescherming biedt tegen grote, dure campagnes.

---

## 10. Preview

Stap 7 van de wizard, en tevens los oproepbaar (`GET .../preview`) tijdens het bewerken:

```
┌─────────────────────────────────────────────────┐
│  Preview — Win Back                                 │
├─────────────────────────────────────────────────┤
│  Audience: 624 gasten                                 │
│  (waarvan 62 in controlegroep — ontvangen geen           │
│  incentive/bericht, wel meegeteld voor meting)             │
│                                                              │
│  Outstanding credit van deze doelgroep: €7.840                │
│  (ter context — hun bestaande tegoed, niet de nieuwe            │
│  incentive)                                                       │
│                                                                      │
│  Potential maximum reward: €1.248                                    │
│  (562 te bereiken gasten × max €2,22 gemiddelde incentive,             │
│  gebaseerd op hun typische besteding × de multiplier)                    │
│                                                                              │
│  Kanaalbereik:                                                                │
│  Push: 480/624 (77%) hebben push aanstaan                                       │
│  E-mail: 601/624 (96%) hebben e-mailconsent                                        │
│  SMS: 210/624 (34%) hebben smsconsent                                                 │
│                                                                                           │
│  ⚠ Budgetwaarschuwing: geen enkele                                                          │
│    (binnen ingestelde limieten)                                                                │
└─────────────────────────────────────────────────┘
```

**Berekeningsbron voor "potential maximum reward":** dit hergebruikt Module 4's Rule Simulator (dezelfde rekencode als bij een live transactie) — voor elke gast in de snapshot wordt diens gemiddelde besteding (Module 1's `averageSpend`) door de simulator gehaald met de campagne-incentive toegepast, en het totaal opgeteld. Consistent met het platformbrede principe "simulator en werkelijkheid mogen nooit uit elkaar lopen".

---

## 11. Campaign execution

```
Scheduled moment bereikt (of "direct" bij launch)
        │
        ▼
Audience-filter uitvoeren → campaign_audience_snapshot
        │
        ▼
Voor elke gematchte klant (behalve controlegroep):
        │
        ├─► Incentive: reward_rule (met campaignId) actief zetten/
        │   aanmaken voor de duur van de campagne (indien van
        │   toepassing, sectie 6)
        │
        ├─► Coupon: campaign_coupons-rij aanmaken en koppelen
        │   (indien van toepassing)
        │
        └─► Voor elk geselecteerd kanaal (sectie 3, stap 5):
            campaign_recipients-rij aanmaken met status 'queued',
            bericht klaarzetten voor Module 6 (Messaging) om te
            versturen — deze module bereidt voor, Module 6 verstuurt
        │
        ▼
Status → active
        │
        ▼
Doorlopende monitoring: bij elke transactie/reward/redemption
die aan deze campagne te koppelen is (sectie 12), metrics
bijwerken en budgetlimieten controleren (sectie 7)
        │
        ▼
Periode voorbij / eenmalige run klaar / budget bereikt
        │
        ▼
Status → completed (of terug naar 'scheduled' voor de
volgende run, bij recurring)
```

### `campaign_recipients`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `campaignId` | UUID (FK) | |
| `customerId` | UUID (FK) | |
| `runNumber` | integer | |
| `channel` | enum | `push`, `wallet`, `email`, `sms` |
| `status` | enum | `queued`, `delivered`, `opened`, `clicked`, `failed` |
| `queuedAt` / `deliveredAt` / `openedAt` / `clickedAt` | timestamp, nullable | |
| `failureReason` | text, nullable | |

---

## 12. Attribution

```
Klant uit een campagne-snapshot doet een reservering/bezoek/
transactie binnen het attributievenster (configureerbaar,
default 14 dagen na ontvangst)
        │
        ▼
Koppel deze gebeurtenis aan de campagne (campaignId op de
transactie/reward/reservering — via het bestaande campaignId-
veld dat al in Module 2's transacties en Module 4's
reward_calculations aanwezig is, hier alleen ingevuld)
        │
        ▼
Incrementele omzet berekenen:
  gemiddelde omzet per gast (behandelde groep, binnen venster)
  MINUS
  gemiddelde omzet per gast (controlegroep, binnen hetzelfde venster)
  × aantal gasten in de behandelde groep
        │
        ▼
Dit is "incremental revenue" — het deel van de omzet dat
aantoonbaar aan de campagne is toe te schrijven, in plaats
van omzet die toch wel was gekomen
```

**Zonder controlegroep** (als een manager die stap heeft overgeslagen) wordt incrementele omzet **niet** getoond als hard cijfer, maar als een voorzichtige schatting met een duidelijk label ("geschat, geen controlegroep gebruikt") — dit voorkomt dat het platform overdreven zelfverzekerde ROI-claims doet zonder methodologische basis.

---

## 13. Reporting

### `campaign_metrics_snapshots`

Periodiek (bv. elk uur tijdens een actieve campagne, dagelijks daarna) herberekende, denormalized rapportagecijfers — zodat het dashboard niet bij elke weergave zware aggregatiequeries hoeft te draaien.

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `campaignId` | UUID (FK) | |
| `snapshotAt` | timestamp | |
| `recipients` | integer | |
| `delivered` | integer | |
| `opens` | integer | |
| `clicks` | integer | |
| `reservations` | integer | |
| `visits` | integer | |
| `revenue` | decimal(10,2) | |
| `averageCheck` | decimal(10,2) | |
| `rewardIssued` | decimal(10,2) | |
| `rewardRedeemed` | decimal(10,2) | |
| `incrementalRevenue` | decimal(10,2), nullable | `null` als geen controlegroep |
| `estimatedRoi` | decimal(6,2), nullable | `(incrementalRevenue − rewardIssued − campagnekosten) / campagnekosten` |

**Campagne-dashboard (samenvatting):**
```
┌─────────────────────────────────────────────────┐
│  Win Back — Resultaten                               │
├─────────────────────────────────────────────────┤
│  Recipients      562        Reservations      89        │
│  Delivered       548        Visits            76          │
│  Opens           312        Revenue        €4.280           │
│  Clicks          94         Avg. check      €56,30            │
│                                                                   │
│  Reward issued   €1.180     Reward redeemed  €640                  │
│                                                                        │
│  Incremental revenue: €1.640  (vs. controlegroep, 62 gasten)            │
│  Estimated ROI: 3,4×                                                       │
└─────────────────────────────────────────────────┘
```

---

## 14. Stop/pause

```
Manager klikt "Pauzeren" op een actieve campagne
        │
        ▼
Status → paused
        │
        ├─► Onderliggende reward_rule: is_active = false
        │   (geen nieuwe rewards meer, bestaande blijven geldig
        │   — consistent met Module 4's append-only regelmodel)
        │
        ├─► Nog niet verstuurde campaign_recipients (status='queued'):
        │   verzending geannuleerd, status → 'failed' met reden
        │   'campaign_paused'
        │
        └─► Al verstuurde berichten: geen terugroepactie mogelijk
            (technisch onhaalbaar bij push/e-mail/sms), wel
            zichtbaar in rapportage dat verzending is gestopt
        │
        ▼
Manager klikt "Hervatten"
        │
        ▼
Status → active, reward_rule: is_active = true,
audience-resolutie NIET opnieuw uitgevoerd (dezelfde
snapshot blijft gelden, tenzij het een recurring
campagne is die toch al een nieuwe run zou starten)
```

**Cancel (definitief):** zelfde effect als pause op de `reward_rule` en wachtrij, maar de status kan nooit meer terug naar `active` — alleen archiveren.

---

## 15. Errors

| Foutscenario | Afhandeling |
|---|---|
| Audience-filter levert 0 gasten op | Campagne blijft in `draft`, launch geblokkeerd met duidelijke melding — voorkomt een "lege" campagne die verwarring geeft in rapportage |
| Kanaal-verzending faalt (bv. push-service tijdelijk onbereikbaar — afhankelijkheid van Module 6) | `campaign_recipients.status = 'failed'`, met retry-logica die bij Module 6 hoort (deze module registreert alleen het falen) |
| Budget overschreden tijdens uitvoering | Automatische pauze (sectie 7/14), notificatie naar de campagne-eigenaar |
| Incentive-koppeling naar Module 4 mislukt (bv. conflicterende regel) | Campagne-launch wordt geblokkeerd, niet stilzwijgend zonder incentive doorgezet — een campagne die per ongeluk zonder beloofde beloning uitgaat, is erger dan een vertraagde launch |
| Recurring campagne: een run mist zijn geplande moment (bv. door platform-onderhoud) | Volgende mogelijke moment wordt gebruikt, gemiste run wordt gelogd (niet stilzwijgend overgeslagen) zodat een manager het merkt |

---

## 16. API/events

Basis: `/api/v1/organizations/{orgId}/campaigns`

| Methode | Endpoint | Omschrijving |
|---|---|---|
| `GET` | `/campaign-templates` | Beschikbare templates (platform + eigen) |
| `POST` | `/campaigns` | Nieuwe campagne aanmaken (leeg of vanuit een template) |
| `GET` | `/campaigns` | Lijst, filterbaar op status/doel |
| `GET` | `/campaigns/{id}` | Detail |
| `PATCH` | `/campaigns/{id}` | Bijwerken (alleen toegestaan in `draft`/`paused`) |
| `GET` | `/campaigns/{id}/preview` | Sectie 10 |
| `POST` | `/campaigns/{id}/submit-for-approval` | Sectie 9 |
| `POST` | `/campaigns/{id}/approve` / `/reject` | Sectie 9 |
| `POST` | `/campaigns/{id}/launch` | Sectie 11 |
| `POST` | `/campaigns/{id}/pause` / `/resume` | Sectie 14 |
| `POST` | `/campaigns/{id}/cancel` | Sectie 14 |
| `GET` | `/campaigns/{id}/results` | Sectie 13 |
| `GET` | `/campaigns/{id}/recipients` | Sectie 11 |

**Publiceert:** `campaign.launched`, `campaign.paused`, `campaign.completed`, `campaign.budget_exceeded`, `campaign.recipient_queued` (voor Module 6 om op te pakken), `campaign.approval_requested`.

**Consumeert:** `transaction.completed` / `reservation.created` (attributie, sectie 12), `wallet.balance_changed` (redemption-kosten bijhouden, sectie 7), `message.delivered` / `opened` / `clicked` (vanuit Module 6, voor `campaign_recipients`-statusupdates).

---

## 17. Permissions

| Rol | Rechten |
|---|---|
| **Organization Admin** | Volledige CRUD, goedkeuren/afkeuren, organisatiebrede templates beheren |
| **Location Manager** | Campagnes aanmaken/starten voor eigen locatie, binnen het goedkeuringsdrempel-beleid (sectie 9) |
| **Marketing** | Volledige campagne-CRUD organisatiebreed, geen goedkeuringsbevoegdheid (kan zelf geen eigen grote campagne goedkeuren — vier-ogen-principe) |
| **Staff** | Alleen leestoegang tot lopende/geplande campagnes (t.b.v. contextkennis aan de balie, bv. weten dat er een actie loopt) |

Permissie-primitieven: `campaign.read`, `campaign.write`, `campaign.launch`, `campaign.approve`, `campaign_template.write`.

---

## Voorstel implementatievolgorde

1. **Fase 1 — Kernmodel + directe campagnes:** `campaigns`, audience-filter (snapshot-modus, geen recurring), koppeling naar Module 4 voor de incentive. Dit levert al een werkende, simpele "start nu"-campagne op.
2. **Fase 2 — Preview + budget controls:** sectie 7/10, essentieel vóórdat er met echte klanten getest wordt.
3. **Fase 3 — Templates:** de vooraf ingevulde platform-templates (Sunny Day etc.) — snel te bouwen zodra fase 1-2 staan, en direct de grootste UX-winst.
4. **Fase 4 — Scheduling (datetime/period/recurring) + pause/resume:** sectie 8/14.
5. **Fase 5 — Attribution + reporting:** sectie 12/13 — hangt af van voldoende afgeronde campagnes om zinvol te zijn, dus logisch na de eerste vier fasen.
6. **Fase 6 — Approvals + control groups:** verfijning, niet blokkerend voor de kernwerking.
7. **Fase 7 — Module 4-uitbreiding (audience-restrictie op reward_rules):** technisch een aanpassing aan een bestaande module, dus zorgvuldig gepland — nodig zodra de eerste doelgroep-specifieke campagne (niet "voor iedereen") gelanceerd wordt.

---

Wil je dat we hierna de database-migratie voor Module 5 bouwen en testen, of eerst Module 6 (Messaging) ontwerpen zodat het "campagne → verzending"-pad ook compleet op papier staat voordat we gaan bouwen?
