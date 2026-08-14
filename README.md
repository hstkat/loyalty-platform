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
