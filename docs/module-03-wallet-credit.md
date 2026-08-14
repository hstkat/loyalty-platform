# Module 3 — Wallet & Credit

> Onderdeel van het horeca/hospitality loyaltyplatform. Bouwt voort op Module 1 (Customer & CRM), Module 2 (Transactions & POS) en Module 4 (Reward Engine). Deze module is waar een `reward.calculated`-uitkomst daadwerkelijk "landt" als zichtbaar, inwisselbaar tegoed — en waar dat tegoed weer wordt afgeboekt bij besteding. Financiële betrouwbaarheid staat hier voorop: **elk saldo moet op elk moment herleidbaar zijn tot de exacte reeks mutaties die ertoe heeft geleid.**

---

## 1. Walletmodel

Elke loyaltyklant (Module 1 `Customer`) heeft precies **één wallet** — een 1-op-1-relatie, aangemaakt op het moment dat een klant voor het eerst tegoed verdient (niet al bij profielaanmaak, om lege wallets voor nooit-actieve leden te vermijden).

Een wallet toont vijf afgeleide grootheden, elk met een precieze betekenis:

| Grootheid | Betekenis |
|---|---|
| **Beschikbaar tegoed** | Direct besteedbaar — niet verlopen, niet gereserveerd, niet nog "vers" van dezelfde rekening |
| **Pending tegoed** | Zojuist verdiend, maar nog niet besteedbaar omdat het van **dezelfde rekening** komt als waarmee de gast nu zou willen afrekenen (de regel "pas bruikbaar vanaf volgende bezoek") |
| **Gereserveerd tegoed** | Tijdelijk vastgehouden tijdens een lopende afrekening, om dubbel gebruik te voorkomen (zie sectie 6) |
| **Verlopen tegoed** | Cumulatief bedrag dat ooit is verdiend maar nooit is besteed vóór de vervaldatum — puur informatief, telt niet mee in "beschikbaar" |
| **Lifetime earned / lifetime redeemed** | Nooit-dalende tellers, voor klantprofiel en analytics (sluit aan op Module 1's gelijknamige velden, die dit wallet-saldo als bron gebruiken) |

**Cruciaal ontwerpprincipe, letterlijk uit de opdracht:** geen van deze vijf grootheden is een los, direct beschrijfbaar veld. Ze zijn **allemaal afgeleid** van de ledger (sectie 3) en worden alleen bijgewerkt als rekenkundig gevolg van een nieuwe ledger entry — nooit los overschreven, ook niet door een admin-correctie (die zelf ook via een ledger entry loopt, zie sectie 12).

---

## 2. Credit lifecycle

Elk stukje verdiend tegoed doorloopt een eigen levenscyclus, onafhankelijk van andere tegoed-"lots" in dezelfde wallet — dit is het lot-based model dat in sectie 3 verder wordt uitgewerkt.

```
                    reward.calculated ontvangen (Module 4)
                            │
                            ▼
                    Ledger entry: earn
                    status: pending
                    (want: nog dezelfde rekening/bezoek)
                            │
                            ▼
        Rekening wordt afgesloten (transaction.completed
        definitief, geen verdere wijzigingen aan díe rekening)
                            │
                            ▼
                    status: available
                    (nu pas besteedbaar bij een ANDERE,
                    latere transactie — "volgende bezoek")
                            │
              ┌─────────────┼──────────────────┐
              ▼             ▼                  ▼
        (deels) besteed  vervaldatum       oorspronkelijke
        bij latere       bereikt zonder    aankoop wordt
        transactie       besteding         gerefund/voided
              │             │                  │
              ▼             ▼                  ▼
        status:        status:            status:
        redeemed        expired            reversed
        (deels: nog     (ledger entry:     (ledger entry:
        steeds          expiration)        refund_reversal)
        available voor
        het restant)
```

**Waarom "pending → available" geen aparte ledger entry is:** de statusovergang gebeurt automatisch zodra de earn-entry niet meer aan de eigen bron-transactie kan worden gekoppeld voor een nieuwe afrekening (zie sectie 6, redemption-logica) — er hoeft geen "activatie"-mutatie geboekt te worden, want er verandert geen bedrag, alleen besteedbaarheid. Dit houdt de ledger trouw aan de opdracht: alleen de expliciet genoemde entry-typen (earn, redeem, bonus, campaign bonus, manual adjustment, refund reversal, expiration, transfer, correction) bestaan als daadwerkelijke rijen.

---

## 3. Ledgerarchitectuur

### Het lot-model (waarom, en hoe)

Elke **credit-verhogende** ledger entry (`earn`, `bonus`, `campaign_bonus`, een positieve `manual_adjustment`, een positieve kant van een `transfer`) is een zelfstandige **credit lot**: een apart, volgbaar bedrag met een eigen vervaldatum, eigen bron-transactie en een eigen "resterend bedrag" (`remaining_amount`) dat afneemt naarmate het lot wordt besteed.

Elke **credit-verlagende** actie (`redeem`, `expiration`, `refund_reversal`, een negatieve `manual_adjustment`, de uitgaande kant van een `transfer`) is zelf ook een ledger entry, maar **verwijst expliciet naar welke lot(s) hij aanspreekt**, via een aparte allocatie-tabel. Dit is de kern van "elk saldo moet herleidbaar zijn": je kunt van elke euro tegoed die ooit is uitgegeven, precies aanwijzen uit welke verdien-gebeurtenis(sen) hij kwam.

```
wallet_ledger_entries (append-only, NOOIT geüpdatet of verwijderd)
    │
    ├── credit-entry (earn, bonus, campaign_bonus, +manual_adjustment, +transfer)
    │       │
    │       └── remaining_amount (denormalized op de entry zelf,
    │           startwaarde = amount, daalt bij elke allocatie)
    │
    └── debit-entry (redeem, expiration, refund_reversal,
        -manual_adjustment, -transfer)
            │
            └── wallet_ledger_allocations (koppelt deze debit-entry
                aan één of meer credit-entries, met het bedrag
                per koppeling — FIFO: oudste lot met de dichtstbijzijnde
                vervaldatum wordt als eerste aangesproken, tenzij
                een organisatie kiest voor "eerst verlopende lot
                eerst" als alternatieve strategie)
```

**Waarom dit géén simpele "balance = SUM(ledger.amount)"-optelling is:** dat zou weliswaar het huidige saldo geven, maar niet kunnen verklaren *welk deel* verloopt op welke datum, of *welke specifieke verdien-gebeurtenis* is teruggedraaid bij een refund. Het lot-model met allocaties maakt beide vragen triviaal te beantwoorden, wat direct de eis "het systeem moet altijd kunnen verklaren hoe een huidig saldo tot stand is gekomen" waarmaakt.

**Balans is een denormalized read-cache, net als in Module 1/2/4:** `wallets.available_balance` etc. worden bij elke ledger-mutatie in dezelfde databasetransactie bijgewerkt, zodat lezen snel blijft — maar de ledger + allocaties blijven de bron van waarheid, en een reconciliatiejob (sectie 15) herberekent en vergelijkt dit periodiek.

---

## 4. Database

```
customers (Module 1)
    │
    └── wallets (1-op-1)
            │
            ├── wallet_ledger_entries ──────────┐
            │       │                            │
            │       └── wallet_ledger_allocations┘
            │           (debit_entry_id → credit_entry_id)
            │
            ├── wallet_passes (Apple/Google Wallet)
            │
credit_rules (organisatiebreed/locatie, zie sectie 5-6)
```

### `wallets`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID (FK) | |
| `customerId` | UUID (FK naar Module 1, uniek) | |
| `availableBalance` | decimal(10,2) | denormalized cache |
| `pendingBalance` | decimal(10,2) | denormalized cache |
| `reservedBalance` | decimal(10,2) | denormalized cache |
| `lifetimeExpired` | decimal(10,2) | cumulatief, informatief |
| `lifetimeEarned` | decimal(10,2) | denormalized cache (spiegelt Module 1's gelijknamige veld) |
| `lifetimeRedeemed` | decimal(10,2) | denormalized cache |
| `createdAt` / `updatedAt` | timestamp | |

### `wallet_ledger_entries`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `walletId` | UUID (FK) | |
| `organizationId` | UUID | denormalized t.b.v. query-snelheid |
| `entryType` | enum | `earn`, `redeem`, `bonus`, `campaign_bonus`, `manual_adjustment`, `refund_reversal`, `expiration`, `transfer`, `correction` |
| `amount` | decimal(10,2) | altijd **positief** — richting volgt uit `entryType` (credit- vs. debit-typen, sectie 3), niet uit het teken |
| `remainingAmount` | decimal(10,2), nullable | alleen gevuld voor credit-entries; startwaarde = `amount` |
| `status` | enum | `pending`, `available`, `reserved`, `redeemed`, `expired`, `reversed` — alleen relevant voor credit-entries |
| `source` | enum | `pos`, `manual`, `campaign`, `system` |
| `transactionId` | UUID, nullable (FK naar Module 2) | de rekening die dit heeft veroorzaakt (earn) of waarbij dit is besteed (redeem) |
| `rewardCalculationId` | UUID, nullable (FK naar Module 4) | traceert terug naar de exacte berekening |
| `campaignId` | UUID, nullable | verwijzing naar Module 5, geen harde FK (consistent met eerdere modules) |
| `performedByUserId` | UUID, nullable | ingevuld bij `manual_adjustment`/`correction` |
| `performedByType` | enum | `system`, `staff`, `customer_self_service` |
| `relatedLedgerEntryId` | UUID, nullable | koppelt de twee kanten van een `transfer` aan elkaar |
| `reason` | text, nullable | **verplicht** bij `manual_adjustment` en `correction` (zie business rules) |
| `metadata` | jsonb | vrije context, bv. POS-bonnummer, campagnenaam-snapshot |
| `expiresAt` | timestamp, nullable | alleen voor credit-entries |
| `occurredAt` | timestamp | |
| `createdAt` | timestamp | |

> **Ontwerpkeuze — `amount` altijd positief:** dit voorkomt de klassieke boekhoudfout waarbij het teken van een bedrag *en* de betekenis van het entry-type onafhankelijk fout kunnen gaan. De richting (credit/debit) volgt uitsluitend uit `entryType`, wat ook precies aansluit bij de expliciete lijst entry-typen uit de opdracht.

### `wallet_ledger_allocations`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `debitEntryId` | UUID (FK naar `wallet_ledger_entries`) | de verlagende mutatie |
| `creditEntryId` | UUID (FK naar `wallet_ledger_entries`) | de aangesproken lot |
| `amount` | decimal(10,2) | hoeveel van deze lot is aangesproken door deze mutatie |
| `createdAt` | timestamp | |

### `wallet_passes`

Zie sectie 9 voor volledige uitwerking.

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `walletId` | UUID (FK) | |
| `passType` | enum | `apple`, `google` |
| `serialNumber` | varchar, uniek | |
| `deviceLibraryIdentifier` | varchar, nullable | voor Apple push-registratie |
| `pushToken` | varchar, nullable | |
| `status` | enum | `active`, `removed`, `not_installed` |
| `lastPushedAt` | timestamp, nullable | |
| `installedAt` | timestamp, nullable | |
| `removedAt` | timestamp, nullable | |

### `credit_rules`

Zie sectie 5-6.

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID (FK) | |
| `locationId` | UUID, nullable (FK) | `null` = organisatiebreed |
| `validityDays` | integer | default `60` |
| `usableFromNextVisit` | boolean | default `true` — implementeert de pending-regel |
| `minimumOrderAmount` | decimal(10,2), nullable | |
| `maximumRedeemPercentage` | decimal(5,2), nullable | bv. `20.00` voor "max 20% van de rekening" |
| `excludedProductCategories` | jsonb, nullable | |
| `excludedDays` | jsonb, nullable | |
| `nonCombinableCampaignIds` | jsonb, nullable | |
| `transfersAllowed` | boolean | default `false` |
| `isActive` | boolean | |
| `createdAt` / `updatedAt` | timestamp | |

---

## 5. Expiration model

```
Dagelijkse achtergrondjob (bv. 02:00)
        │
        ▼
Selecteer alle credit-entries met:
  status = 'available'
  AND expiresAt <= now()
  AND remainingAmount > 0
        │
        ▼
Voor elke gevonden lot:
  1. Maak een debit-entry aan: entryType = 'expiration',
     amount = remainingAmount van de lot
  2. Maak een wallet_ledger_allocation aan die de volledige
     remainingAmount aan deze lot toewijst
  3. Zet de credit-entry se remainingAmount naar 0,
     status naar 'expired'
  4. Verhoog wallets.lifetimeExpired met hetzelfde bedrag
     Verlaag wallets.availableBalance
        │
        ▼
Event: wallet.credit_expired (sectie 11)
```

**Expiration messaging (waarschuwing vóórdat het zover is):** een aparte, lichtere achtergrondjob (bv. elke ochtend) zoekt lots met `status = available AND expiresAt BETWEEN now() AND now() + 7 dagen` en publiceert `wallet.credit_expiring_soon` — dit event is bewust ontkoppeld van de daadwerkelijke expiratie-job, en is precies het soort event dat Module 6 (Messaging) gebruikt voor het "Je tegoed verloopt over 7 dagen"-pushbericht uit de basisprincipes van het platform.

**Reserved tegoed verloopt nooit stilzwijgend:** als een lot in `reserved`-status zit op het moment dat de expiratiejob draait (zeldzaam — een reservering hoort kortstondig te zijn, zie sectie 6), wordt die lot overgeslagen tot de reservering is afgerond of getimeout, om te voorkomen dat een lopende afrekening plotseling ongeldig tegoed gebruikt.

---

## 6. Redemption

Twee-fasen-proces (reserveren → bevestigen), essentieel om dubbel gebruik te voorkomen wanneer een POS-transactie even onderweg is (netwerkvertraging, retries — consistent met Module 2's idempotency-aanpak):

```
STAP 1 — Reserveren (bij start van afrekenen met tegoed)
        │
        ▼
Valideer tegoedregels (credit_rules):
  - minimumOrderAmount gehaald?
  - dag niet uitgesloten?
  - product(en) op de rekening niet uitgesloten?
  - campagne op deze rekening niet non-combinable
    met een reeds toegepaste campagne?
  - gevraagd bedrag <= maximumRedeemPercentage × rekeningbedrag?
        │
   ┌────┴─────┐
  Nee         Ja
   │           │
   ▼           ▼
Weiger,     Selecteer beschikbare lots (status=available,
reden       remainingAmount > 0, expiresAt > now(),
teruggeven  EN earn-transactionId != huidige transactionId
            — dit laatste implementeert "niet dezelfde
            rekening", zie sectie 2)
            FIFO op expiresAt (eerst verlopende lot eerst,
            configureerbare strategie)
                  │
                  ▼
            Genoeg beschikbaar tegoed voor het
            gevraagde bedrag?
                  │
             ┌────┴─────┐
            Nee         Ja
             │           │
             ▼           ▼
        Weiger, of    Zet status van de aangesproken
        bied maximaal  lot-delen op 'reserved'
        beschikbare    (geen ledger entry nog — dit is
        bedrag aan     een tijdelijke, in-memory/short-
                       lived DB-lock, geen boekingsfeit)
                             │
                             ▼
                       Reservering-token teruggegeven,
                       geldig voor bv. 5 minuten
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                     ▼
   STAP 2a: bevestigd   STAP 2b: geannuleerd   STAP 2c: timeout
   (transactie afgerond) (gast bedenkt zich)   (geen bevestiging
        │                    │                  binnen venster)
        ▼                    ▼                     ▼
   Maak debit-entry:    Reservering vrijgeven, Zelfde als 2b —
   entryType='redeem',  lot terug naar         automatische
   met allocaties naar  status='available'     achtergrondjob
   de gereserveerde                            maakt reserveringen
   lot(s)                                      ouder dan het venster
        │                                       ongedaan
        ▼
   remainingAmount van de lot(s) verlaagd,
   status naar 'redeemed' als volledig
   opgebruikt, anders blijft de lot
   'available' met een lager remainingAmount
```

**Idempotency:** elke reserverings- en bevestigingsaanroep vereist een `idempotencyKey` (meegegeven door de POS/kassa-flow) — een herhaalde aanroep met dezelfde key retourneert het eerder-berekende resultaat in plaats van een tweede keer tegoed af te schrijven. Dit is exact hetzelfde principe als Module 2's `external_transaction_id`-uniciteit.

---

## 7. Partial redemption

Dit is **geen apart mechanisme**, maar een natuurlijk gevolg van het lot-model: als een gevraagd redemption-bedrag kleiner is dan een lot's `remainingAmount`, wordt alleen het gevraagde deel geälloceerd, en blijft de lot met het restant gewoon `available`.

**Voorbeeld:**
```
Lot A: verdiend €20, remainingAmount €20, status available
Gast besteedt €12 tegoed bij een volgend bezoek
        │
        ▼
wallet_ledger_allocations: debitEntry(redeem, €12) -> creditEntry(Lot A), amount €12
Lot A: remainingAmount wordt €8, status blijft 'available'
        │
        ▼
Later, nog een bezoek: gast besteedt €8 tegoed
        │
        ▼
wallet_ledger_allocations: debitEntry(redeem, €8) -> creditEntry(Lot A), amount €8
Lot A: remainingAmount wordt €0, status wordt 'redeemed'
```

**Een enkele redemption kan ook over meerdere lots verspreid worden:** als het gevraagde bedrag groter is dan de grootste beschikbare lot, worden meerdere lots aangesproken (FIFO), elk met een eigen allocatie-rij — zo blijft precies zichtbaar welk deel van welke verdien-gebeurtenis is gebruikt.

---

## 8. Reversal

Twee fundamenteel verschillende situaties, beide "reversal" in de volksmond, maar met andere ledger-mechanica:

### A. De oorspronkelijke aankoop wordt gerefund (refund_reversal)

```
Module 2 publiceert transaction.refunded of transaction.voided
        │
        ▼
Module 4 berekent de reward reversal (proportioneel,
zie Module 4-ontwerp sectie 8) en publiceert
reward.reversal_calculated
        │
        ▼
Wallet & Credit ontvangt dit event
        │
        ▼
Zoek de credit-entry (earn) die bij de
oorspronkelijke transactionId hoort
        │
        ▼
Nog voldoende remainingAmount over om de
reversal te dekken?
        │
   ┌────┴─────┐
  Ja          Nee (gast had het tegoed
   │          al deels/geheel besteed)
   ▼               │
Maak debit-entry:   ▼
entryType=          Reverseer wat er nog kán
'refund_reversal',  (verlaag remainingAmount tot 0),
alloceer naar        EN registreer het niet-gedekte
die ene lot          deel als "negatieve balans"-
                     situatie — zie Fraud/reconciliation
                     hieronder: dit is een bewust
                     zichtbaar gemaakt scenario, geen
                     stille discrepantie
```

**Bewuste beleidskeuze — al besteed tegoed wordt niet bij de gast teruggevorderd:** als een gast het verdiende tegoed al heeft uitgegeven vóórdat de onderliggende aankoop werd terugbetaald (bv. een deels teruggestuurd gerecht, dagen later), wordt dat reeds bestede tegoed **niet** als schuld op de wallet gezet — dat zou een negatieve balans betekenen, wat verwarrend en slecht voor de klantrelatie is. In plaats daarvan registreert het systeem dit als een "oninbare reversal" (zichtbaar voor finance/analytics, sectie 15), en de organisatie kan zelf beleid bepalen (accepteren als bedrijfskosten, of in uitzonderlijke gevallen handmatig corrigeren via sectie 6/12).

### B. Een eerder uitgevoerde redemption wordt zelf teruggedraaid (correction)

Zeldzamer — bijvoorbeeld een medewerker heeft per ongeluk tegoed laten inwisselen op de verkeerde rekening.

```
Manager selecteert de foutieve redeem-entry in het admin-scherm
        │
        ▼
Maak een nieuwe credit-entry aan: entryType = 'correction',
amount = het bedrag van de foutieve redemption,
reason VERPLICHT ingevuld, performedByUserId ingevuld
        │
        ▼
Dit is een NIEUWE lot (met een eigen, verse expiresAt op basis
van de huidige credit_rules — niet de oorspronkelijke
vervaldatum, want dit is boekhoudkundig een nieuwe toekenning,
geen tijdreis naar de oude lot)
        │
        ▼
De oorspronkelijke redeem-entry zelf blijft ongewijzigd
in de ledger staan (append-only!) — de correctie is een
aparte, volgende regel, niet een wijziging van het verleden
```

---

## 9. Wallet integraties (Apple Wallet / Google Wallet)

### De digitale pas

```
┌─────────────────────────────┐
│  BEACH HOSPITALITY GROUP       │
│                                 │
│         €18,50                  │
│      Beach Credit                │
│                                    │
│      ●●● GOLD MEMBER               │
│                                      │
│  Tegoed geldig tot: 12 oktober        │
│                                         │
│  ▓▓▓▓▓▓▓▓  ← QR-code (member ID)         │
│  ▓▓▓▓▓▓▓▓                                  │
└─────────────────────────────┘
```

**Weergegeven veld → databron:**
- Saldo (`€18,50`) → `wallets.availableBalance`
- "Geldig tot" → `expiresAt` van de **eerstvolgende** vervallende lot (niet een enkele wallet-brede vervaldatum, want elke lot heeft zijn eigen datum — de pas toont de meest urgente)
- Tier-badge → Module 1's `customers.tierId`
- QR-code → `wallet_passes.serialNumber`, functioneel identiek aan de member-ID die ook bij `resolve-identity` (Module 1) gebruikt kan worden als `identityType: qr_code`

### Wallet pass lifecycle

```
Klant vraagt pas aan (via bevestigingsscherm na
eerste bezoek, e-mail-link, of self-service PWA)
        │
        ▼
Genereer wallet_passes-rij: serialNumber (uniek),
passType (apple of google), status='not_installed'
        │
        ▼
Server genereert het .pkpass-bestand (Apple) of
Google Wallet "Save to Google Wallet"-link, met
de huidige waarden ingebakken (saldo, tier, QR)
        │
        ▼
Klant tikt "Voeg toe aan Apple/Google Wallet"
        │
        ▼
Apple/Google registreert het device bij Apple/Google's
push-infrastructuur, stuurt een registratie-callback
naar ons webhook-endpoint
        │
        ▼
wallet_passes.status = 'active',
deviceLibraryIdentifier/pushToken opgeslagen,
installedAt gezet
        │
        ▼
     ── PAS IS NU LIVE OP HET TOESTEL ──
        │
        ▼
Elke saldo-wijziging (nieuwe earn, redeem, expiration)
        │
        ▼
Publiceer wallet.balance_changed (sectie 11)
        │
        ▼
Wallet-integratielaag stuurt een "silent push"
naar Apple/Google (via APNs/FCM), die het toestel
vertelt: "haal de nieuwste pas-data opnieuw op"
        │
        ▼
Apple/Google roept ons "get updated pass"-endpoint
aan, wij retourneren de nieuwste `.pkpass`/pass-JSON
        │
        ▼
Pas op het toestel toont het nieuwe saldo — near-
realtime, zonder dat de gast iets hoeft te doen
        │
        ▼
Klant verwijdert de pas van zijn toestel (eigen keuze)
        │
        ▼
Apple/Google stuurt een "unregister"-callback
        │
        ▼
wallet_passes.status = 'removed', removedAt gezet
(historische ledger-data blijft uiteraard onaangetast —
dit raakt alleen de pas-weergave, niet het tegoed zelf)
```

**Expiration messaging op de pas zelf:** wanneer een lot binnen de waarschuwingstermijn (sectie 5) valt, kan de pas-tekst tijdelijk een extra regel tonen ("€12,40 verloopt over 5 dagen") — dit is een presentatielaag bovenop dezelfde `wallet.credit_expiring_soon`-event-data die ook naar Messaging gaat, geen aparte databron.

**Ontwerpkeuze — geen appdwang, wallet-first:** dit sluit direct aan bij het basisprincipe "we willen zo min mogelijk verplichten dat consumenten een app downloaden" — de QR-code op de pas werkt ook zonder Wallet-integratie (bv. afgedrukt, of getoond in de mobiele webomgeving/PWA) als fallback.

---

## 10. API

Basis: `/api/v1/organizations/{orgId}/wallets`

| Methode | Endpoint | Omschrijving |
|---|---|---|
| `GET` | `/customers/{customerId}/wallet` | Huidige saldo-overzicht (alle vijf grootheden) |
| `GET` | `/customers/{customerId}/wallet/ledger` | Volledige, gepagineerde ledger-geschiedenis |
| `GET` | `/customers/{customerId}/wallet/ledger/{entryId}` | Detail van één entry, inclusief alle allocaties (de "verklaar dit saldo"-view) |
| `POST` | `/customers/{customerId}/wallet/redemptions/reserve` | Stap 1 van redemption (sectie 6). Body: `amount`, `transactionId`, `idempotencyKey` |
| `POST` | `/customers/{customerId}/wallet/redemptions/{reservationId}/confirm` | Stap 2a |
| `POST` | `/customers/{customerId}/wallet/redemptions/{reservationId}/cancel` | Stap 2b |
| `POST` | `/customers/{customerId}/wallet/adjustments` | Handmatige correctie (admin, `reason` verplicht) |
| `GET` | `/customers/{customerId}/wallet/pass` | Status van de Wallet-pas (geïnstalleerd? welk type?) |
| `POST` | `/customers/{customerId}/wallet/pass` | Nieuwe pas genereren/aanbieden |
| `GET` | `/wallet-passes/{serialNumber}.pkpass` | Apple Wallet-specifiek: het daadwerkelijke pass-bestand |
| `POST` | `/wallet-passes/{serialNumber}/register` | Apple/Google device-registratie-callback |
| `POST` | `/wallet-passes/{serialNumber}/unregister` | Verwijdering-callback |
| `GET` | `/credit-rules` | Huidige tegoedregels (organisatie/locatie) |
| `POST` / `PATCH` | `/credit-rules` | Tegoedregels beheren |

---

## 11. Events

**Consumeert:**
- `reward.calculated` (Module 4) → maakt een `earn`-ledger entry aan (of `bonus`/`campaign_bonus`, afhankelijk van de aard van de berekening)
- `reward.reversal_calculated` (Module 4, naar aanleiding van Module 2's refund/void-events) → `refund_reversal`-entry (sectie 8A)

**Publiceert:**
- `wallet.balance_changed` — payload: `walletId`, `customerId`, nieuwe waarden voor alle vijf grootheden. Triggert de Wallet-pas-push (sectie 9) en is relevant voor Module 1's timeline (`credit_earned`/`credit_redeemed`-events daar)
- `wallet.credit_expiring_soon` — payload: `walletId`, `lotId`, `amount`, `expiresAt`. Voor Module 6 (Messaging)
- `wallet.credit_expired` — payload: idem, na daadwerkelijke expiratie
- `wallet.redemption_reserved` / `confirmed` / `cancelled` — voor Module 2/POS-flow en analytics
- `wallet.manual_adjustment_made` — apart van de generieke `balance_changed`, omdat dit specifiek de aandacht van finance/audit verdient

---

## 12. Admin UI

**Wallet-detailscherm (per klant, bereikbaar vanuit Module 1's klantprofiel):**

```
┌─────────────────────────────────────────────────────┐
│  Wallet — Jan de Vries                                  │
├─────────────────────────────────────────────────────┤
│  Beschikbaar        €18,50                                │
│  Pending             €0,00                                 │
│  Gereserveerd        €0,00                                  │
│  Lifetime earned     €142,80                                 │
│  Lifetime redeemed   €124,30                                  │
│  Lifetime expired    €0,00                                      │
├─────────────────────────────────────────────────────┤
│  Ledger                                                    │
│  ┌───────────────────────────────────────────────┐        │
│  │ 23 aug  earn      +€9,20   Rekening #4821         │        │
│  │         geldig tot 22 okt   [bekijk allocaties]    │        │
│  │ 15 aug  redeem    -€5,00   Rekening #4790          │       │
│  │         uit lot van 12 jul  [bekijk allocaties]     │      │
│  │ 12 jul  earn      +€12,40  Rekening #4650            │     │
│  │         resterend: €7,40                              │    │
│  └───────────────────────────────────────────────┘         │
│                                                              │
│  [ + Handmatige correctie ]                                  │
└─────────────────────────────────────────────────────┘
```

**Handmatige correctie-formulier:**
```
┌─────────────────────────────────────────────────────┐
│  Handmatige correctie                                   │
├─────────────────────────────────────────────────────┤
│  Type: [ ⦿ Tegoed toevoegen   ○ Tegoed verwijderen ]      │
│  Bedrag: [ €______ ]                                        │
│  Reden (verplicht): [_____________________________]          │
│                                                                │
│  ⚠ Deze actie wordt permanent vastgelegd in de ledger          │
│    en het audit-log, gekoppeld aan jouw account.                │
│                                                                    │
│  [ Annuleren ]                              [ Bevestigen ]         │
└─────────────────────────────────────────────────────┘
```

**"Bekijk allocaties"** op elke ledger-regel opent precies de traceerbaarheid die de opdracht vraagt: bij een `redeem`-entry zie je uit welke `earn`-lot(s) het kwam; bij een `earn`-entry zie je (indien van toepassing) welke latere `redeem`/`expiration`/`refund_reversal`-entries het hebben verminderd, en wat er nog resteert.

---

## 13. Permissions

| Rol | Rechten |
|---|---|
| **Organization Admin** | Volledige leestoegang op alle wallets binnen de organisatie; handmatige correcties zonder bedragslimiet; tegoedregels beheren |
| **Location Manager** | Leestoegang op wallets van klanten die de eigen locatie bezoeken; handmatige correcties **tot een configureerbare limiet** (bv. max €25 per correctie) — grotere correcties vereisen Admin-goedkeuring |
| **Staff** | Alleen: saldo opvragen + redemption reserveren/bevestigen tijdens het afrekenen — geen leestoegang tot de volledige ledger-geschiedenis, geen correcties |
| **Customer (self-service, PWA)** | Alleen eigen wallet + eigen ledger inzien, pas aanvragen/verwijderen — nooit schrijftoegang op saldo |
| **API/Integration key** | Scoped tot de redemption-reserve/confirm-endpoints (voor een toekomstige POS-koppeling), geen toegang tot correcties |

Permissie-primitieven: `wallet.read`, `wallet.redeem`, `wallet.adjust`, `wallet.adjust.unlimited`, `credit_rules.write`.

---

## 14. Fraud prevention

- **Idempotency op elke redemption-aanroep** (sectie 6) — voorkomt dat een netwerk-retry hetzelfde tegoed twee keer afschrijft.
- **Reservation-timeout (sectie 6)** — voorkomt dat tegoed permanent "vastzit" door een afgebroken sessie, wat anders misbruikt zou kunnen worden om een gast tijdelijk buiten te sluiten van zijn eigen tegoed.
- **Bedragslimiet op handmatige correcties per rol** (sectie 13) — een individuele medewerker kan nooit in zijn eentje een groot bedrag bijschrijven.
- **Anomalie-detectie op correcties:** een achtergrondsignaal (voor Module 10/Analytics om op te pakken) markeert patronen zoals "dezelfde medewerker voert herhaaldelijk correcties uit vlak vóór sluitingstijd" of "een klant ontvangt ongebruikelijk veel `manual_adjustment`-entries" — dit systeem grijpt niet automatisch in, maar maakt het zichtbaar voor een Admin.
- **QR-code is geen geheim, maar wel devicegebonden waar mogelijk:** bij gebruik via de Wallet-pas (in plaats van een simpele geprinte kaart) is de QR gekoppeld aan een geregistreerd toestel; een gedeelde schermafbeelding van de QR blijft technisch werkbaar (dit is een inherente beperking van QR-gebaseerde identificatie, geen probleem dat dit systeem kan oplossen) maar het aantal keer dat één pas-serienummer in korte tijd bij verschillende locaties wordt gescand, is wél een anomalie-signaal.
- **Transfers (indien een organisatie dit toestaat) hebben een apart, lager fraudetolerantie-plafond** — bv. een maximumbedrag per transfer en een dagelijks maximum aantal transfers per wallet, omdat dit type mutatie het makkelijkst te misbruiken is voor het "witwassen" van tegoed tussen accounts.
- **Alle fraude-gerelateerde instellingen zijn organisatie-configureerbaar**, niet hardcoded — consistent met de architectuurprincipes van het hele platform.

---

## 15. Reconciliation

Dagelijkse (configureerbare frequentie) job, zelfde soort als Module 2's reconciliatie, maar dan voor financiële consistentie binnen deze module zelf:

```
Voor elke wallet:
        │
        ▼
Herbereken vanaf de ledger (niet vanaf de cache):
  - availableBalance = SOM(remainingAmount van
    credit-entries met status='available')
  - pendingBalance = SOM(remainingAmount van
    credit-entries met status='pending')
  - reservedBalance = SOM(remainingAmount van
    credit-entries met status='reserved')
  - lifetimeEarned = SOM(amount van alle credit-entries)
  - lifetimeRedeemed = SOM(amount van alle redeem-entries)
  - lifetimeExpired = SOM(amount van alle expiration-entries)
        │
        ▼
Vergelijk met de denormalized waarden op wallets
        │
   ┌────┴─────┐
 Gelijk       Verschil gevonden
   │               │
   ▼               ▼
Geen actie    KRITIEK: dit mag in een gezond systeem
              nooit gebeuren (elke mutatie loopt via
              dezelfde databasetransactie als de
              cache-update) — een discrepantie wijst op
              een bug of een handmatige databasewijziging
              buiten de applicatie om. Markeer de wallet
              als 'needs_review', notificeer een Admin,
              herstel de cache naar de ledger-waarheid
              (nooit andersom — de ledger wint altijd)
```

**"Oninbare reversals"-rapportage** (uit sectie 8A) is een apart onderdeel van dezelfde reconciliatierun: een overzicht van alle gevallen waarin een refund niet volledig kon worden teruggedraaid omdat het tegoed al was besteed, met het totaalbedrag — relevant voor finance-rapportage, niet als "fout" maar als bekend, geaccepteerd bedrijfsrisico van het loyaltyprogramma.

---

## 16. Audit logging

Gedeelde `audit_log`-infrastructuur (Module 1, sectie 13), aangevuld met wat de ledger zelf al als functioneel audit-trail biedt (append-only, nooit gewijzigd).

Expliciet in `audit_log` gelogd (bovenop de ledger zelf):
- Elke handmatige correctie (`manual_adjustment`/`correction`) — met de verplichte `reason`, de uitvoerende gebruiker, en een snapshot van het saldo vóór en na
- Elke wijziging aan `credit_rules` (bv. validiteitstermijn aangepast van 60 naar 45 dagen) — dit raakt namelijk toekomstige lots, dus moet traceerbaar zijn wanneer welke regel gold
- Elke actie op een `wallet_pass` (aanmaak, registratie, verwijdering) — relevant voor AVG (Module 1) en supportvragen ("waarom werkt mijn pas niet meer")

**Het onderscheid tussen ledger en audit_log:** de ledger legt vast **wat er financieel is gebeurd** (het feit zelf, voor altijd, herberekenbaar tot een saldo); de audit_log legt vast **wie welke actie heeft uitgevoerd en waarom**, inclusief acties die niet direct financieel zijn (bv. een tegoedregel wijzigen). Beide zijn append-only, maar dienen een ander doel — de ledger is het boekhoudkundige brondocument, de audit_log is het operationele logboek.

---

## Voorstel implementatievolgorde

1. **Fase 1 — Kern ledger + wallet:** `wallets`, `wallet_ledger_entries`, `wallet_ledger_allocations`, en de consumptie van `reward.calculated` (earn-entries aanmaken). Zonder dit landt er nog helemaal niets zichtbaars uit Module 4's berekeningen.
2. **Fase 2 — Redemption (reserve/confirm/cancel):** de twee-fasen-flow uit sectie 6, inclusief idempotency. Dit is de eerste keer dat een gast het tegoed daadwerkelijk kan *gebruiken*.
3. **Fase 3 — Tegoedregels:** `credit_rules` en de validatie ervan bij redemption (minimumbesteding, uitsluitingen, max-percentage). Kan technisch na fase 2 zonder de kernwerking te blokkeren, maar hoort er snel bij vanwege marge-bescherming.
4. **Fase 4 — Expiration:** de achtergrondjob + waarschuwingsevent. Niet urgent bij een net gelanceerd programma (nog geen tegoed oud genoeg om te verlopen), maar niet te lang uitstellen.
5. **Fase 5 — Reversal (refund_reversal + correction):** hangt af van Module 2/4's refund-events die al bestaan — kan relatief vroeg, zodra er met echte refunds getest wordt.
6. **Fase 6 — Admin UI:** saldo/ledger-inzage en handmatige correcties. Nuttig zodra er echte klantvragen binnenkomen.
7. **Fase 7 — Wallet-pas-integratie (Apple/Google):** de meest zelfstandige fase, technisch onafhankelijk van de rest — kan parallel aan fase 3-6 gebouwd worden zodra fase 1-2 stabiel zijn (de pas heeft tenslotte alleen een saldo en een QR nodig om te tonen).
8. **Fase 8 — Reconciliation + fraud-signalen:** operationele volwassenheid, bouwt voort op alles ervoor.

---

Wil je dat we hierna de database-migratie voor Module 3 bouwen en testen (zoals bij de vorige modules), zodat het complete pad "transactie → reward → zichtbaar, besteedbaar tegoed" ook echt end-to-end werkt?
