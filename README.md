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

**Module 2 (Transactions & POS)** — de migratie en module die
`visit_count`/`lifetime_spend` op `customers` daadwerkelijk gaat voeden via
events, en die de basis legt voor Wallet & Credit (Module 3) daarna.

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
