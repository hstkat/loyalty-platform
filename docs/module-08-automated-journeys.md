# Module 8 — Automated Journeys

> Onderdeel van het horeca/hospitality loyaltyplatform. De marketing-automation-motor die trigger → conditie → wacht → actie-ketens uitvoert, volledig geautomatiseerd, per individuele gast. Bouwt voort op Module 1 (Customer & CRM), Module 3 (Wallet & Credit), Module 4 (Reward Engine), Module 6 (Messaging) en Module 7 (Segmentation) — deze module orkestreert, ze rekent en verstuurt zelf niets nieuws.

---

## 1. Journey architecture

Een journey is een **gerichte graaf van nodes**, met precies één startpunt (de trigger) en één of meer eindpunten:

```
[TRIGGER: eerste geldige transactie]
        │
        ▼
[ACTION: stuur bedankbericht]
        │
        ▼
[ACTION: toon verdiend credit]
        │
        ▼
[WAIT: 14 dagen]
        │
        ▼
[CONDITION: geen nieuw bezoek?]
   │            │
  Ja            Nee
   │             │
   ▼             ▼
[ACTION:      [END]
 stuur
 reminder]
   │
   ▼
[WAIT: 31 dagen]
   │
   ▼
[CONDITION: credit bestaat nog?]
   │            │
  Ja            Nee
   │             │
   ▼             ▼
[ACTION:      [END]
 stuur
 expiration
 reminder]
   │
   ▼
[END]
```

**Kernprincipe, consistent met de rest van het platform:** deze module **hergebruikt** bestaande bouwstenen in plaats van eigen logica te dupliceren — een `send_push`-node roept Module 6 aan, een `add_credit`-node roept Module 3 aan, een `give_reward`-node roept Module 4 aan, een `segment_condition`-node leest Module 7. Journeys zijn een **orkestratielaag**, precies zoals Module 5's campagnes dat ook zijn — het verschil is dat een campagne één keer uitgaat naar een doelgroep, terwijl een journey een **doorlopend, individueel pad per klant** is, getriggerd door gedrag in plaats van een geplande datum.

---

## 2. Triggers

| Triggertype | Bron | Voorbeeld-journey |
|---|---|---|
| **Event-gedreven** | Een platformevent van een andere module | `transaction.completed` (eerste transactie) → Welcome/First Visit; `wallet.credit_expiring_soon` → Credit Expiring; `segment.customer_entered` (At Risk-segment, Module 7) → At Risk; `customers.tier_changed` → VIP Upgrade/Tier Downgrade Warning; `reservation.no_show` (Module 9, nog niet gebouwd) → No-Show Recovery |
| **Datum-gebaseerd** | Dagelijkse scheduler-scan tegen klantvelden | Verjaardag (`customers.dateOfBirth` binnen X dagen) → Birthday |
| **Berekend/samengesteld** | Combinatie van meerdere signalen | "Tweede bezoek nog niet gebeurd na eerste bezoek" → Second Visit Conversion (technisch: event-trigger op eerste transactie, met een ingebouwde wait+conditie, geen apart triggertype nodig — zie het architectuurvoorbeeld in sectie 1) |

### `journey_triggers` (onderdeel van een journey-versie, sectie 8)

| Veld | Type | Omschrijving |
|---|---|---|
| `triggerType` | enum | `event`, `scheduled_date` |
| `eventName` | varchar, nullable | bv. `transaction.completed`, `segment.customer_entered` |
| `eventFilter` | jsonb, nullable | bv. `{"segmentId": "<uuid-at-risk-segment>"}` om alleen op één specifiek segment te reageren |
| `dateField` | varchar, nullable | bv. `dateOfBirth`, voor `scheduled_date`-triggers |
| `dateOffsetDays` | integer, nullable | bv. `-7` voor "7 dagen vóór de verjaardag" |

**Elke trigger doet standaard een duplicate-enrollment-check vóórdat er daadwerkelijk wordt ingeschreven** — zie sectie 7.

---

## 3. Conditions

Condition-nodes gebruiken **dezelfde condition-DSL als Module 7's segmenten** (veld/operator/waarde, met AND/OR) — geen tweede, parallelle manier om voorwaarden uit te drukken. Dit betekent dat een condition-node letterlijk kan zijn: *"is deze klant momenteel lid van segment X"* (een `segment_condition`-node, een dunne wrapper om Module 7's membership-check) of een directe veldcheck zoals in het voorbeeld: `{ field: "daysSinceLastVisit", operator: "gt", value: 0 }` geëvalueerd op het moment dat de wait-node afloopt.

**Belangrijk verschil met Module 5/7:** een conditie in een journey wordt geëvalueerd **op het moment dat de flow er daadwerkelijk aankomt** (na een wait, bijvoorbeeld), niet vooraf bij het opstellen — de klantstatus kan in de tussentijd veranderd zijn, en dat is precies de bedoeling ("geen nieuw bezoek?" moet de actuele stand checken, niet de stand van 14 dagen geleden).

---

## 4. Actions

| Node-type | Werking | Module-koppeling |
|---|---|---|
| `send_push` / `send_email` / `send_sms` | Verstuurt een bericht via een template | Module 6, met `sourceType: journey`, `sourceId: journeyId` |
| `add_credit` | Kent een vast bedrag toe | Module 3, ledger entry type `bonus`, met `source: system` en metadata die naar de journey verwijst |
| `give_reward` | Activeert een tijdelijke reward-regel/boost voor deze specifieke klant | Module 4, vergelijkbaar met Module 5's incentive-koppeling (`reward_rules.campaignId`-achtig veld, hier een `journeyId`-equivalent — zie sectie 8) |
| `add_tag` | Voegt een Module 1-tag toe aan het klantprofiel | Module 1 |
| `change_tier` | Wijzigt `customers.tierId` | Module 1 |
| `webhook` | Externe HTTP-aanroep (bv. naar een extern CRM) | Buiten het platform, met retry-logica (sectie 12) |
| `split_test` | Verdeelt de flow in meerdere takken op basis van een percentage | Sectie 15 |
| `wait` | Geen actie, pauzeert de flow tot een tijdstip/duur | Sectie 5 |
| `end` | Beëindigt deze tak van de flow | — |

**Elke actie-node die een bericht/reward/credit genereert, registreert een `journeyId`-referentie op het onderliggende record** — dit is exact hetzelfde attributiepatroon als Module 5's `campaignId`, en beide kunnen naast elkaar bestaan (een klant kan tegelijk in een journey én een campagne zitten; beide referenties blijven apart traceerbaar).

---

## 5. Scheduler

Twee soorten "tijd" spelen een rol, en ze worden verschillend afgehandeld:

```
WAIT-node bereikt tijdens flow-uitvoering
        │
        ▼
journey_enrollments.status = 'waiting'
journey_enrollments.resumeAt = nu + wait-duur
        │
        ▼
        (geen actief proces, geen polling per seconde —
        de enrollment "slaapt" simpelweg)
        │
        ▼
Scheduler-job (draait bv. elke 5 minuten)
        │
        ▼
SELECT enrollments WHERE status = 'waiting'
AND resumeAt <= now()
        │
        ▼
Voor elke gevonden enrollment: hervat de flow-uitvoering
vanaf de volgende node
```

**Datum-gebaseerde triggers (verjaardag e.d.)** draaien via een **aparte, dagelijkse scan** (bv. 06:00): voor elke actieve journey met een `scheduled_date`-trigger, worden alle klanten gecontroleerd op het triggerveld (bv. "is vandaag exact 7 dagen vóór de verjaardag van deze klant") — dit is fundamenteel anders dan een event-trigger, die reactief is op iets dat al gebeurd is.

---

## 6. Workflow state

```
                enrolled
                   │
                   ▼
          ┌─────────────────┐
          │  executing        │◄──────────┐
          └────────┬────────┘             │
                    │                       │
        ┌───────────┼───────────┐           │
        ▼           ▼           ▼           │
   [actie klaar] [wait-node]  [conditie]     │
        │           │           │            │
        │           ▼           │            │
        │        waiting        │            │
        │           │           │            │
        │      (scheduler,      │            │
        │       sectie 5)       │            │
        │           └───────────┼────────────┘
        │                       │
        ▼                       ▼
  volgende node            branch gekozen
        │                       │
        └───────────┬───────────┘
                     ▼
              (herhaalt tot een
               end-node bereikt is)
                     │
                     ▼
              ┌──────┴──────┐
              ▼             ▼
         completed      goal_reached
         (natuurlijk     (sectie 14 —
         einde bereikt)  als een
                          gedefinieerd
                          doel onderweg
                          is behaald)
                     │
              ┌──────┴──────┐
              ▼             ▼
          exited         error
        (handmatig       (sectie 11)
        uitgeschreven,
        of journey
        gepauzeerd/
        gestopt terwijl
        deze klant erin
        zat)
```

---

## 7. Customer enrollment

### Voorkomen van dubbele inschrijving

```
Trigger-event komt binnen voor klant X, journey Y
        │
        ▼
Bestaat er al een ACTIEVE enrollment
(status IN ('enrolled','executing','waiting'))
voor deze klant in deze journey?
        │
   ┌────┴─────┐
  Ja          Nee
   │           │
   ▼           ▼
Negeer      Bestaat er een journey-brede
(geen        instelling "eenmalig per klant,
nieuwe       ooit" (default voor de meeste
enrollment)  standaardjourneys, bv. Welcome)
             EN heeft deze klant deze journey
             ooit eerder volledig doorlopen?
                  │
             ┌────┴─────┐
            Ja         Nee
             │           │
             ▼           ▼
        Negeer       Nieuwe enrollment
        (eenmalig     aanmaken, status
        al gehad)     'enrolled'
```

**Journey-instelling `reEnrollmentPolicy`:** `once_ever` (bv. Welcome — je krijgt hem maar één keer), `once_per_completion` (bv. Credit Expiring — mag opnieuw triggeren zodra een *nieuwe* lot dreigt te verlopen, ook al heeft de klant deze journey eerder al volledig doorlopen), `always` (zelden gebruikt, voor journeys zonder herhalingsrisico).

### `journey_enrollments`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `journeyId` | UUID (FK) | |
| `journeyVersionId` | UUID (FK) | de **specifieke versie** waarop is ingeschreven (sectie 10 — een enrollment springt nooit tussentijds naar een nieuwere versie) |
| `customerId` | UUID (FK) | |
| `status` | enum | `enrolled`, `executing`, `waiting`, `completed`, `goal_reached`, `exited`, `error` |
| `currentNodeId` | UUID, nullable | |
| `resumeAt` | timestamp, nullable | |
| `splitTestBranch` | varchar, nullable | sectie 15 |
| `enrolledAt` | timestamp | |
| `completedAt` | timestamp, nullable | |
| `exitReason` | text, nullable | |

---

## 8. Database

```
organizations
    │
    └── journeys ──────────────────────┐
            │                           │
            └── journey_versions         │ (sectie 10)
                    │                     │
                    ├── journey_nodes      │
                    └── journey_edges       │
                                             │
                    journey_enrollments ◄────┘
                            │
                            ├── journey_node_executions (log,
                            │   elke node-uitvoering per
                            │   enrollment — het functionele
                            │   audit-trail van de flow)
                            │
                    journey_goals (sectie 14)
```

### `journeys`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID (FK) | |
| `name` | varchar | |
| `isStandard` | boolean | platform-voorgedefinieerd (Welcome, Birthday, etc.), aanpasbaar |
| `status` | enum | `draft`, `published`, `paused`, `stopped` |
| `reEnrollmentPolicy` | enum | `once_ever`, `once_per_completion`, `always` |
| `currentVersionId` | UUID, nullable (FK) | de actief-gepubliceerde versie |
| `createdAt` / `updatedAt` | timestamp | |

### `journey_versions`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `journeyId` | UUID (FK) | |
| `versionNumber` | integer | |
| `definition` | jsonb | volledige node/edge-graaf, geïmmutabiliseerd bij publicatie (sectie 10) |
| `publishedAt` | timestamp, nullable | `null` = nog draft |
| `createdAt` | timestamp | |

### `journey_nodes` / `journey_edges`

Bewust **ook** als losse, query-bare tabellen (niet alleen binnen de `definition`-jsonb) — nodig omdat de scheduler (sectie 5) en de rapportage (sectie 14) efficiënt per node moeten kunnen filteren, wat met alleen jsonb onhandig zou zijn.

**`journey_nodes`:**

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `journeyVersionId` | UUID (FK) | |
| `nodeType` | enum | zie sectie 1/4's lijst |
| `config` | jsonb | node-specifieke instellingen (bv. `waitDurationDays`, `templateGroupKey`, `creditAmount`, condition-DSL) |
| `positionX` / `positionY` | integer | voor de visuele canvas (sectie 9) |

**`journey_edges`:**

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `journeyVersionId` | UUID (FK) | |
| `fromNodeId` | UUID (FK) | |
| `toNodeId` | UUID (FK) | |
| `branchLabel` | varchar, nullable | bv. `"yes"`, `"no"`, of een split-test-percentagenaam |

### `journey_node_executions`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `enrollmentId` | UUID (FK) | |
| `nodeId` | UUID (FK) | |
| `status` | enum | `success`, `failed`, `retrying` |
| `result` | jsonb, nullable | bv. het aangemaakte `message_queue_items.id` of `wallet_ledger_entries.id` |
| `executedAt` | timestamp | |

### `journey_goals`

Zie sectie 14.

---

## 9. Builder UX

Een visuele canvas, node-gebaseerd, sleep-en-verbind — vergelijkbaar met bekende automation-tools, maar met platform-eigen node-types:

```
┌──────────────────────────────────────────────────────────┐
│  Journey: First Visit                          [Draft ▾]     │
├──────────────────────────────────────────────────────────┤
│                                                                │
│   ┌──────────────┐                                             │
│   │ TRIGGER        │                                            │
│   │ Eerste           │                                           │
│   │ transactie        │                                          │
│   └───────┬──────────┘                                           │
│           │                                                       │
│   ┌───────▼──────────┐                                            │
│   │ SEND PUSH           │                                         │
│   │ "Bedankt template"    │                                       │
│   └───────┬──────────────┘                                        │
│           │                                                        │
│   ┌───────▼──────────────┐                                         │
│   │ WAIT 14 dagen           │                                       │
│   └───────┬──────────────────┘                                     │
│           │                                                         │
│   ┌───────▼──────────────────┐                                      │
│   │ CONDITION: nieuw bezoek?     │                                   │
│   └────┬─────────────┬────────────┘                                 │
│       Ja             Nee                                             │
│        │              │                                               │
│      [END]     ┌──────▼──────┐                                        │
│                │ SEND PUSH      │                                     │
│                │ "Reminder"       │                                   │
│                └──────┬──────────┘                                    │
│                       ▼                                                │
│                    ( ... )                                             │
│                                                                          │
│  [+ Node toevoegen]              [ Test met testklant ]  [ Publiceren ]  │
└──────────────────────────────────────────────────────────┘
```

**Node-configuratiepaneel** (opent bij een klik op een node) toont alleen de velden relevant voor dat node-type — bv. `send_push` toont een template-kiezer (Module 6), `add_credit` toont een bedragveld, `condition` toont dezelfde AND/OR-builder als Module 7.

**"Test met testklant":** voert de hele flow synchroon uit tegen een door de manager gekozen bestaande klant (of een fictieve testklant), met alle wait-nodes overgeslagen (direct doorlopen) — zodat je de logica kunt valideren zonder dagen te wachten. Berichten in deze testmodus gaan **niet** echt uit (net als Module 4's simulator: dezelfde logica, met een `isTest`-vlag die downstream voorkomt dat er echt verzonden/geboekt wordt).

---

## 10. Versioning

```
Manager bewerkt een journey in de builder
        │
        ▼
Wijzigingen worden opgeslagen in een journey_version
met publishedAt = null (draft)
        │
        ▼
Manager klikt "Publiceren"
        │
        ▼
journey_versions.publishedAt wordt gezet — vanaf nu
IMMUTABLE (geen enkele node/edge in deze versie mag
nog wijzigen)
        │
        ▼
journeys.currentVersionId wijst naar deze nieuwe versie
        │
        ▼
NIEUWE enrollments vanaf nu gebruiken deze versie
        │
        ▼
BESTAANDE, actieve enrollments (die nog in een oudere
versie zaten) LOPEN GEWOON DOOR op hun eigen versie —
ze "springen" nooit naar de nieuwe graaf, want dat zou
halverwege een flow tot inconsistente/ontbrekende nodes
kunnen leiden
```

**Dit is hetzelfde principe als Module 4's reward-regel-versionering** (sectie 15 van dat ontwerp): nooit met terugwerkende kracht een lopend proces herschrijven, alleen vooruitkijkend een nieuwe versie laten gelden.

**Drafts** zijn gewoon `journey_versions`-rijen zonder `publishedAt` — een manager kan meerdere concepten hebben liggen, alleen de laatst-gepubliceerde is ooit "actief" voor nieuwe instroom.

---

## 11. Error handling

| Foutscenario | Afhandeling |
|---|---|
| `send_*`-node: Module 6 faalt (bv. provider-storing) | Node-executie krijgt `status: retrying` (sectie 12); na uitputting van retries: `status: failed`, enrollment gaat naar `error`, zichtbaar in rapportage — **niet** stilzwijgend doorgezet naar de volgende node alsof het bericht wel is aangekomen |
| `webhook`-node: extern endpoint onbereikbaar | Zelfde retry-patroon; na uitputting: journey-eigenaar kan configureren of de flow toch doorgaat (`continueOnFailure: true`) of stopt (`false`, default) |
| `condition`-node: verwijst naar een veld dat niet meer bestaat (bv. een Module 7-segment is verwijderd) | Node-executie faalt expliciet, enrollment naar `error` — nooit een silent "conditie is waar/onwaar" gokken |
| Journey wordt gepauzeerd terwijl klanten er middenin zitten | Actieve enrollments blijven in hun huidige status "bevroren" (geen scheduler-hervatting meer) tot de journey weer `published` is; nieuwe triggers worden genegeerd zolang `paused` |
| Journey wordt gestopt (definitief) | Alle actieve enrollments krijgen `status: exited`, `exitReason: 'journey_stopped'` — geen nieuwe acties meer, geen wachtende hervattingen |

---

## 12. Retries

Zelfde exponentiële-backoff-patroon als Module 2 (`failed_transactions`) en Module 6 (`message_queue_items.retryCount`): bv. 1 min, 5 min, 30 min, 2 uur — daarna definitief `failed`. Alleen technische fouten (provider-timeout, netwerkfout bij een webhook) worden geretryed; een harde afwijzing (bv. Module 3 weigert `add_credit` omdat de organisatie een budgetplafond heeft bereikt) gaat direct naar `failed` zonder zinloze pogingen.

---

## 13. Campaign attribution

Journeys krijgen dezelfde attributiebehandeling als Module 5's campagnes, via een parallel `journeyId`-veld (naast het bestaande `campaignId`-veld) op:
- `transactions` (Module 2) — als een bezoek binnen het attributievenster na een journey-actie plaatsvindt
- `reward_calculations` (Module 4) — als een `give_reward`-node de bron was
- `wallet_ledger_entries` (Module 3) — als een `add_credit`-node de bron was
- `message_queue_items` (Module 6) — al gedekt door `message_send_requests.sourceType: journey`/`sourceId`

**Een klant kan tegelijk aan een campagne én een journey worden toegeschreven** (bv. Module 5's "Win Back"-campagne bereikt een klant die toevallig ook in de "At Risk"-journey zit) — beide referenties blijven onafhankelijk van elkaar bestaan, geen gedwongen "welke krijgt de credit"-keuze op dit niveau; dat is een rapportage-interpretatievraag, geen dataverlies-probleem.

---

## 14. Reporting

### `journey_goals`

Een journey kan een expliciet doel definiëren — bijvoorbeeld voor Second Visit Conversion: "klant doet een tweede transactie binnen 30 dagen na inschrijving".

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `journeyId` | UUID (FK) | |
| `goalEventName` | varchar | bv. `transaction.completed` |
| `goalCondition` | jsonb, nullable | optionele extra filter (bv. "bedrag > €20") |
| `withinDays` | integer | vanaf `enrolledAt` |

```
Voor elke actieve/voltooide enrollment:
        │
        ▼
Is het goalEvent opgetreden binnen withinDays
NA enrolledAt (ongeacht of de flow zelf al klaar is)?
        │
   ┌────┴─────┐
  Ja          Nee
   │           │
   ▼           ▼
status →    Blijft op de status die de flow
'goal_       zelf al had (completed/exited/etc.)
reached'
(kan gelijktijdig met
'completed' zijn — een
klant kan zowel de hele
flow doorlopen ALS het
doel behalen)
```

**Journey-dashboard:**
```
┌─────────────────────────────────────────────────┐
│  First Visit — Resultaten                            │
├─────────────────────────────────────────────────┤
│  Enrolled: 340        Goal reached: 198 (58,2%)         │
│                                                             │
│  Funnel per node:                                            │
│  Trigger              340  ████████████████████████████       │
│  Send push (bedankt)  338  ███████████████████████████░        │
│  Wait 14 dagen        338  ███████████████████████████░         │
│  Condition (bezoek?)  312  █████████████████████████░░░          │
│    → Ja (geen bezoek) 142  ████████████░░░░░░░░░░░░░░░░           │
│    → Nee (wel bezoek) 170  ███████████████░░░░░░░░░░░░░            │
│  ...                                                                 │
└─────────────────────────────────────────────────┘
```

Deze funnel-weergave (aantal enrollments dat elke node bereikt) is direct afgeleid uit `journey_node_executions` — geen aparte aggregatietabel nodig voor de basisweergave, wel een periodieke cache voor snelle laadtijden bij journeys met grote volumes.

---

## 15. A/B testing

De `split_test`-node verdeelt de flow in twee of meer takken op basis van een vooraf ingesteld percentage:

```json
{
  "nodeType": "split_test",
  "config": {
    "branches": [
      { "label": "A_short_message", "percentage": 50 },
      { "label": "B_long_message", "percentage": 50 }
    ]
  }
}
```

Bij het bereiken van deze node wordt **eenmalig, willekeurig** (gewogen naar de percentages) een tak gekozen voor deze specifieke enrollment, vastgelegd in `journey_enrollments.splitTestBranch` — een klant blijft voor de rest van de flow op zijn toegewezen tak, ook al zou een latere node ook een split-punt zijn.

**Vergelijking:** het journey-dashboard (sectie 14) splitst de funnel- en goal-cijfers automatisch per `splitTestBranch` als een journey een `split_test`-node bevat, zodat direct zichtbaar is welke variant beter converteert — zonder dat een manager handmatig hoeft te filteren.

---

## 16. API/events

Basis: `/api/v1/organizations/{orgId}/journeys`

| Methode | Endpoint | Omschrijving |
|---|---|---|
| `GET` | `/journeys` | Lijst |
| `POST` | `/journeys` | Nieuwe journey (leeg of vanuit een standaardtemplate) |
| `GET` | `/journeys/{id}` | Detail, inclusief huidige (of laatste draft-)versie |
| `PATCH` | `/journeys/{id}/versions/{versionId}` | Concept bewerken (alleen bij `publishedAt = null`) |
| `POST` | `/journeys/{id}/versions/{versionId}/publish` | Sectie 10 |
| `POST` | `/journeys/{id}/pause` / `/resume` | Sectie 11 |
| `POST` | `/journeys/{id}/stop` | Sectie 11 |
| `POST` | `/journeys/{id}/test` | "Test met testklant", sectie 9 |
| `GET` | `/journeys/{id}/enrollments` | Gepagineerd overzicht |
| `POST` | `/journeys/{id}/enrollments/{enrollmentId}/exit` | Handmatig een individuele klant uitschrijven |
| `GET` | `/journeys/{id}/results` | Sectie 14 |
| `GET` | `/standard-journey-templates` | De vooraf gedefinieerde standaardjourneys (Welcome, Birthday, etc.) |

**Publiceert:** `journey.customer_enrolled`, `journey.node_executed`, `journey.goal_reached`, `journey.completed`, `journey.exited`, `journey.error`.

**Consumeert:** een brede set platformevents als triggerbronnen (sectie 2) — `transaction.completed`, `wallet.credit_expiring_soon`, `segment.customer_entered`/`left` (Module 7), toekomstige `reservation.*`-events (Module 9), `customers.tier_changed` (Module 1).

---

## 17. Permissions

| Rol | Rechten |
|---|---|
| **Organization Admin** | Volledige CRUD, publiceren, pauzeren/stoppen, organisatiebrede standaardjourneys beheren |
| **Location Manager** | Journeys bekijken/bewerken die aan de eigen locatie gekoppeld zijn (via de trigger/audience) |
| **Marketing** | Volledige journey-CRUD en publicatierecht — in tegenstelling tot Module 5's campagnes heeft Marketing hier wél publicatierecht zonder verplichte goedkeuring, omdat journeys doorgaans kleinere, per-klant-bedragen betreffen dan een grote campagne-uitrol; grote `give_reward`/`add_credit`-bedragen in een node vallen alsnog onder Module 3/4's eigen caps en budgetbewaking |
| **Staff** | Alleen leestoegang tot lopende journeys (context aan de balie) |

Permissie-primitieven: `journey.read`, `journey.write`, `journey.publish`, `journey.pause`, `journey.stop`.

---

## Voorstel implementatievolgorde

1. **Fase 1 — Kernmodel + event-triggers + lineaire flows (geen branching):** `journeys`, `journey_versions`, `journey_nodes`/`edges`, `journey_enrollments`, de scheduler voor `wait`-nodes, en de eerste actie-nodes (`send_push`, `add_credit`). Dit levert al een werkende, simpele Welcome-journey op.
2. **Fase 2 — Condities + branching:** `condition`/`segment_condition`-nodes, meerdere uitgaande edges — nodig voor het volledige First Visit-voorbeeld uit de opdracht.
3. **Fase 3 — Duplicate-enrollment-preventie + versioning:** sectie 7/10 — essentieel vóórdat er meer dan één journey tegelijk actief is.
4. **Fase 4 — Overige actie-nodes:** `give_reward`, `add_tag`, `change_tier`, `webhook` — elk relatief onafhankelijk, kunnen incrementeel toegevoegd worden.
5. **Fase 5 — Error handling + retries:** sectie 11/12, betrouwbaarheid vóór productie-volumes.
6. **Fase 6 — Goals + reporting:** sectie 14 — hangt af van voldoende doorlopen journeys om zinvol te zijn.
7. **Fase 7 — A/B testing (`split_test`):** een relatief zelfstandige uitbreiding, kan na de kernwerking.
8. **Fase 8 — Standaardjourney-bibliotheek:** alle veertien genoemde standaardjourneys (Welcome, Birthday, Dormant, At Risk, VIP Upgrade, etc.) als vooraf gedefinieerde, direct-activeerbare templates — het meest waardevolle eindresultaat voor een manager, maar bouwt op alle voorgaande fasen.

---

Wil je dat we hierna de database-migratie voor Module 8 bouwen en testen, zoals bij de vorige modules?
