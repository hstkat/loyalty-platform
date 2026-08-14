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

## Volgende stap

Twee opties om vanaf hier verder te bouwen:

1. **NestJS API-laag voor Module 1** — de endpoints uit sectie 9 van het
   ontwerp (`/customers`, `/customers/resolve-identity`,
   `/customers/{id}/merge`, consent- en export-endpoints), met de
   permissie-matrix uit sectie 10 als guards.
2. **Doorbouwen naar Module 2 (Transactions & POS)** — de migratie die de
   `visit_count`/`lifetime_spend`-velden op `customers` daadwerkelijk gaat
   voeden via events.

## Projectstructuur

```
loyalty-platform/
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
│       ├── migration_lock.toml
│       └── 20260813000000_init_customer_crm/
│           └── migration.sql
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```
