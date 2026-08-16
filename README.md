# Loyalty Platform — Module 1: Customer & CRM

Fundament van het horeca/hospitality loyaltyplatform. Deze repo bevat op dit
moment het **database schema en de migraties** voor Module 1. Volgende
modules (Transactions & POS, Wallet & Credit, Reward Engine, ...) worden
hier als vervolg-migraties en later als NestJS-modules aan toegevoegd.

**Stack:** Node.js/TypeScript · Prisma · Supabase (Postgres) · GitHub · Vercel

---

## Belangrijk: status van dit schema

Het `prisma/schema.prisma`-bestand en de SQL-migratie in
`prisma/migrations/20260813000000_init_customer_crm/` zijn **met de hand
geschreven en op elkaar afgestemd**, niet automatisch gegenereerd — de
sandbox waarin dit is gebouwd had geen netwerktoegang tot
`binaries.prisma.sh` (waar Prisma's engine-binaries vandaan komen), dus
`prisma generate` / `prisma migrate dev` konden daar niet draaien.

Dat is geen probleem voor gebruik — de SQL is functioneel identiek aan wat
Prisma zelf zou genereren — maar doe **lokaal** wel eerst een validatie-check
voordat je naar productie migreert (stap 3 hieronder).

---

## 1. Supabase-project aanmaken

1. Ga naar [supabase.com](https://supabase.com) → **New project**.
2. Kies een sterk database-wachtwoord en bewaar dit.
3. Ga naar **Project Settings → Database → Connection string**.
4. Je hebt twee connectiestrings nodig:
   - **Connection pooling (Transaction mode, poort 6543)** → wordt `DATABASE_URL`
   - **Direct connection (poort 5432)** → wordt `DIRECT_URL`

   Waarom beide: serverless functies (Vercel) openen bij elke aanroep een
   nieuwe databaseverbinding — zonder pooling loop je snel tegen Postgres'
   connectielimiet aan. Prisma Migrate heeft daarentegen een
   sessie-connectie nodig, vandaar de directe URL apart.

5. Kopieer `.env.example` naar `.env` en vul beide URL's in.

```bash
cp .env.example .env
```

---

## 2. Lokaal installeren

```bash
npm install
```

Dit installeert Prisma en genereert **geen** engine-download-problemen op
een normale (niet-gesandboxde) machine.

---

## 3. Schema valideren en client genereren

```bash
npx prisma validate      # controleert schema.prisma op syntaxfouten
npx prisma generate      # genereert de TypeScript Prisma Client
```

---

## 4. Migratie naar Supabase uitvoeren

Omdat de migratie-SQL al klaarstaat, hoef je niets te "diffen" — je past
hem direct toe:

```bash
npx prisma migrate deploy
```

Dit voert `prisma/migrations/20260813000000_init_customer_crm/migration.sql`
uit tegen je Supabase-database en registreert de migratie in de
`_prisma_migrations`-tabel, zodat toekomstige migraties (Module 2, 3, ...)
hierop voortbouwen.

> Werk je liever met `prisma migrate dev` tijdens verdere ontwikkeling
> (met shadow database, automatische diff-generatie)? Dat kan vanaf hier
> gewoon — de bestaande migratie wordt dan als startpunt herkend.

**Controle:** open **Supabase → Table Editor** en check dat alle tabellen
(`organizations`, `customers`, `customer_identities`, `customer_consents`,
`customer_timeline_events`, `audit_log`, ...) er staan.

---

## 5. Sanity-check met het seedscript

```bash
npm run db:seed
```

Dit maakt een testorganisatie ("Beach Hospitality Group"), een locatie
("Beachclub Noordwijk") en het voorbeeldklantprofiel (Jan de Vries) aan
zoals in de moduleopdracht beschreven — inclusief identities, consent en
een eerste timeline-event. Handig om te verifiëren dat alle relaties
correct staan vóórdat je de API erbovenop bouwt.

---

## 6. Naar GitHub

```bash
git init
git add .
git commit -m "Module 1: Customer & CRM — schema en migratie"
git branch -M main
git remote add origin https://github.com/<jouw-account>/loyalty-platform.git
git push -u origin main
```

`.env` staat in `.gitignore` — commit nooit je database-credentials.

---

## 7. Koppelen aan Vercel

1. Ga naar [vercel.com/new](https://vercel.com/new) → importeer de GitHub-repo.
2. Zet de environment variables (`DATABASE_URL`, `DIRECT_URL`) in
   **Project Settings → Environment Variables** — zelfde waarden als in je
   lokale `.env`.
3. Voeg in `package.json` een `postinstall`-script toe zodra er ook een
   NestJS-app in de repo staat, zodat Vercel bij elke deploy automatisch de
   Prisma Client genereert:
   ```json
   "postinstall": "prisma generate"
   ```
   (Dit script staat er nu nog niet in, omdat er nog geen deploybare app-laag
   is — dat komt met de eerste API-endpoints.)

Op dit moment bevat de repo alleen schema/migraties, dus er is nog niets
"live" te draaien op Vercel — dat wordt relevant zodra we de NestJS API
(resolve-identity, CRUD-endpoints, etc.) uit Module 1 sectie 9 toevoegen.

---

## 8. NestJS API draaien

De API-laag implementeert de endpoints uit sectie 9 van het Module 1-ontwerp
(`/customers`, `/resolve-identity`, `/merge`, consent-beheer, timeline,
notes, tags, custom fields) met de permissiematrix uit sectie 10 als guards.

```bash
npm install
npx prisma generate
npm run build
npm run start:dev
```

De server draait dan op `http://localhost:3000`.

### Auth-stub (belangrijk om te weten)

Er is nog geen Users/Roles/authenticatie-module gebouwd — dat hoort bij een
gedeelde platform/auth-module die nog niet bestaat. Tot die er is, wordt de
tenant- en actor-context uit request-headers gelezen:

| Header | Betekenis |
|---|---|
| `x-organization-id` | UUID van de organisatie (**verplicht** op elk endpoint) |
| `x-actor-id` | UUID van de staff-user of API-key (optioneel) |
| `x-actor-type` | `staff` \| `system` \| `api_key` \| `customer_self_service` |
| `x-permissions` | komma-gescheiden lijst, bv. `customer.read,customer.write` |

Voorbeeld met `curl`:

```bash
curl -X POST http://localhost:3000/organizations/<ORG_ID>/customers \
  -H "Content-Type: application/json" \
  -H "x-organization-id: <ORG_ID>" \
  -H "x-actor-type: staff" \
  -H "x-permissions: customer.write" \
  -d '{"firstName":"Jan","lastName":"de Vries","email":"jan@example.nl","sourceChannel":"pos"}'
```

Zodra de echte auth-module er is, vervang je alleen
`src/common/decorators/current-context.decorator.ts` — de rest van de
codebase leest context via die ene decorator.

### Belangrijkste endpoints

```
POST   /organizations/:orgId/customers
GET    /organizations/:orgId/customers
GET    /organizations/:orgId/customers/duplicates
POST   /organizations/:orgId/customers/resolve-identity
GET    /organizations/:orgId/customers/:id
PATCH  /organizations/:orgId/customers/:id
DELETE /organizations/:orgId/customers/:id
POST   /organizations/:orgId/customers/:id/identities
DELETE /organizations/:orgId/customers/:id/identities/:identityId
GET    /organizations/:orgId/customers/:id/timeline
POST   /organizations/:orgId/customers/:id/notes
GET    /organizations/:orgId/customers/:id/notes
POST   /organizations/:orgId/customers/:id/tags/:tagId
DELETE /organizations/:orgId/customers/:id/tags/:tagId
GET    /organizations/:orgId/customers/:id/consents
POST   /organizations/:orgId/customers/:id/consents
GET    /organizations/:orgId/customers/:id/consents/history
POST   /organizations/:orgId/customers/:id/merge
POST   /organizations/:orgId/customers/:id/export
POST   /organizations/:orgId/customers/:id/anonymize
GET    /organizations/:orgId/customers/:id/locations
GET    /organizations/:orgId/tags
POST   /organizations/:orgId/tags
GET    /organizations/:orgId/custom-fields
POST   /organizations/:orgId/custom-fields
```

## 9. Deployen naar Vercel

### Nieuwe endpoints — Module 2 & 4

```
POST   /organizations/:orgId/transactions
GET    /organizations/:orgId/transactions
GET    /organizations/:orgId/transactions/:id
POST   /organizations/:orgId/transactions/:id/refund
POST   /organizations/:orgId/transactions/:id/void
GET    /organizations/:orgId/pos-connections
POST   /organizations/:orgId/pos-connections
GET    /organizations/:orgId/pos-connections/:id/health
GET    /organizations/:orgId/reward-rules
POST   /organizations/:orgId/reward-rules
PATCH  /organizations/:orgId/reward-rules/:id
DELETE /organizations/:orgId/reward-rules/:id
POST   /organizations/:orgId/reward-simulations
GET    /organizations/:orgId/reward-calculations
GET    /organizations/:orgId/reward-calculations/:id
POST   /organizations/:orgId/reward-calculations/:id/resimulate
```

**Voorbeeld — het doorgerekende voorbeeld uit het Module 4-ontwerp, live via de simulator:**
```bash
curl -X POST http://localhost:3000/organizations/<ORG_ID>/reward-simulations \
  -H "Content-Type: application/json" \
  -H "x-organization-id: <ORG_ID>" \
  -H "x-permissions: reward_rule.read" \
  -d '{"amount": 100, "tierId": "<GOLD_TIER_ID>"}'
```

### Eerlijk over de scope van deze API-laag

Gebouwd en (na jouw lokale `npm run build`) compileerbaar:
- **Transacties invoeren** (`POST /transactions`) — berekent automatisch de eligible amount uit regel-items en triggert de Reward Engine synchroon, in-process (niet via een echte event-bus/message-queue — dat is een architecturale vereenvoudiging t.o.v. het ontwerp, prima voor één-proces-deployment, maar zou in een groter systeem via een echte queue moeten lopen)
- **Refund/void** met proportionele reward-reversal — een **vereenvoudigde** reversal (het bedrag wordt proportioneel teruggerekend zonder de volledige multi-stage berekening opnieuw te doorlopen op het verlaagde bedrag); een productierijpe versie zou dat wel moeten doen
- **Reward-regels CRUD**, inclusief versioning zodra een regel al gebruikt is (sectie 15 van het ontwerp)
- **Rule Simulator** (`POST /reward-simulations`) — hergebruikt exact dezelfde rekencode als een live transactie, precies zoals het ontwerp vereist
- **Calculation trace** — elke berekening (live of simulatie) bevat het volledige stap-voor-stap logboek

**Bewust niet gebouwd in deze stap** (wel volledig ontworpen in de bijbehorende markdown-documenten):
- Webhook-ontvangst per POS-provider, polling-worker, bulk/CSV-import
- Reconciliation-job en het volledige integration-dashboard
- Customer-caps en location-caps worden nog niet gehandhaafd in de berekening (staan als tabellen klaar in het schema, sectie 6, maar de cap-check in stadium 4 is nog niet geïmplementeerd — alleen `maximumRewardPerTransaction` werkt al)
- Challenge-regels (stadium 5) — aparte pijplijn, nog niet gebouwd


De repo bevat nu `api/index.ts` (serverless entrypoint, wrapt de NestJS-app
in een gecachete Express-handler) en `vercel.json` (routeert alle requests
daarnaartoe).

1. Importeer de GitHub-repo op [vercel.com/new](https://vercel.com/new)
2. Zet `DATABASE_URL` en `DIRECT_URL` in **Project Settings → Environment
   Variables**
3. Deploy — Vercel draait automatisch `npm install` (met `postinstall:
   prisma generate`) en `npm run build`

> **Let op:** de Prisma Client-engine wordt bij `npm install` gedownload
> van `binaries.prisma.sh`. Dat werkt gewoon op Vercel's build-servers en
> op een normale ontwikkelmachine met internettoegang — alleen deze
> specifieke ontwikkel-sandbox waarin dit project is opgezet had daar geen
> toegang toe. Test dus altijd eerst lokaal (stap 8) vóór je naar Vercel
> pusht.

## Volgende stap

**Module 2 (Transactions & POS) en Module 4 (Reward Engine)** zijn nu ook als
database-migratie toegevoegd (`20260814000000_transactions_pos_reward_engine`).
Deze migratie is **echt getest**, op dezelfde manier als de eerste: lokaal
tegen een verse Postgres 16-installatie gedraaid, met een concrete
dataset die exact het doorgerekende voorbeeld uit het Module 4-ontwerp
reproduceert (base 5% + Gold-tier 1% = 6%, ×2 Double Credit-campagne =
**€12,00** reward op een transactie van €100) — en de idempotency-constraint
uit Module 2 (geen dubbele transactie met hetzelfde extern ID op dezelfde
POS-koppeling) is expliciet gecontroleerd: een duplicaat-insert gaf terecht
een database-fout.

**Om deze migratie ook bij jou uit te voeren:**

```bash
npx prisma generate
npx prisma migrate deploy
npm run db:seed:rewards
```

> `db:seed:rewards` hergebruikt de organisatie uit de eerste seed
> (`beach-hospitality-group`) — draai dus eerst `npm run db:seed` als je dat
> nog niet had gedaan, of het script maakt 'm alsnog aan (upsert).

**Wat deze migratie toevoegt (21 nieuwe tabellen):**
- Module 2: `pos_connections`, `pos_events`, `transactions`,
  `transaction_line_items` (+ modifiers), `transaction_refunds`,
  `transaction_voids`, `transaction_chargebacks`, `pos_product_mappings`,
  `pos_customer_mappings`, `failed_transactions`, `pos_sync_runs`
- Module 4: `reward_rules`, `reward_customer_caps`, `reward_location_caps`,
  `reward_calculations`, `reward_challenge_progress`

**Nog te bouwen:** de NestJS API-laag voor deze twee modules (endpoints uit
Module 2 sectie 5 en Module 4 sectie 11), en de webhook-adapter voor een
eerste concrete POS-provider zodra dat relevant wordt.

## 10. Module 3 (Wallet & Credit) — database

Toegevoegd via `20260815000000_wallet_credit`: `wallets`,
`wallet_ledger_entries`, `wallet_ledger_allocations`, `wallet_passes`,
`credit_rules` — het lot-based ledger-model uit het Module 3-ontwerp.

**Getest, net als de vorige migraties:** lokaal tegen een verse Postgres 16,
met een concreet scenario dat het hele pad doorloopt:
1. Transactie van €184 → earn-lot van €9,20 (10 dagen geleden)
2. Een *volgend* bezoek (andere transactie) → gedeeltelijke besteding van
   €5,00, met een allocatie-rij die expliciet naar de oorspronkelijke lot
   verwijst — traceerbaarheidsquery bevestigd: je kunt van elke besteding
   exact aanwijzen uit welke verdien-gebeurtenis hij kwam
3. Een verlopen lot van €3,00 → expiratie-flow, lot netjes afgesloten
4. Reconciliatie: de ledger herberekenen en vergelijken met de
   denormalized cache — dit ving zelfs een fout in mijn eigen testscript
   op (een vergeten cache-update), precies zoals sectie 15 bedoeld is

```bash
npx prisma generate
npx prisma migrate deploy
```

**Nog te bouwen:** de NestJS API-laag voor Module 3 (redemption
reserve/confirm-flow, admin-correcties, Wallet-pas-endpoints) staat nog
niet — alleen schema + migratie zijn nu klaar, net als bij Module 2/4 in
eerste instantie.

## 11. Nieuwe endpoints — Module 3 (Wallet & Credit)

```
GET    /organizations/:orgId/customers/:customerId/wallet
GET    /organizations/:orgId/customers/:customerId/wallet/ledger
GET    /organizations/:orgId/customers/:customerId/wallet/ledger/:entryId
POST   /organizations/:orgId/customers/:customerId/wallet/redemptions/reserve
POST   /organizations/:orgId/customers/:customerId/wallet/redemptions/:reservationId/confirm
POST   /organizations/:orgId/customers/:customerId/wallet/redemptions/:reservationId/cancel
POST   /organizations/:orgId/customers/:customerId/wallet/adjustments
```

**Belangrijk:** het aanmaken van een transactie (`POST /transactions`) boekt
nu automatisch een `earn`-ledger entry op de wallet van de klant, als de
Reward Engine een positief bedrag berekent — precies het "transactie →
reward → zichtbaar tegoed"-pad waar we naartoe hebben gewerkt.

**Voorbeeld — volledige cyclus testen:**
```bash
# 1. Transactie invoeren (levert reward op, boekt automatisch een earn)
curl -X POST http://localhost:3000/organizations/<ORG_ID>/transactions \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" \
  -H "x-permissions: transaction.write" \
  -d '{"locationId":"<LOCATION_ID>","customerId":"<CUSTOMER_ID>","grossAmount":100,"netAmount":100,"totalAmount":100,"paymentMethod":"card"}'

# 2. Saldo bekijken
curl http://localhost:3000/organizations/<ORG_ID>/customers/<CUSTOMER_ID>/wallet \
  -H "x-organization-id: <ORG_ID>" -H "x-permissions: wallet.read"

# 3. Tegoed reserveren voor besteding bij een ANDERE (volgende) transactie
curl -X POST http://localhost:3000/organizations/<ORG_ID>/customers/<CUSTOMER_ID>/wallet/redemptions/reserve \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" -H "x-permissions: wallet.redeem" \
  -d '{"amount":5,"transactionId":"<EEN_ANDERE_TRANSACTIE_ID>","idempotencyKey":"test-1"}'

# 4. Bevestigen (reservationId uit de vorige response)
curl -X POST http://localhost:3000/organizations/<ORG_ID>/customers/<CUSTOMER_ID>/wallet/redemptions/<RESERVATION_ID>/confirm \
  -H "x-organization-id: <ORG_ID>" -H "x-permissions: wallet.redeem"
```

### Eerlijk over de scope van deze wallet-API

- **Redemption-reserveringen staan in-memory** (een `Map` in de service), niet in een database-tabel of Redis. Dit werkt correct zolang je **één** serverinstantie draait (zoals nu, lokaal of op Vercel als één functie), maar overleeft geen herstart en werkt niet betrouwbaar met meerdere gelijktijdige instanties. Een productierijpe versie heeft hiervoor een echte gedeelde store nodig.
- **Tegoedregels (`credit_rules`) worden nog niet gevalideerd** bij redemption — de endpoints bestaan (via Prisma), maar de validatie (minimumbesteding, max-percentage, uitgesloten dagen/producten) uit sectie 6 van het ontwerp is nog niet in `WalletService.reserveRedemption()` geïmplementeerd.
- **Apple/Google Wallet pass-endpoints zijn niet gebouwd** — het datamodel (`wallet_passes`) staat klaar, de pass-generatie/webhook-ontvangst (sectie 9) niet.
- **Refund/void reward-reversal (Module 4) landt nog niet automatisch als `refund_reversal`-ledger entry** — die koppeling (Module 2/4's refund-events → Module 3's ledger) is nog niet gelegd.
- **De expiratie-achtergrondjob draait niet** — het model ondersteunt expiratie volledig (zoals lokaal getest), maar er is geen scheduled job die hem in productie daadwerkelijk uitvoert.


## 12. Module 5 (Campaign Manager) & Module 6 (Messaging) — database

Toegevoegd via `20260816000000_campaign_messaging`: 15 nieuwe tabellen —
`campaigns`, `campaign_templates`, `campaign_audience_snapshot`,
`campaign_recipients`, `campaign_metrics_snapshots` (Module 5);
`message_providers`, `message_templates`, `message_send_requests`,
`message_queue_items`, `message_events`, `message_links`,
`customer_push_tokens`, `message_frequency_caps`,
`customer_message_send_log`, `brand_voice_profiles`, `ai_copy_requests`
(Module 6).

**Getest:** alle vier migraties samen (Module 1, 2+4, 3, 5+6) foutloos
tegen een verse Postgres 16 — **56 tabellen** in totaal. Functioneel
scenario doorlopen: een "Sunny Day"-campagne met een audience-snapshot die
correct onderscheid maakt tussen de behandelde groep en de controlegroep,
en een bericht dat het volledige pad template → gerenderde tekst → queue
item → delivery-event doorloopt.

```bash
npx prisma generate
npx prisma migrate deploy
```

**Nog te bouwen:** de NestJS API-laag voor Module 5/6 (campagne-wizard-
endpoints, message-verzending, AI-copy-aanroep) staat nog niet — alleen
schema + migratie zijn nu klaar. De koppeling tussen Module 5's
campagne-incentive en Module 4's `reward_rules` (het `campaignId`-veld
bestaat al in Module 4's schema) moet nog daadwerkelijk in code gelegd
worden, evenals de in Module 5's ontwerp benoemde uitbreiding op de
Reward Engine (audience-restrictie op campagne-gekoppelde regels).

## 13. Module 7 (Segmentation Engine) — database

Toegevoegd via `20260817000000_segmentation`: `segments`,
`segment_membership`, `churn_risk_scores`. **Belangrijk:** deze migratie
vervangt de vooruitkijkende `segments`/`customer_segment_memberships`-stub
uit Module 1 door de echte implementatie (drop-and-recreate — de stub werd
nooit door applicatiecode gebruikt, dus dit is veilig).

**Getest:** alle vijf migraties samen foutloos — 57 tabellen. Functioneel
scenario: het exacte churn-voorbeeld uit het ontwerp doorgerekend — een
klant die normaliter elke 20 dagen komt en nu 35 dagen weg is (ratio 1,75)
wordt terecht als "At Risk" gemarkeerd, terwijl een klant die normaliter
elke 60 dagen komt en nu 50 dagen weg is (ratio 0,83, dus binnen zijn eigen
patroon) dat terecht **niet** wordt — het bewijst dat persoonlijke cadans
werkt zoals bedoeld, niet een vaste termijn. Ook getest: het AND-segment
uit de opdracht (`lifetimeSpend > 1000 AND isAtRisk`) selecteert correct
alleen de juiste klant.

```bash
npx prisma generate
npx prisma migrate deploy
```

**Nog te bouwen:** de NestJS API-laag (segment-builder-endpoints, preview,
de churn-batch-job zelf) staat nog niet — alleen schema + migratie.

## 14. Module 8 (Automated Journeys) — database

Toegevoegd via `20260818000000_automated_journeys`: `journeys`,
`journey_versions`, `journey_nodes`, `journey_edges`,
`journey_enrollments`, `journey_node_executions`, `journey_goals` — 7
nieuwe tabellen, samen goed voor **64 tabellen totaal** in het platform.

**Getest:** alle zes migraties samen foutloos. Functioneel het **exacte
First Visit-voorbeeld uit het ontwerp** opgebouwd — trigger → send_push →
wait 14 dagen → condition → send_push/end — als een echte graaf van nodes
en edges in de database, en drie kernmechanismen bevestigd:
1. Duplicate-enrollment-detectie vindt een reeds actieve inschrijving
2. De scheduler-query vindt een `waiting`-enrollment terecht **niet** zolang
   de wait-periode nog loopt
3. Diezelfde query vindt de enrollment wél zodra de wait-periode voorbij is

```bash
npx prisma generate
npx prisma migrate deploy
```

**Nog te bouwen:** de NestJS API-laag (flow-uitvoeringsengine, de
scheduler-worker zelf, de builder-UI-endpoints) staat nog niet — alleen
schema + migratie.

## 15. Module 9 (Reservations & Occupancy Booster) — database

Toegevoegd via `20260819000000_reservations_occupancy`: 8 nieuwe tabellen
— `location_capacity_settings`, `reservation_connections`,
`reservations`, `weather_forecasts`, `forecast_runs`,
`occupancy_opportunities`, `occupancy_recommendations`,
`occupancy_attribution_results` — samen goed voor **72 tabellen totaal**.

**Getest:** alle zeven migraties samen foutloos. Functioneel het **exacte
"Sunny Lunch Booster"-scenario uit het ontwerp** opgebouwd en geverifieerd:
- Bezettingsberekening: 76 geboekte covers / 200 capaciteit = **38%**,
  exact het cijfer uit de opdracht
- Weer gekoppeld: 27°C, zonnig
- Het volledige voorstel: naam, doelgroep (624), incentive (double credit),
  geschatte max. reward-kosten (€1.248), status `pending_approval` — een
  voorstel, nog geen actieve campagne, precies de vereiste scheiding
  tussen recommendation en execution

```bash
npx prisma generate
npx prisma migrate deploy
```

**Nog te bouwen:** de NestJS API-laag (forecast-berekening, opportunity-
detectiejob, de koppeling die een goedgekeurd voorstel omzet in een
Module 5-draft-campagne) staat nog niet — alleen schema + migratie.

## 16. Module 10 (Analytics & AI Campaign Assistant) — database

Toegevoegd via `20260820000000_analytics_ai_assistant`: `analytics_snapshots`,
`cohort_retention_snapshots`, `ai_assistant_conversations`,
`ai_assistant_messages`, `ai_tool_calls`, `ai_campaign_suggestions`,
`proactive_insights` — 7 tabellen, en daarmee **compleet: 79 tabellen,
alle 10 kernmodules van het platform.**

**Getest:** alle acht migraties samen foutloos. Functioneel het **exacte
AI-assistent-voorbeeld uit het ontwerp** opgebouwd: de vraag "Morgen
slecht weer, lunch staat maar 30% vol" met drie echte tool-aanroepen
(`getOccupancyForecast: 31%`, `getHistoricalOccupancy: 56%`,
`getSegmentPreview: 412`), een AI-antwoord dat uitsluitend die cijfers
citeert, en een voorstel — **412 klanten, €3.090 geschatte max. exposure,
status `pending_approval`** — nooit een actieve campagne. Elk cijfer in
het voorstel is herleidbaar tot een `ai_tool_calls`-rij; geen enkel
verzonnen getal.

```bash
npx prisma generate
npx prisma migrate deploy
```

**Nog te bouwen:** de NestJS API-laag (het dashboard, de KPI-berekeningsjobs,
de daadwerkelijke AI-conversatie-engine met een LLM-koppeling) staat nog
niet — alleen schema + migratie, net als bij de voorgaande modules.

## 17. Nieuwe endpoints — Module 5 (Campaign Manager)

```
POST   /organizations/:orgId/campaigns
GET    /organizations/:orgId/campaigns
POST   /organizations/:orgId/campaigns/preview
GET    /organizations/:orgId/campaigns/:id
PATCH  /organizations/:orgId/campaigns/:id
POST   /organizations/:orgId/campaigns/:id/launch
POST   /organizations/:orgId/campaigns/:id/pause
POST   /organizations/:orgId/campaigns/:id/resume
POST   /organizations/:orgId/campaigns/:id/cancel
GET    /organizations/:orgId/campaigns/:id/results
```

**Belangrijk:** `launch` doet echt werk — audience-resolutie, controlegroep-
splitsing, en (indien een incentive is ingesteld) het aanmaken van de
onderliggende Module 4-`reward_rule` met `campaignId` gevuld. Vanaf dat
moment tellen nieuwe transacties van gasten in de doelgroep automatisch
mee in de reward-berekening.

### Eerlijk over de scope

- **De audience-filter-evaluatie gebeurt in applicatiecode** (laadt tot
  5.000 klanten van de organisatie en filtert in JavaScript), niet als
  een geoptimaliseerde, geïndexeerde SQL-query. Dit is correct maar niet
  geschikt voor zeer grote klantenbestanden — Module 7's "query
  generator" (nog niet gebouwd) hoort dit uiteindelijk te vervangen.
- **De audience-restrictie op campagne-gekoppelde reward-regels is NIET
  geïmplementeerd** — het ontwerp benoemt expliciet dat de Reward Engine
  hiervoor moet controleren of een klant in de campagne-snapshot zit
  (sectie 6 van het ontwerp); die controle staat nu nog niet in
  `RewardEngineService`. Dit betekent dat een gelanceerde campagne-
  incentive **voor de hele organisatie** geldt, niet alleen de
  doelgroep — een bekend gat, met de oplossing al ontworpen maar nog niet
  gebouwd.
- **Scheduling (period/recurring), approvals en daadwerkelijke
  berichtverzending zijn niet geïmplementeerd** — `launch` ondersteunt
  alleen directe uitvoering, en registreert ontvangers zonder iets te
  versturen (Module 6's API staat er ook nog niet).

## 18. Nieuwe endpoints — Module 6 (Messaging)

```
POST   /organizations/:orgId/messaging/send
GET    /organizations/:orgId/messaging/templates
POST   /organizations/:orgId/messaging/templates
GET    /organizations/:orgId/messaging/queue
GET    /organizations/:orgId/messaging/queue/:id
```

**Het "campagne → verzending"-pad werkt nu écht:** `POST
/campaigns/:id/launch` roept intern `MessagingService.send()` aan voor
elke gekozen kanaal, met échte consent- en frequency-cap-controle tegen
Module 1's data. Dit is het eerste moment waarop een campagne meer doet
dan alleen een reward-regel aanmaken — er gaat nu ook daadwerkelijk een
bericht "uit" (gesimuleerd, zie hieronder).

**Voorbeeld — een template aanmaken en een campagne ermee lanceren:**
```bash
# 1. Template aanmaken (templateGroupKey moet overeenkomen met de
#    campagnenaam in lowercase-met-underscores)
curl -X POST http://localhost:3000/organizations/<ORG_ID>/messaging/templates \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" \
  -H "x-permissions: message.template.write" \
  -d '{"templateGroupKey":"sunny_day","channel":"push","category":"marketing","name":"Sunny Day","locale":"nl","body":"Hi {{first_name}}, je hebt nog {{credit_balance}} Beach Credit. {{#if credit_balance_raw > 10}}Genoeg voor een drankje!{{/if}}"}'

# 2. Campagne aanmaken en lanceren (zie Module 5-voorbeelden)
```

### Eerlijk over de scope

- **Geen echte provider-adapters** (APNs/FCM/Postmark/Twilio) — een
  "verzending" schrijft direct een `message_queue_items`-rij met status
  `sent`, zonder iets echt te versturen. De architectuur (provider-
  abstractie, sectie 2 van het ontwerp) staat klaar, maar is niet
  aangesloten op een echte dienst.
- **Quiet hours (sectie 8) zijn niet geïmplementeerd** — berichten
  worden nooit uitgesteld, ongeacht tijdstip.
- **Retries (sectie 11), link tracking (sectie 13), push tokens (sectie 14)
  en AI copy (sectie 16) zijn niet gebouwd** — alleen de kern: template-
  rendering, consent-check, frequency-cap-check, en de wachtrij-registratie.
- **Consent-check is een pragmatische aanname**: voor `wallet`-kanaal
  wordt push-consent gebruikt (er is geen apart wallet-consenttype in
  Module 1's schema) — een kleine, gedocumenteerde vereenvoudiging.

## 19. Nieuwe endpoints — Module 7 (Segmentation Engine)

```
POST   /organizations/:orgId/segments
GET    /organizations/:orgId/segments
POST   /organizations/:orgId/segments/preview
GET    /organizations/:orgId/segments/:id
PATCH  /organizations/:orgId/segments/:id
DELETE /organizations/:orgId/segments/:id
GET    /organizations/:orgId/segments/:id/members
POST   /organizations/:orgId/segments/:id/recompute
POST   /organizations/:orgId/segments/:id/duplicate
POST   /organizations/:orgId/churn-risk/recompute
GET    /organizations/:orgId/customers/:customerId/churn-risk
```

**Belangrijk:** de audience-filter-evaluator uit Module 5 is uitgebreid met
`isAtRisk`/`churnRiskScore`, en wordt nu door Module 5 én 7 **gedeeld**
(`src/common/audience-filter.service.ts`) — precies zoals het ontwerp
voorschreef: één definitie van wat een conditie betekent, niet twee.

**Het churn-algoritme uit sectie 11 van het ontwerp draait nu écht:**
`POST /churn-risk/recompute` berekent voor elke klant de persoonlijke
cadans-ratio (`daysSinceLastVisit / averageVisitFrequencyDays`), markeert
als `isAtRisk` bij een ratio > 1,5, en valt terug op een organisatie-
gemiddelde voor klanten met minder dan 2 bezoeken — exact zoals lokaal al
getest.

**Voorbeeld:**
```bash
# Bereken churn-risico voor de hele organisatie
curl -X POST http://localhost:3000/organizations/<ORG_ID>/churn-risk/recompute \
  -H "x-organization-id: <ORG_ID>" -H "x-permissions: segment.write"

# Maak het "High Value At Risk"-segment uit het ontwerp
curl -X POST http://localhost:3000/organizations/<ORG_ID>/segments \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" \
  -H "x-permissions: segment.write" \
  -d '{"name":"High Value At Risk","segmentType":"custom","evaluationMode":"cached","definition":{"combinator":"AND","conditions":[{"field":"lifetimeSpend","operator":"gt","value":1000},{"field":"isAtRisk","operator":"isTrue"}]}}'
```

### Eerlijk over de scope

- **`recompute` moet handmatig aangeroepen worden** — er is geen
  achtergrondjob die dit periodiek (uurlijks/dagelijks, zoals het ontwerp
  beschrijft) automatisch doet. Hetzelfde geldt voor churn-risk-
  herberekening.
- **Geen incrementele, event-gedreven herevaluatie** (sectie 10 van het
  ontwerp) — elke `recompute` is een volledige herberekening.
- **Standaardsegmenten (sectie 13) zijn niet vooraf geseed** — je moet ze
  zelf aanmaken via `POST /segments`.
- **Nested groups (sub-groepen binnen groepen) worden wel correct
  geëvalueerd** door de gedeelde `AudienceFilterService`, maar zijn nog
  niet apart getest via de API — alleen lokaal, in de Postgres-tests van
  eerder.

## 20. Nieuwe endpoints — Module 8 (Automated Journeys)

```
POST   /organizations/:orgId/journeys
GET    /organizations/:orgId/journeys
GET    /organizations/:orgId/journeys/:id
POST   /organizations/:orgId/journeys/:id/publish
POST   /organizations/:orgId/journeys/:id/pause
POST   /organizations/:orgId/journeys/:id/resume
POST   /organizations/:orgId/journeys/:id/stop
GET    /organizations/:orgId/journeys/:id/enrollments
POST   /organizations/:orgId/journeys/:id/test
POST   /organizations/:orgId/journeys/scheduler/run
```

**Dit is de flow-uitvoeringsengine, geen simulatie.** Elke `POST
/transactions` roept nu `JourneyEngineService.handleEvent(orgId,
'transaction.completed', customerId)` aan, die alle gepubliceerde journeys
met die trigger vindt en de klant inschrijft (mét duplicate-enrollment-
preventie) — en direct begint met het doorlopen van de nodes.

**Voorbeeld — het First Visit-voorbeeld uit het ontwerp, als échte
API-aanroep** (gebruik `tempId`'s om nodes aan elkaar te knopen, de
service zet ze om naar echte UUID's):
```bash
curl -X POST http://localhost:3000/organizations/<ORG_ID>/journeys \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" \
  -H "x-permissions: journey.write" \
  -d '{
    "name": "First Visit",
    "triggerType": "event",
    "eventName": "transaction.completed",
    "nodes": [
      {"tempId":"1","nodeType":"trigger"},
      {"tempId":"2","nodeType":"send_push","config":{"templateGroupKey":"tegoed_check"}},
      {"tempId":"3","nodeType":"end"}
    ],
    "edges": [
      {"fromTempId":"1","toTempId":"2"},
      {"fromTempId":"2","toTempId":"3"}
    ]
  }'

# Publiceren (nodig, anders vuurt de trigger niet)
curl -X POST http://localhost:3000/organizations/<ORG_ID>/journeys/<JOURNEY_ID>/publish \
  -H "x-organization-id: <ORG_ID>" -H "x-permissions: journey.publish"

# Vanaf nu: elke nieuwe transactie voor een klant triggert deze journey
```

### Eerlijk over de scope

- **Geen echte scheduler/cron** — `wait`-nodes zetten een enrollment
  correct op `waiting` met een `resumeAt`, maar niets roept
  `POST .../scheduler/run` automatisch aan. In productie hoort hier een
  scheduled job (bv. elke 5 minuten) voor te draaien.
- **`give_reward`- en `webhook`-nodes zijn niet geïmplementeerd** — ze
  worden overgeslagen met een gelogde no-op, de flow loopt gewoon door.
- **Versioning is vereenvoudigd**: `publish` markeert de enige bestaande
  versie als gepubliceerd; het aanmaken van een *nieuwe* versie op een
  al-gepubliceerde journey (sectie 10 van het ontwerp) is niet
  geïmplementeerd — je kunt een journey nu niet bewerken ná publicatie.
- **`condition`-nodes ondersteunen alleen `daysSinceLastVisit`** in deze
  bouw-pas — niet de volledige AND/OR-DSL uit Module 7 (dat zou wel de
  gedeelde `AudienceFilterService` kunnen hergebruiken, maar is nu nog
  niet gekoppeld).

## 21. Uitbreiding: puntensysteem met variabele wisselkoers

Op verzoek toegevoegd — een alternatief voor het standaard euro-gebaseerde
Beach Credit, geïnspireerd op een eerder puntensysteem: "1 punt per euro
besteed, inwisselbaar vanaf 250 punten, waarbij 250 punten doordeweeks
€10 waard is en in het weekend nog maar €5" — precies de yield-management-
toepassing die al in de allereerste basisprincipes van het platform stond.

**Nieuw:**
- `credit_rules.minimumRedemptionBalance` — een harde drempel: onder dit
  saldo is helemaal niets inwisselbaar, ook niet gedeeltelijk
- `redemption_rate_rules` — dag-gebaseerde wisselkoersregels (punten per
  euro), het spiegelbeeld van Module 4's dag/tijd-multipliers, maar dan
  aan de inwissel-kant in plaats van de verdien-kant
- `GET .../wallet/redemption-quote?euroAmount=X` — vertaalt een gewenst
  euro-bedrag naar het benodigde aantal punten **tegen de koers van
  vandaag**, en meldt of de drempel is gehaald

**Getest (lokaal, tegen echte Postgres):** exact het scenario uit het
oude systeem gereproduceerd — 250 punten leverden op een maandag €10,00
op en op een vrijdag €5,00, en een saldo van 200 punten werd terecht
geblokkeerd (`mag_inwisselen: false`) tegen de 250-drempel.

**Ontwerpkeuze — géén organisatiebrede "modus"-schakelaar:** een
organisatie die geen `redemption_rate_rules` instelt, krijgt automatisch
de bestaande 1-punt-is-1-euro-werking (`pointsPerEuro` default `1`) —
niets aan de huidige euro-gebaseerde flow verandert tenzij een organisatie
bewust wisselkoersregels toevoegt.

**Voorbeeld:**
```bash
# Wisselkoers-regels instellen (exact het oude systeem)
curl -X POST http://localhost:3000/organizations/<ORG_ID>/redemption-rate-rules \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" -H "x-permissions: credit_rules.write" \
  -d '{"name":"Weekdagen","appliesOnDays":["monday","tuesday","wednesday","thursday"],"pointsPerEuro":25}'
curl -X POST http://localhost:3000/organizations/<ORG_ID>/redemption-rate-rules \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" -H "x-permissions: credit_rules.write" \
  -d '{"name":"Weekend","appliesOnDays":["friday","saturday","sunday"],"pointsPerEuro":50}'

# Drempel instellen
curl -X POST http://localhost:3000/organizations/<ORG_ID>/credit-rules \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" -H "x-permissions: credit_rules.write" \
  -d '{"minimumRedemptionBalance":250}'

# Quote opvragen — hoeveel punten kost €10 vandaag?
curl "http://localhost:3000/organizations/<ORG_ID>/customers/<CUSTOMER_ID>/wallet/redemption-quote?euroAmount=10" \
  -H "x-organization-id: <ORG_ID>" -H "x-permissions: wallet.read"
```

### Eerlijk over de scope

- **`reserveRedemption` gebruikt nog steeds "punten/wallet-eenheden" als
  invoer**, niet een euro-bedrag — de bedoelde flow is: eerst een quote
  opvragen (hoeveel punten voor dit euro-bedrag vandaag), en dát
  puntenaantal aan `reserveRedemption` meegeven. Een geïntegreerde
  "reserveer €10 tegen de koers van vandaag"-endpoint (die dit in één
  stap doet) is niet gebouwd.
- **Geen tijdvenster binnen een dag** (alleen dag-van-de-week) — het
  ontwerp van Module 4 ondersteunt wel tijdvensters (`timeWindowStart/End`)
  voor reward-multipliers; `redemption_rate_rules` heeft dat veld bewust
  nog niet, kan later op dezelfde manier worden toegevoegd.

## 22. Nieuwe endpoints — Module 9 (Reservations & Occupancy Booster)

```
POST   /organizations/:orgId/reservations
GET    /organizations/:orgId/reservations
PATCH  /organizations/:orgId/reservations/:id/status
POST   /organizations/:orgId/location-capacity-settings
GET    /organizations/:orgId/locations/:locationId/capacity-settings
POST   /organizations/:orgId/weather-forecasts
GET    /organizations/:orgId/locations/:locationId/occupancy?date=...&servicePeriod=...
POST   /organizations/:orgId/locations/:locationId/occupancy/forecast
POST   /organizations/:orgId/occupancy-opportunities/detect
GET    /organizations/:orgId/occupancy-recommendations
GET    /organizations/:orgId/occupancy-recommendations/:id
POST   /organizations/:orgId/occupancy-recommendations/:id/approve
POST   /organizations/:orgId/occupancy-recommendations/:id/dismiss
```

**De drie-staps-scheiding werkt écht:** `approve` maakt een echte Module
5-campagne aan met `status: draft`, gebruikmakend van dezelfde
`CampaignsService.create()` als een handmatig aangemaakte campagne — de
daadwerkelijke lancering blijft een aparte, bewuste `POST
/campaigns/:id/launch`-aanroep. Geen enkel pad in deze module kan een
campagne automatisch starten.

**Voorbeeld — het complete "Sunny Lunch Booster"-pad:**
```bash
# 1. Capaciteit instellen
curl -X POST http://localhost:3000/organizations/<ORG_ID>/location-capacity-settings \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" -H "x-permissions: reservation.write" \
  -d '{"locationId":"<LOC_ID>","servicePeriod":"lunch","maxCovers":200}'

# 2. Reservering(en) invoeren
curl -X POST http://localhost:3000/organizations/<ORG_ID>/reservations \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" -H "x-permissions: reservation.write" \
  -d '{"locationId":"<LOC_ID>","dateTime":"2026-08-20T13:00:00Z","servicePeriod":"lunch","covers":76}'

# 3. Weer invoeren
curl -X POST http://localhost:3000/organizations/<ORG_ID>/weather-forecasts \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" -H "x-permissions: reservation.write" \
  -d '{"locationId":"<LOC_ID>","forecastDate":"2026-08-20","temperatureCelsius":27,"condition":"sunny"}'

# 4. Bezetting bekijken (het "MORGEN"-scherm)
curl "http://localhost:3000/organizations/<ORG_ID>/locations/<LOC_ID>/occupancy?date=2026-08-20&servicePeriod=lunch" \
  -H "x-organization-id: <ORG_ID>" -H "x-permissions: reservation.read"

# 5. Forecast berekenen
curl -X POST http://localhost:3000/organizations/<ORG_ID>/locations/<LOC_ID>/occupancy/forecast \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" -H "x-permissions: reservation.write" \
  -d '{"date":"2026-08-20","servicePeriod":"lunch"}'

# 6. Opportunity detecteren (forecastRunId uit stap 5)
curl -X POST http://localhost:3000/organizations/<ORG_ID>/occupancy-opportunities/detect \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" -H "x-permissions: reservation.write" \
  -d '{"locationId":"<LOC_ID>","forecastRunId":"<RUN_ID>"}'

# 7. Voorstel goedkeuren -> Module 5-draft-campagne
curl -X POST http://localhost:3000/organizations/<ORG_ID>/occupancy-recommendations/<REC_ID>/approve \
  -H "x-organization-id: <ORG_ID>" -H "x-permissions: campaign.launch"
```

### Eerlijk over de scope

- **Forecastmodel gebruikt alleen historisch gemiddelde + weer** — geen
  seizoens-, events-, feestdag- of lead-time-correctie (ontwerp sectie 3).
  Zonder genoeg historische data valt het terug op een neutrale 50%.
- **Incentive-drempels zijn hardcoded** (< 30% → 3×, < 45% → 2×), niet de
  configureerbare `occupancy_incentive_policy` uit het ontwerp.
- **`estimatedMaxRewardExposure` gebruikt een vaste aanname** (€60
  gemiddelde besteding) in plaats van de werkelijke gemiddelde besteding
  per gematchte klant — een pragmatische versimpeling.
- **Geen achtergrondjob** die periodiek automatisch forecasts/opportunities
  genereert — elke stap wordt nu handmatig via de API getriggerd.

## 23. Nieuwe endpoints — Module 10 (Analytics & AI Campaign Assistant)

```
GET    /organizations/:orgId/dashboard
GET    /organizations/:orgId/analytics/credit
GET    /organizations/:orgId/analytics/campaigns
POST   /organizations/:orgId/ai-assistant/ask
GET    /organizations/:orgId/ai-assistant/conversations/:id
GET    /organizations/:orgId/ai-campaign-suggestions
POST   /organizations/:orgId/ai-campaign-suggestions/:id/approve
POST   /organizations/:orgId/ai-campaign-suggestions/:id/dismiss
```

**Alle dashboard-KPI's zijn live berekend uit echte data** — geen aparte
analyticsdatabase: leden, nieuwe leden deze maand, loyalty-omzet, repeat
visit rate, outstanding credit, credit dat binnen 14 dagen verloopt, At
Risk-aantal — stuk voor stuk direct uit Module 1/2/3/7's eigen tabellen.

**De AI-assistent gebruikt echte tool-aanroepen, volledig gelogd
(`ai_tool_calls`) — nooit een verzonnen cijfer.** `POST
/ai-assistant/ask` roept Module 9's forecastmodel en de gedeelde
`AudienceFilterService` aan, en genereert alleen een voorstel als de
cijfers dat rechtvaardigen. Ook hier: **approve** maakt een Module
5-conceptcampagne aan, nooit een actieve.

**Voorbeeld — het weer-en-bezetting-scenario uit het ontwerp:**
```bash
curl -X POST http://localhost:3000/organizations/<ORG_ID>/ai-assistant/ask \
  -H "Content-Type: application/json" -H "x-organization-id: <ORG_ID>" -H "x-permissions: ai_assistant.use" \
  -d '{"promptText":"Morgen slecht weer, lunch staat maar 30% vol. Wat kunnen we doen?","locationId":"<LOC_ID>","date":"2026-08-20"}'
```

### Eerlijk over de scope — dit is de belangrijkste nuance van deze module

**Er wordt geen externe LLM aangeroepen om vrije tekst te interpreteren en
zelf te bepalen welke tools nodig zijn.** In plaats daarvan draait `ask()`
een **vaste, deterministische reeks tool-aanroepen** die past bij het
canonieke weer-en-bezettingsscenario uit het ontwerp (forecast ophalen,
doelgroep bepalen), en stelt het antwoord samen uit de **echte** resultaten
van die aanroepen. De architectuur — tool-functies, volledige logging,
nooit-verzonnen-cijfers, de recommendation/approval-scheiding — is wél
precies zoals ontworpen. Wat ontbreekt is de taalbegrip-laag: een manager
kan nu niet zomaar elke willekeurige vraag stellen ("waarom daalt repeat
visit?", "welke VIP's zijn lang niet geweest?") en een zinvol antwoord
verwachten — alleen de weer/bezetting-vraag wordt daadwerkelijk goed
beantwoord. Een echte integratie met een taalmodel (dat zelf tools kiest
op basis van de vraag) is de voor de hand liggende vervolgstap.

## 24. Echte e-mailverzending voor campagnes/journeys (Module 6)

Op verzoek toegevoegd: het `email`-kanaal in `MessagingService` stuurt nu
**écht** een e-mail via Mailgun (dezelfde koppeling als de dagafsluiting),
in plaats van alleen een database-registratie te maken. Push, wallet en
SMS blijven gesimuleerd — die vereisen elk hun eigen, aparte
providerkoppeling (native pushinfrastructuur, resp. een SMS-provider
zoals MessageBird/Twilio) die nog niet is aangesloten.

**Praktisch effect:** zodra een campagne of journey een `send_email`-actie
uitvoert naar een klant met een bekend e-mailadres, komt dat bericht nu
daadwerkelijk aan — mits `MAILGUN_API_KEY`/`MAILGUN_DOMAIN` zijn
ingesteld (dezelfde variabelen als bij de dagafsluiting-e-mail). Als
Mailgun niet geconfigureerd is, of de verzending faalt, wordt dat netjes
vastgelegd in `message_queue_items.status = 'failed'` — de campagne/
journey-flow zelf blokkeert of breekt daar nooit op.

**`MailgunService` is verplaatst** van `src/analytics/` naar
`src/common/` — nodig om een cirkelvormige module-afhankelijkheid te
voorkomen (Analytics → Campaigns → Messaging → Analytics), aangezien
zowel Messaging als Analytics deze service nu gebruiken.

## 25. Echte WhatsApp-verzending (Module 6)

Op verzoek toegevoegd: `WhatsAppService` (`src/common/whatsapp.service.ts`)
verstuurt echte berichten via Meta's WhatsApp Cloud API, met dezelfde
architectuur als de Mailgun-koppeling.

**Belangrijk verschil met e-mail — dit is een echte beperking van
WhatsApp zelf, niet van dit platform:** Meta staat alleen door het
bedrijf-geïnitieerde berichten toe via een **vooraf goedgekeurd
sjabloon** (buiten een actief 24-uurs klantcontact-venster om — en
marketingberichten zoals "dubbele punten" vallen daar altijd onder).
Vrije tekst versturen zoals bij e-mail is voor WhatsApp dus niet
mogelijk.

**Hoe dit hier is opgelost, met een bewuste vereenvoudiging:**
`templateGroupKey` van het interne berichtsjabloon wordt ook gebruikt als
de naam van het bij Meta goedgekeurde sjabloon (houd deze twee gelijk
wanneer je een sjabloon specifiek voor WhatsApp aanmaakt), met een vaste
parametervolgorde (voornaam, dan tegoedsaldo). Een volledig flexibele
koppeling tussen willekeurige sjabloonvariabelen en Meta-sjabloonvelden
is een grotere uitbreiding, pas zinvol zodra er echte, goedgekeurde
sjablonen zijn om tegen te testen.

**Benodigde omgevingsvariabelen bij Vercel:**
- `WHATSAPP_ACCESS_TOKEN` — permanent access-token uit Meta Business Manager
- `WHATSAPP_PHONE_NUMBER_ID` — ID van je geverifieerde WhatsApp-afzendernummer

**Wat je zelf nog moet regelen bij Meta, vóórdat dit werkt:**
1. Een Meta Business-account aanmaken/koppelen
2. WhatsApp Business Platform activeren, telefoonnummer verifiëren
3. Minstens één berichtsjabloon aanmaken en laten goedkeuren (kan uren tot dagen duren)

## 26. Klanten-/tegoedimport (Piggy-migratie)

Op verzoek toegevoegd: een importmodule voor het migreren van bestaande
klanten en hun puntensaldo vanuit een ander systeem (bijv. Piggy), via
een .csv- of .xlsx-bestand. Bouwt volledig voort op de bestaande
Customer/Wallet/ledger-architectuur — **geen** los klant- of saldomodel.

**Belangrijke, bewuste aanpassing aan de specificatie — serverloze
omgeving:** dit platform draait op Vercel serverless functies (max. 30
seconden per aanroep, geen achtergrond-wachtrij-infrastructuur zoals een
Bull/Redis-queue). Een import van duizenden rijen kan dus niet in één
lange HTTP-aanroep worden verwerkt. In plaats daarvan verwerkt het
`/commit`-endpoint telkens een kleine batch (standaard 100 rijen), en
roept de browser dit endpoint automatisch herhaald aan totdat alles
verwerkt is — dat lost zowel het tijdslimiet-probleem als de gevraagde
voortgangsindicatie in één keer op, zonder een aparte wachtrijserver.
Bestandsgrootte is hierdoor ook begrensd (max. 5 MB, max. 10.000 rijen
per bestand) — grotere bronbestanden moeten worden opgesplitst.

**Datamodel:** `ImportJob` (één per geüpload bestand, met kolom-mapping,
conversie-instellingen, voortgangstellingen) en `ImportRecord` (één per
rij, met de bepaalde actie en — na boeking — de gekoppelde
`WalletLedgerEntry`). `Customer` heeft twee nieuwe velden
(`externalId`/`externalSource`) voor herkenning bij een latere
heraanlevering — geen apart identificatiemodel.

**Boeking:** elke gemigreerde balans wordt vastgelegd als een echte
`WalletLedgerEntry` met `entryType: migration_import` (nieuwe waarde in
het bestaande enum), inclusief metadata (bronklant-ID, oorspronkelijke
punten, conversieratio, bestandsnaam) — nooit een rechtstreekse
aanpassing van het wallet-saldo. Bij "vervang saldo" wordt eerst een
`correction`-boeking gemaakt die het bestaande saldo naar nul terugzet,
zodat de volledige geschiedenis intact blijft.

**Matching:** uitsluitend op exact e-mailadres, genormaliseerd
telefoonnummer, of eerder-opgeslagen externe klant-ID — nooit op naam of
geboortedatum. Tegenstrijdige matches (e-mail wijst naar klant A,
telefoon naar klant B) gaan altijd naar "controle nodig", nooit
automatisch gekozen.

**Bestandsverwerking:** gebruikt `exceljs` (niet het populairdere
`xlsx`-pakket) — de npm-registry-versie van `xlsx` heeft twee bekende,
ongepatchte kwetsbaarheden (prototype pollution, ReDoS) die specifiek
relevant zijn bij het verwerken van geüploade, niet-vertrouwde bestanden;
`exceljs` heeft dat probleem niet.

**Bekende vereenvoudigingen t.o.v. de volledige specificatie:**
- Geen malware-scan op geüploade bestanden (alleen bestandstype/-grootte-validatie) — een aparte antivirus-scandienst is niet aangesloten.
- Ruwe bestandsdata wordt tijdelijk in de database bewaard (geen aparte objectopslag beschikbaar) en automatisch geleegd zodra een import voltooid is.
- Rollback verwijdert door de import aangemaakte klanten alleen als ze werkelijk geen enkele andere activiteit hebben (transacties, reserveringen, overige ledgermutaties) — anders blijft het profiel bestaan en wordt alleen de saldomutatie teruggedraaid.

## Alle tien modules — overzicht

| # | Module | Ontwerp | Schema/migratie | API |
|---|---|---|---|---|
| 1 | Customer & CRM | ✅ | ✅ getest, live | ✅ getest, live |
| 2 | Transactions & POS | ✅ | ✅ getest, live | ✅ getest, live |
| 3 | Wallet & Credit | ✅ | ✅ getest, live | ✅ getest, live |
| 4 | Reward Engine | ✅ | ✅ getest, live | ✅ getest, live |
| 5 | Campaign Manager | ✅ | ✅ getest | — |
| 6 | Messaging | ✅ | ✅ getest | — |
| 7 | Segmentation Engine | ✅ | ✅ getest | — |
| 8 | Automated Journeys | ✅ | ✅ getest | — |
| 9 | Reservations & Occupancy | ✅ | ✅ getest | — |
| 10 | Analytics & AI Assistant | ✅ | ✅ getest | — |

## Projectstructuur

```
loyalty-platform/
├── api/
│   └── index.ts              # Vercel serverless entrypoint
├── src/
│   ├── audit/                 # Gedeelde audit-log service (sectie 13)
│   ├── common/
│   │   ├── decorators/         # @RequirePermissions, @Ctx (auth-stub)
│   │   ├── guards/              # PermissionsGuard
│   │   └── filters/             # Prisma error → HTTP response mapping
│   ├── customers/               # Module 1 kern: CRUD, identity, consent, merge, AVG
│   ├── org-resources/            # Tags & custom fields (organisatiebreed)
│   ├── prisma/                    # Injectable PrismaService
│   ├── app.module.ts
│   └── main.ts
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
├── .env.example
├── .gitignore
├── nest-cli.json
├── vercel.json
├── package.json
├── tsconfig.json
└── README.md
```
