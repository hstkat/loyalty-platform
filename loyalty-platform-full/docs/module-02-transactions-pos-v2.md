# Module 2 — Transactions & POS (herziene, volledige versie)

> Vervangt de eerdere, vereenvoudigde versie van Module 2. Deze versie ontwerpt een generieke POS-integratielaag die meerdere kassasystemen kan ontvangen (realtime webhook, polling, bulk-import, CSV-fallback), met volledige refund/void/chargeback-afhandeling en een integration-dashboard. Bouwt voort op Module 1 (Customer & CRM) en levert de trigger voor Module 4 (Reward Engine).

---

## 1. Functionele werking

Deze module is de poort waardoor **alle** omzet het platform binnenkomt, ongeacht welk kassasysteem een locatie gebruikt. Het kernprincipe: elk extern POS-systeem praat tegen dezelfde interne, genormaliseerde transactiestructuur — de verschillen tussen kassasystemen worden opgevangen in een **mapping-laag**, niet verspreid over de rest van het platform.

Vier manieren om transacties binnen te krijgen, allemaal uitmondend in hetzelfde interne verwerkingspad:

1. **Realtime webhook** — het POS-systeem stuurt actief een event zodra een rekening wordt afgerekend (voorkeursmethode, laagste latency).
2. **Polling** — het platform vraagt periodiek (bv. elke 2 minuten) nieuwe/gewijzigde transacties op bij POS-systemen die geen webhooks ondersteunen.
3. **Bulk import** — een POS-integratie of beheerder kan een batch transacties in één keer aanleveren (bv. bij eerste koppeling, of na een storing).
4. **CSV-fallback** — handmatige upload door een manager wanneer een POS-koppeling (nog) niet bestaat of tijdelijk uitvalt — vult exact hetzelfde interne model, zodat er geen "tweede soort" transactie ontstaat.

Elke binnenkomende transactie doorloopt: **ontvangst → normalisatie → validatie → matching (klant/tafel/reservering) → opslag → reward-trigger**. Zie sectie 3 voor de volledige lifecycle.

---

## 2. Dataflow

```
┌─────────────────────────────────────────────────────────────────┐
│                        POS-systemen (extern)                     │
│   Lightspeed  │  Untill  │  Zettle  │  ...  │  Handmatige CSV    │
└──────┬────────────┬───────────┬──────────────────────┬──────────┘
       │ webhook     │ poll      │ bulk API              │ upload
       ▼             ▼           ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    POS Integration Layer                         │
│  ┌───────────────┐  ┌───────────────┐  ┌──────────────────────┐ │
│  │ Webhook        │  │ Polling        │  │ Bulk/CSV import      │ │
│  │ receiver       │  │ worker         │  │ handler               │ │
│  └───────┬───────┘  └───────┬───────┘  └───────────┬──────────┘ │
│          └──────────────────┴────────────────────────┘          │
│                             ▼                                    │
│                  pos_events (ruwe payload, ongewijzigd            │
│                  bewaard — audit + replay-basis)                  │
│                             ▼                                    │
│                  Normalisatie (provider-specifieke                │
│                  mapper zet ruwe payload om naar het              │
│                  interne transactiemodel)                         │
│                             ▼                                    │
│                  Idempotency-check (externalTransactionId          │
│                  + provider + locatie al verwerkt?)               │
│                             ▼                                    │
│                  Validatie (bedragen kloppen, verplichte           │
│                  velden aanwezig)                                  │
│                             ▼                                    │
│              ┌──────────────┴──────────────┐                     │
│           Geldig                        Ongeldig                  │
│              │                              │                     │
│              ▼                              ▼                     │
│     Matching: customer (via         failed_transactions            │
│     Module 1 resolve-identity),     (error queue, retry-           │
│     tafel, reservering, product     baar, zichtbaar in            │
│     mapping                          dashboard)                    │
│              │                                                     │
│              ▼                                                     │
│     transactions + transaction_line_items opslaan                  │
│              │                                                     │
│              ▼                                                     │
│     Event: transaction.completed                                   │
└──────────────┬──────────────────────────────────────────────────┘
               │
   ┌───────────┼────────────────┬─────────────────────┐
   ▼           ▼                ▼                       ▼
Module 1    Module 4         Module 9               Module 10
(CRM-cache  (Reward Engine:  (bezettingsgraad-       (Analytics)
bijwerken)  reward-trigger,  datapunt)
            zie sectie 7)
```

---

## 3. Transaction lifecycle

Elke transactie doorloopt een expliciete status-machine — dit is essentieel omdat refunds, voids en chargebacks allemaal ná de oorspronkelijke afronding kunnen gebeuren, soms dagen later.

```
        ontvangen
            │
            ▼
     ┌─────────────┐
     │  pending     │  (in verwerking: normalisatie/matching bezig)
     └──────┬───────┘
            │
     ┌──────┴───────┐
     ▼               ▼
┌─────────┐     ┌──────────┐
│ failed   │     │ completed │  ← reward-trigger vuurt hier (sectie 7)
└────┬────┘     └─────┬─────┘
     │                 │
     │ retry      ┌────┼────────────────┬─────────────┐
     │            ▼    ▼                ▼             ▼
     │      ┌──────────┐ ┌───────────┐ ┌────────┐ ┌──────────┐
     └─────▶│ completed │ │ partially_ │ │ refunded│ │ voided    │
            └───────────┘ │ refunded   │ └────┬────┘ └────┬─────┘
                           └─────┬──────┘      │           │
                                 │             ▼           ▼
                                 │        reward reversal (sectie 8)
                                 ▼
                          reward reversal (gedeeltelijk,
                          proportioneel — sectie 8)

                    ┌──────────────────┐
                    │  charged_back      │  ← kan vanuit completed,
                    └──────────────────┘     partially_refunded, of
                                              refunded ontstaan; komt
                                              altijd via een apart
                                              chargeback-event van de
                                              betaalprovider, niet van
                                              de POS zelf
```

**Statussen:** `pending`, `completed`, `failed`, `voided`, `partially_refunded`, `refunded`, `charged_back`.

Belangrijk: `voided` en `refunded` zijn **niet** hetzelfde. Een void is een annulering **vóór** afsluiting van de dienst/kassasessie (de rekening "bestond eigenlijk nooit echt"); een refund is een terugbetaling **ná** een reeds voltooide, aan de gast overhandigde transactie. Dit onderscheid is belangrijk voor de boekhouding en voor hoe Module 4 de reward reversal moet interpreteren (zie sectie 8).

---

## 4. Database

```
organizations
    │
    ├── locations
    │       │
    │       └── pos_connections ──────────────┐
    │                                          │
    ├── pos_product_mappings                   │
    ├── pos_customer_mappings                  │
    │                                          │
    └── transactions ──────────────────────────┘
            │
            ├── transaction_line_items
            │       └── transaction_line_item_modifiers
            ├── transaction_refunds
            ├── transaction_voids
            ├── transaction_chargebacks
            │
    pos_events (ruwe payloads, alle providers, alle statussen)
    failed_transactions (error queue)
    pos_sync_runs (polling/bulk run-log, t.b.v. dashboard + reconciliation)
```

### `pos_connections`

Eén rij per gekoppeld kassasysteem per locatie — het fundament van de multi-POS-ondersteuning.

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organization_id` | UUID (FK) | |
| `location_id` | UUID (FK) | |
| `provider` | enum | `lightspeed`, `untill`, `zettle`, `square`, `generic_webhook`, `csv_manual`, ... (uitbreidbaar, geen hardcoded enum-limiet in de business-logica — zie sectie 9) |
| `connection_mode` | enum | `webhook`, `polling`, `bulk_only` |
| `api_credentials_ref` | varchar | verwijzing naar secret in de secrets-manager, **nooit** het geheim zelf in deze tabel |
| `webhook_secret_ref` | varchar, nullable | voor HMAC-verificatie van inkomende webhooks (zie sectie 13) |
| `polling_interval_seconds` | integer, nullable | alleen relevant bij `connection_mode = polling` |
| `last_synced_at` | timestamp, nullable | |
| `last_successful_sync_at` | timestamp, nullable | |
| `status` | enum | `active`, `paused`, `error`, `not_configured` |
| `created_at` / `updated_at` | timestamp | |

### `pos_events`

Ruwe, ongewijzigde payload — de basis voor replay, debugging en audit. **Nooit** overschreven of verwijderd.

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `pos_connection_id` | UUID (FK) | |
| `ingestion_method` | enum | `webhook`, `poll`, `bulk_import`, `csv_upload` |
| `raw_payload` | jsonb | exacte ontvangen data, ongewijzigd |
| `payload_hash` | varchar | SHA-256 van `raw_payload`, t.b.v. duplicate-detectie (sectie 10) |
| `received_at` | timestamp | |
| `processing_status` | enum | `pending`, `processed`, `failed`, `ignored_duplicate` |
| `transaction_id` | UUID, nullable (FK) | gevuld zodra succesvol verwerkt |

### `transactions`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organization_id` | UUID (FK) | |
| `location_id` | UUID (FK) | |
| `pos_connection_id` | UUID, nullable (FK) | `null` bij `source = manual` |
| `source` | enum | `pos`, `manual`, `csv_import` |
| `external_transaction_id` | varchar, nullable | het bonnummer/ID zoals het POS-systeem het kent |
| `customer_id` | UUID, nullable (FK naar Module 1) | |
| `table_reference` | varchar, nullable | vrij veld, tafelnummer/-naam zoals door POS aangeleverd |
| `reservation_id` | UUID, nullable | verwijzing naar Module 9 (Reservations), indien bekend |
| `status` | enum | zie sectie 3 |
| `gross_amount` | decimal(10,2) | bruto bedrag, vóór korting |
| `discount_amount` | decimal(10,2) | default `0` |
| `service_amount` | decimal(10,2) | fooi/service, default `0` |
| `vat_amount` | decimal(10,2) | |
| `net_amount` | decimal(10,2) | `gross_amount − discount_amount` (excl. btw-behandeling, zie hieronder) |
| `total_amount` | decimal(10,2) | het daadwerkelijk betaalde bedrag (`net_amount + vat_amount + service_amount`, indien service niet al in net_amount zit — configureerbaar per organisatie hoe btw/service worden opgeteld, want dit verschilt per POS-provider) |
| `payment_method` | enum | `cash`, `card`, `ideal`, `voucher`, `split`, `other` |
| `occurred_at` | timestamp | |
| `pos_created_at` | timestamp, nullable | tijdstip zoals het POS-systeem zelf rapporteert (kan afwijken van `occurred_at`, bv. tijdzone-issues bij sommige providers) |
| `created_at` | timestamp | |

> **Ontwerpkeuze — bedragvelden expliciet uit elkaar getrokken:** de opdracht vraagt om bruto, netto, BTW, korting en service als aparte velden. Omdat POS-providers deze onderling verschillend opbouwen (sommige tellen service al bij net_amount op, andere niet), documenteren we per `pos_connection` (via een klein configuratieveld, niet hieronder apart uitgewerkt om het schema niet nodeloos te vergroten) hoe die provider de optelling doet, zodat de normalisatiestap (sectie 2) altijd naar hetzelfde interne model convergeert.

### `transaction_line_items`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `transaction_id` | UUID (FK) | |
| `pos_product_id` | varchar, nullable | extern product-ID zoals door POS aangeleverd |
| `internal_product_mapping_id` | UUID, nullable (FK naar `pos_product_mappings`) | |
| `description` | varchar | |
| `category` | varchar, nullable | genormaliseerde categorie (na mapping), gebruikt door Module 4's product-uitsluitingsregels |
| `quantity` | integer | |
| `unit_price` | decimal(10,2) | |
| `line_gross_amount` | decimal(10,2) | |
| `line_discount_amount` | decimal(10,2) | default `0` |
| `line_net_amount` | decimal(10,2) | |
| `line_vat_amount` | decimal(10,2) | |
| `reward_eligible` | boolean | default `true`, door Module 4 op `false` gezet indien productuitsluiting van toepassing (zie sectie 7) — hier opgeslagen zodat de reden zichtbaar blijft op regelniveau |

### `transaction_line_item_modifiers`

Voor add-ons/aanpassingen op een regel (bv. "extra shot espresso", "zonder ijs") — relevant voor toekomstige productspecifieke regels, nu vooral t.b.v. volledigheid richting het POS-systeem.

| Veld | Type |
|---|---|
| `id` | UUID (PK) |
| `line_item_id` | UUID (FK) |
| `name` | varchar |
| `price_adjustment` | decimal(10,2) |

### `transaction_refunds`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `transaction_id` | UUID (FK) | |
| `refund_type` | enum | `partial`, `full` |
| `refunded_amount` | decimal(10,2) | |
| `refunded_line_items` | jsonb, nullable | welke regels (en welk deel ervan) zijn terugbetaald — belangrijk voor proportionele reward reversal (sectie 8) |
| `reason` | text | |
| `external_refund_id` | varchar, nullable | ID zoals door POS/betaalprovider aangeleverd |
| `initiated_by` | enum | `pos`, `manual_staff` |
| `performed_by_user_id` | UUID, nullable | |
| `occurred_at` | timestamp | |

### `transaction_voids`

| Veld | Type |
|---|---|
| `id` | UUID (PK) |
| `transaction_id` | UUID (FK) |
| `reason` | text |
| `performed_by_user_id` | UUID, nullable |
| `occurred_at` | timestamp |

### `transaction_chargebacks`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `transaction_id` | UUID (FK) | |
| `chargeback_amount` | decimal(10,2) | |
| `reason_code` | varchar, nullable | code zoals aangeleverd door de betaalprovider |
| `status` | enum | `received`, `disputed`, `lost`, `won` |
| `received_at` | timestamp | |

### `pos_product_mappings` / `pos_customer_mappings`

Zie sectie 9 (POS mapping).

### `failed_transactions`

Zie sectie 11 (foutafhandeling).

### `pos_sync_runs`

Zie sectie 12 (reconciliation) en sectie 14 (admin UI).

---

## 5. API

Basis: `/api/v1/organizations/{orgId}/locations/{locationId}`

**Ingestion (door POS-integraties of handmatige invoer aangeroepen):**

| Methode | Endpoint | Omschrijving |
|---|---|---|
| `POST` | `/transactions` | Generieke ingestion-endpoint — geldt zowel voor handmatige invoer als voor POS-integraties die geen webhook maar een directe push gebruiken. Body volgt het interne genormaliseerde model. |
| `POST` | `/pos/{provider}/webhook` | Provider-specifiek webhook-eindpunt (zie sectie 6) |
| `POST` | `/transactions/bulk` | Bulk-import, array van transacties, elk item los ge-idempotency-checkt |
| `POST` | `/transactions/csv-import` | Multipart CSV-upload, wordt intern omgezet naar dezelfde bulk-pipeline |

**Beheer/leescontext:**

| Methode | Endpoint | Omschrijving |
|---|---|---|
| `GET` | `/transactions` | Lijst, filterbaar op status/datum/customer/pos_connection |
| `GET` | `/transactions/{id}` | Detail inclusief line items, refunds, voids |
| `POST` | `/transactions/{id}/refund` | Refund registreren (handmatig, of door een POS-webhook aangeroepen) |
| `POST` | `/transactions/{id}/void` | Void registreren |
| `POST` | `/transactions/{id}/link-customer` | Achteraf koppelen (zoals in de vorige versie van dit ontwerp) |
| `GET` | `/pos-connections` | Overzicht gekoppelde kassasystemen |
| `POST` | `/pos-connections` | Nieuwe koppeling aanmaken |
| `PATCH` | `/pos-connections/{id}` | Bijwerken (credentials, polling-interval, status) |
| `POST` | `/pos-connections/{id}/trigger-sync` | Handmatig een polling-cyclus forceren |
| `GET` | `/pos-connections/{id}/health` | Statusdetails t.b.v. dashboard (sectie 14) |
| `GET` | `/failed-transactions` | Error queue |
| `POST` | `/failed-transactions/{id}/retry` | Handmatige retry |
| `GET` | `/reconciliation/runs` | Overzicht reconciliatie-runs (sectie 12) |

---

## 6. Webhookarchitectuur

```
POS-systeem                Platform
    │                          │
    │  POST /pos/{provider}/webhook
    │  + HMAC-signature header │
    ├─────────────────────────▶│
    │                          │  1. Signature verifiëren (sectie 13)
    │                          │     — ongeldig? → 401, direct stoppen,
    │                          │       niets opgeslagen
    │                          │  2. Payload opslaan in pos_events
    │                          │     (ongeacht of verwerking hierna
    │                          │      lukt — audit-basis)
    │                          │  3. Snel 200 OK terugsturen
    │◀─────────────────────────┤     (binnen enkele seconden, om
    │        200 OK             │     POS-timeouts te voorkomen)
    │                          │
    │                          │  4. Async: normalisatie/validatie/
    │                          │     matching/opslag (zie sectie 2)
    │                          │     — dit gebeurt NA de 200 OK,
    │                          │     via een achtergrond-queue
    │                          │
    │                          │  5. Bij fout: naar failed_transactions
    │                          │     (sectie 11), POS-systeem hoeft
    │                          │     niets te weten — retries lopen
    │                          │     platform-intern, niet via de
    │                          │     POS-koppeling opnieuw
```

> **Ontwerpkeuze — direct 200 OK, verwerking async:** de meeste POS-providers hanteren een korte webhook-timeout (vaak 5-10 seconden) en beschouwen een trage response als een fout, wat tot onnodige retries van de kant van de POS leidt. Door de ruwe payload eerst op te slaan en pas daarna te verwerken, is de webhook-respons altijd snel én verliezen we nooit data, zelfs als de verwerking zelf faalt.

**Per-provider webhook-adapters:** elke `provider` in `pos_connections` heeft een eigen lichte adapter die alleen verantwoordelijk is voor (a) signature-verificatie volgens het schema van die provider, en (b) het omzetten van de providerspecifieke payloadvorm naar het interne genormaliseerde transactiemodel. Alles ná die stap (validatie, matching, opslag, reward-trigger) is **provider-onafhankelijke, gedeelde code** — dit is de kern van "generiek" in de opdracht: nieuwe POS-providers toevoegen betekent alleen een nieuwe adapter schrijven, niet de rest van de pijplijn aanpassen.

---

## 7. Reward triggering

```
transaction bereikt status: completed
        │
        ▼
Zijn alle regel-items genormaliseerd
(categorie gemapt, reward_eligible
per regel bepaald)?
        │
        ▼
Bereken eligible_amount:
  Σ (line_net_amount van regels
     met reward_eligible = true)
        │
        ▼
Publiceer event: transaction.completed
payload bevat: transactionId, customerId,
locationId, totalAmount, eligibleAmount,
occurredAt, lineItems[] (met category +
reward_eligible per regel)
        │
        ▼
Module 4 (Reward Engine) pakt dit event
op en voert de volledige rule-berekening
uit (zie Module 4-ontwerp) — deze module
bepaalt zelf GEEN percentage of bedrag,
alleen WELK deel van de rekening
reward-eligible is
```

**Belangrijke knip:** deze module bepaalt de **eligible_amount** (welk deel van de rekening in aanmerking komt, op basis van productuitsluitingen zoals alcohol/cadeaubonnen — zie sectie 9 voor hoe categorieën gemapt worden). De daadwerkelijke rewardpercentage-berekening, tier-bonussen, campagnes en multipliers zijn volledig de verantwoordelijkheid van Module 4. Dit is dezelfde scheiding als in de eerdere versie van dit ontwerp, nu explicieter gemaakt op regel-niveau in plaats van op transactie-niveau — noodzakelijk omdat productuitsluitingen nu een eerste-klas requirement zijn (alcohol, cadeaubonnen).

**Voorbeeld uit de opdracht, doorgerekend op dit niveau:**
```
Rekening: €184 (alle regels reward-eligible, geen uitsluitingen van toepassing)
eligible_amount = €184
→ event transaction.completed met eligibleAmount: 184.00
→ Module 4 berekent hierop 5% = €9,20 (details: zie Module 4-ontwerp)
```

---

## 8. Refunds

Vier scenario's, elk met een expliciet gedefinieerde invloed op eerder toegekende rewards. De reward-reversal-logica zelf (hoe Module 4 het bedrag terugdraait) hoort bij Module 4/3; deze module is verantwoordelijk voor het **correct en volledig** publiceren van wat er is gebeurd.

### Gedeeltelijke refund
```
transaction_refunds-rij met refund_type: partial
        │
        ▼
Bereken welk deel van de eligible_amount is geraakt:
  - Als refunded_line_items expliciet is opgegeven:
    eligible_amount van precies die regels
  - Als alleen een totaalbedrag is opgegeven (sommige
    POS-systemen geven geen regel-detail bij refund):
    proportioneel over alle regels naar rato
    (refunded_amount / total_amount × eligible_amount)
        │
        ▼
status → partially_refunded
        │
        ▼
Event: transaction.refunded
payload: transactionId, refundedAmount,
refundedEligibleAmount, refundType: partial
        │
        ▼
Module 4 draait reward proportioneel terug
```

### Volledige refund
Zelfde pad, met `refund_type: full`, `refundedEligibleAmount = eligible_amount` van de hele transactie. Status → `refunded`.

### Void
```
transaction_voids-rij aangemaakt
        │
        ▼
status → voided
        │
        ▼
Event: transaction.voided
        │
        ▼
Module 4: als er al een reward was
berekend (zeldzaam bij void, want void
gebeurt normaliter vóór afronding, maar
niet uitgesloten bij late POS-correcties)
→ volledige reward reversal, net als bij
  een full refund
```

### Chargeback
```
Ontvangen via betaalprovider-webhook
(niet via het POS-systeem zelf — chargebacks
lopen via de betaalprovider, niet de kassa)
        │
        ▼
transaction_chargebacks-rij aangemaakt,
status: received
        │
        ▼
status transactie → charged_back
(kan vanuit completed, partially_refunded,
of refunded ontstaan — zie lifecycle sectie 3)
        │
        ▼
Event: transaction.charged_back
        │
        ▼
Module 4: volledige reward reversal
(ongeacht eerdere refund-status — een
chargeback is de meest ingrijpende
terugdraai-actie en overschrijft alles)
        │
        ▼
Chargeback-status kan later wijzigen
(disputed → won/lost) — bij "won" wordt
de reward NIET automatisch hersteld;
dat vereist een expliciete handmatige
actie van een manager (financieel te
risicovol om automatisch te herstellen)
```

**Business rule:** reward reversal is altijd **proportioneel aan het teruggedraaide bedrag**, nooit alles-of-niets bij een gedeeltelijke refund — dit voorkomt dat een gast bij een kleine gedeeltelijke refund (bv. één verkeerd bezorgd drankje) al zijn tegoed van de hele avond kwijtraakt.

---

## 9. POS mapping

Twee soorten mapping, beide nodig om "generiek" waar te maken zonder dat categorieën/klanten per provider anders behandeld worden.

### `pos_product_mappings`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organization_id` | UUID (FK) | |
| `pos_connection_id` | UUID (FK) | |
| `external_product_id` | varchar | zoals aangeleverd door het POS-systeem |
| `external_product_name` | varchar | ter referentie/debugging |
| `internal_category` | varchar | genormaliseerde categorie, gebruikt door Module 4's productuitsluitingsregels (bv. `alcohol`, `gift_card`, `food`, `soft_drinks`) |
| `reward_eligible_override` | boolean, nullable | expliciete override, onafhankelijk van categorie-regels — voor uitzonderingsgevallen |
| `mapping_status` | enum | `mapped`, `unmapped`, `needs_review` |
| `created_at` / `updated_at` | timestamp | |

**Unmapped-producten-flow:** wanneer een `transaction_line_item` een `pos_product_id` bevat waarvoor nog geen mapping bestaat, wordt de regel toch opgeslagen (met `category = null`, `reward_eligible = true` als veilige default — liever een gast per ongeluk reward geven dan onterecht weigeren), en verschijnt het product in het dashboard onder **"unmatched products"** (sectie 14) zodat een beheerder het alsnog kan mappen. Toekomstige transacties met hetzelfde product worden dan automatisch correct verwerkt.

### `pos_customer_mappings`

Sommige POS-systemen hebben hun eigen interne klant-ID (bv. een loyaltykaart-nummer in het kassasysteem zelf). Deze tabel legt de relatie tussen dat externe ID en het interne `customer_id` (Module 1) vast, zodat niet bij elke transactie opnieuw via telefoon/e-mail gematcht hoeft te worden.

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `pos_connection_id` | UUID (FK) | |
| `external_customer_id` | varchar | |
| `customer_id` | UUID (FK naar Module 1) | |
| `matched_via` | enum | `external_id_direct`, `phone`, `email`, `manual` |
| `created_at` | timestamp | |

**Matching-volgorde bij een inkomende transactie:**
1. Is er al een `pos_customer_mapping` voor dit `external_customer_id` bij deze `pos_connection`? → gebruik direct.
2. Zo niet: bevat de payload een telefoonnummer/e-mailadres? → roep Module 1's `resolve-identity` aan.
3. Match gevonden via stap 2? → maak alsnog een `pos_customer_mapping`-rij aan, zodat toekomstige transacties via stap 1 sneller gaan.
4. Geen match? → transactie wordt opgeslagen met `customer_id = null` (anonieme transactie, consistent met Module 1/2's eerdere regel dat dit is toegestaan).

---

## 10. Idempotency

Kassasystemen sturen soms dezelfde transactie meerdere keren (netwerk-retries, webhook-herhaling na timeout, dubbele polling-cyclus). Twee lagen van bescherming:

**Laag 1 — payload-niveau (in `pos_events`):**
`payload_hash` (SHA-256 van de ruwe payload) wordt gecontroleerd vóór verwerking. Exact dezelfde payload nogmaals ontvangen → `processing_status: ignored_duplicate`, geen nieuwe transactie aangemaakt.

**Laag 2 — logisch niveau (in `transactions`):**
Unique constraint op `(pos_connection_id, external_transaction_id)`. Dit vangt het geval op waarin de payload *net iets* anders is (bv. een extra veld) maar het naar dezelfde onderliggende transactie verwijst — realistischer dan puur op hash vertrouwen, want sommige POS-systemen voegen bij een retry een tijdstempel toe die de hash zou laten verschillen.

```
Nieuwe pos_event binnen
        │
        ▼
payload_hash al bekend voor deze
pos_connection binnen de laatste
24 uur?
        │
   ┌────┴────┐
  Ja         Nee
   │           │
   ▼           ▼
Markeer      Ga door naar normalisatie
ignored_     → external_transaction_id
duplicate,   al aanwezig voor deze
stop         pos_connection?
                  │
             ┌────┴────┐
            Ja         Nee
             │           │
             ▼           ▼
        Markeer       Nieuwe transactie
        ignored_      aanmaken
        duplicate,
        koppel aan
        bestaande
        transaction_id
        (voor traceer-
        baarheid in
        pos_events)
```

**Bulk-import en CSV-fallback gebruiken exact dezelfde idempotency-laag** — elke regel in een CSV-bestand doorloopt dezelfde check op `external_transaction_id`, zodat een per ongeluk twee keer geüploade CSV geen dubbele omzet veroorzaakt.

---

## 11. Foutafhandeling

### `failed_transactions`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `pos_event_id` | UUID (FK) | |
| `organization_id` | UUID | |
| `location_id` | UUID, nullable | |
| `failure_stage` | enum | `normalization`, `validation`, `matching`, `storage` |
| `error_message` | text | |
| `error_details` | jsonb | gestructureerde context (bv. welk veld ontbrak) |
| `retry_count` | integer | default `0` |
| `max_retries` | integer | default `5` |
| `next_retry_at` | timestamp, nullable | exponential backoff |
| `status` | enum | `pending_retry`, `retrying`, `resolved`, `abandoned` |
| `resolved_at` | timestamp, nullable | |
| `resolved_by` | enum, nullable | `automatic_retry`, `manual_staff` |

**Retry-strategie:** exponentiële backoff (bv. 1 min, 5 min, 30 min, 2 uur, 12 uur — 5 pogingen, configureerbaar). Na `max_retries` → status `abandoned`, zichtbaar in het dashboard (sectie 14) als iets dat menselijke aandacht nodig heeft. Een beheerder kan handmatig retryen via `POST /failed-transactions/{id}/retry`, wat de backoff-teller reset.

**Onderscheid met refunds/voids:** `failed_transactions` gaat over transacties die **niet verwerkt konden worden** (technische fout: ontbrekend veld, netwerkfout naar een mapping-lookup, etc.) — niet over transacties die wél verwerkt zijn maar achteraf financieel gecorrigeerd worden. Dat laatste loopt via sectie 8.

---

## 12. Reconciliation

Dagelijkse (configureerbare frequentie) automatische controle die vaststelt of wat het platform heeft ontvangen, overeenkomt met wat het POS-systeem daadwerkelijk heeft verwerkt — cruciaal omdat een gemiste webhook nooit vanzelf opvalt zonder actieve controle.

### `pos_sync_runs`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `pos_connection_id` | UUID (FK) | |
| `run_type` | enum | `polling`, `reconciliation`, `manual_trigger` |
| `started_at` | timestamp | |
| `completed_at` | timestamp, nullable | |
| `transactions_found_at_pos` | integer, nullable | (indien de provider een telbaar totaal levert) |
| `transactions_ingested` | integer | |
| `discrepancy_count` | integer | default `0` |
| `discrepancy_details` | jsonb, nullable | lijst van `external_transaction_id`'s die bij de POS bekend zijn maar niet in het platform (of andersom) |
| `status` | enum | `success`, `partial_success`, `failed` |

**Reconciliatieproces (voor providers die een "lijst alle transacties van vandaag"-endpoint bieden):**
```
Dagelijkse job (bv. 03:00, na sluitingstijd)
        │
        ▼
Voor elke actieve pos_connection:
  1. Haal volledige transactielijst van
     die dag op bij de POS (provider-API)
  2. Vergelijk external_transaction_id's
     met wat er lokaal is opgeslagen
  3. Ontbrekend bij ons? → automatisch
     alsnog ingest proberen (via dezelfde
     normalisatie-pijplijn als een normale
     ingestion)
  4. Ontbrekend bij POS maar wij hebben
     het wel? → markeren als discrepantie,
     NIET automatisch verwijderen (kan een
     legitieme handmatige/CSV-transactie
     zijn) — zichtbaar voor beheerder
        │
        ▼
pos_sync_runs-rij met resultaat opgeslagen
```

Voor providers zonder zo'n lijst-endpoint (alleen webhook, geen bulk-ophaal-mogelijkheid) is reconciliation beperkt tot het monitoren van `last_successful_sync_at` versus de verwachte frequentie — als er bijvoorbeeld 4 uur geen webhook is binnengekomen tijdens openingstijden, wordt dat een `pos_connections.status: error`-signaal.

---

## 13. Security

- **Webhook-signature-verificatie (HMAC)** — elke inkomende webhook wordt gecontroleerd tegen de `webhook_secret_ref` van de betreffende `pos_connection`, vóór er iets wordt opgeslagen. Ongeldige signature → `401`, geen `pos_events`-rij aangemaakt (voorkomt dat het platform als open dataput voor willekeurige payloads fungeert).
- **API-credentials nooit in platte tekst** — `api_credentials_ref`/`webhook_secret_ref` verwijzen naar een secrets-manager (consistent met de architectuurprincipes uit de basisopdracht: "secrets management").
- **Rate limiting per `pos_connection`** — voorkomt dat een storing bij één POS-provider (bv. een runaway retry-loop aan hún kant) het platform voor andere locaties beïnvloedt.
- **IP-allowlisting waar de provider dit ondersteunt** — optioneel per `pos_connection`, extra verdedigingslaag boven op HMAC.
- **Toegang tot rauwe `pos_events`-payloads is beperkt** — deze kunnen incidenteel gevoelige data bevatten (bv. gedeeltelijke betaalkaartgegevens die een provider ten onrechte meestuurt); alleen Organization Admins en het systeem zelf hebben leestoegang, niet Location Managers of Staff.
- **Idempotency als security-eigenschap, niet alleen correctheid** — voorkomt ook moedwillig misbruik (herhaald dezelfde transactie "spelen" om reward-fraude te plegen).

---

## 14. Admin UI

**POS Integration Dashboard** — het scherm dat expliciet in de opdracht wordt gevraagd:

```
┌──────────────────────────────────────────────────────────────┐
│  POS Integrations — Beachclub Noordwijk                        │
├──────────────────────────────────────────────────────────────┤
│  Lightspeed          ● Actief    Laatste sync: 2 min geleden    │
│  Transacties vandaag: 142        Errors: 0                      │
│                                                                  │
│  Untill (Restaurant Leiden)  ⚠ Vertraagd  Laatste sync: 3u 12m   │
│  Transacties vandaag: 38         Errors: 2                      │
├──────────────────────────────────────────────────────────────┤
│  Integration Health                                             │
│  ✓ Webhook-ontvangst: OK (laatste 24u)                          │
│  ⚠ Polling-vertraging: Untill loopt achter (verwachte interval   │
│    overschreden)                                                 │
│  ✗ 2 mislukte transacties wachten op retry                      │
├──────────────────────────────────────────────────────────────┤
│  Unmatched customers (12)          Unmatched products (5)       │
│  [tabel: extern ID, laatste       [tabel: extern product-ID,    │
│   poging, actie: handmatig         naam, aantal keer gezien,    │
│   koppelen]                        actie: mappen naar categorie]│
├──────────────────────────────────────────────────────────────┤
│  Retries in wachtrij (2)                                        │
│  [tabel: transactie-referentie, fout, volgende poging over,     │
│   actie: nu retryen]                                             │
├──────────────────────────────────────────────────────────────┤
│  Reconciliation                                                  │
│  Laatste run: vandaag 03:00 — 2 discrepanties gevonden           │
│  [bekijk details]                                                 │
└──────────────────────────────────────────────────────────────┘
```

**Schermonderdelen, direct gekoppeld aan de opdracht-eisen:**
- **Laatste synchronisatie** → `pos_connections.last_synced_at` / `last_successful_sync_at`, per connectie getoond
- **Transacties vandaag** → live telling uit `transactions` gefilterd op `pos_connection_id` + datum
- **Errors** → aantal open `failed_transactions` per connectie
- **Unmatched customers** → externe klant-ID's zonder `pos_customer_mapping`, met een knop om handmatig te koppelen aan een bestaand Module 1-profiel
- **Unmatched products** → `pos_product_mappings` met `mapping_status: unmapped`, met een knop om direct een categorie toe te wijzen
- **Retries** → open `failed_transactions`, met directe "nu retryen"-actie
- **Integration health** → samengestelde status op basis van `pos_connections.status`, recente webhook-activiteit, en openstaande reconciliatie-discrepanties

---

## 15. Audit

Gedeelde `audit_log`-infrastructuur (Module 1, sectie 13), aangevuld met de reeds transactie-specifieke append-only tabellen die in deze module zelf al als audit-trail dienen: `pos_events` (elke ruwe ontvangst), `transaction_refunds`/`voids`/`chargebacks` (elke financiële correctie), `pos_sync_runs` (elke reconciliatie-poging).

Expliciet in `audit_log` gelogd (bovenop wat de eigen tabellen al vastleggen):
- Wijzigingen aan `pos_connections` (credentials-rotatie, status-wijziging, polling-interval-aanpassing) — dit raakt de beveiliging en betrouwbaarheid van de hele integratie en verdient een expliciete audit-regel
- Handmatige product-/klant-mapping-acties door een beheerder
- Handmatige retries van `failed_transactions`

---

## 16. Koppelingen met CRM, Wallet, Reward Engine en Analytics

| Module | Relatie |
|---|---|
| **1. Customer & CRM** | `resolve-identity` voor klant-matching (sectie 9); `transaction.completed`/`refunded`/`voided`/`charged_back`-events werken de denormalized cache bij (bezoeken, lifetime spend, favoriete locatie/moment) |
| **3. Wallet & Credit** | Ontvangt indirect, via Module 4's `reward.calculated`/reversal-events — geen directe koppeling vanuit deze module |
| **4. Reward Engine** | Primaire consument van `transaction.completed` (met `eligibleAmount` per transactie/regel, sectie 7) en van de refund/void/chargeback-events (sectie 8) voor reward reversal |
| **9. Reservations & Occupancy Booster** | `reservation_id` op transacties (indien bekend) koppelt omzet direct aan een reservering; `table_reference` en `occurred_at` voeden bezettingsgraad-berekeningen |
| **10. Analytics & AI** | Bronmodule voor alle omzet-, refund- en integratiegezondheid-rapportages; `pos_sync_runs` en `failed_transactions` voeden ook operationele (niet alleen financiële) dashboards |

---

## Voorstel implementatievolgorde

1. **Fase 1 — Interne transactiekern:** `transactions`, `transaction_line_items`, het genormaliseerde model, `POST /transactions` (handmatige/generieke ingestion). Dit is dezelfde basis als de vorige versie van dit ontwerp en blijft de fundering.
2. **Fase 2 — Idempotency & `pos_events`:** ruwe payload-opslag, dubbele-detectie — moet er zijn vóórdat er ook maar één echte POS-koppeling wordt aangesloten, anders is elke storing een dataprobleem.
3. **Fase 3 — Eén webhook-adapter (bv. Lightspeed) als bewijs van het generieke ontwerp:** valideert dat de adapter-laag (sectie 6) daadwerkelijk providers ontkoppelt van de rest van de pijplijn.
4. **Fase 4 — Refunds/voids/chargebacks:** noodzakelijk zodra er met echt geld gewerkt wordt, maar de basis (fase 1-3) kan zonder.
5. **Fase 5 — Polling + bulk/CSV-fallback:** voor providers zonder webhook-ondersteuning, en als vangnet bij storingen.
6. **Fase 6 — Reconciliation + admin dashboard:** operationeel comfort en betrouwbaarheidsgarantie, bouwt voort op alle voorgaande fasen.
7. **Fase 7 — Tweede en derde POS-adapter:** het echte bewijs dat "meerdere POS-systemen" werkt zoals ontworpen.

---

Wil je dat we hierna Module 4 (Reward Engine, herziene versie met de rule engine en simulator) volledig uitwerken, of eerst de database-migratie voor deze herziene Module 2 bouwen en testen?
