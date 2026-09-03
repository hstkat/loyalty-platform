# Module 6 — Messaging

> Onderdeel van het horeca/hospitality loyaltyplatform. De centrale verzendlaag waar Module 5 (Campaign Manager), Module 8 (Automated Journeys, nog niet gebouwd) en losse systeemberichten (bv. Module 3's credit-expiry-waarschuwing) allemaal doorheen lopen. Eén Message Service, meerdere kanalen, één consistent consent-/frequency-/quiet-hours-beleid — niet per kanaal apart geïmplementeerd.

---

## 1. Messaging architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Aanroepers (interne modules)                                  │
│  Module 5 (Campaign)  │  Module 8 (Journeys)  │  Module 3/4      │
│                        │                        │  (systeemberichten)│
└──────────┬─────────────┴────────────┬───────────┴───────────────┘
           │                          │
           ▼                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     Message Service (centraal)                  │
│                                                                    │
│  1. Template renderen (variabelen + conditionals, sectie 3-4)      │
│  2. Consent-check (sectie 6)                                        │
│  3. Frequency-cap-check (sectie 7)                                    │
│  4. Quiet-hours-check (sectie 8)                                        │
│  5. Transactioneel vs. marketing bepalen welke van 2-4 gelden (sectie 9) │
│  6. In wachtrij plaatsen (sectie 10)                                       │
└──────────┬──────────────┬──────────────┬──────────────┬───────────────┘
           ▼              ▼              ▼              ▼
   ┌──────────────┐┌─────────────┐┌─────────────┐┌──────────────┐
   │ Push-adapter  ││ Wallet-      ││ E-mail-      ││ SMS-adapter    │
   │ (APNs/FCM)    ││ adapter      ││ adapter      ││ (Twilio-achtig)│
   │               ││ (Module 3's  ││ (Postmark/   ││                │
   │               ││ pass-push)   ││ SendGrid-    ││                │
   │               ││              ││ achtig)      ││                │
   └──────────────┘└─────────────┘└─────────────┘└──────────────┘
           │              │              │              │
           └──────────────┴──────────────┴──────────────┘
                              ▼
                  Delivery tracking (webhooks terug van
                  providers: delivered/opened/clicked/
                  bounced) — sectie 12
```

**Kernprincipe, zoals ook bij Module 2's POS-integratielaag:** elke provider-adapter is dun en vervangbaar — hij regelt alleen de kanaal-specifieke verzending en het inlezen van providerspecifieke delivery-webhooks. Consent, frequency caps, quiet hours en template-rendering gebeuren **één keer, centraal**, ongeacht het kanaal. Dit voorkomt dat "e-mail respecteert quiet hours maar SMS niet" per ongeluk kan gebeuren doordat iemand vergat het op twee plekken te implementeren.

**WhatsApp als toekomstige uitbreiding:** het kanaal-veld (`MessageChannel`) en de adapter-architectuur zijn zo ontworpen dat een nieuw kanaal net als bij Module 2's POS-providers alleen een nieuwe adapter + enum-waarde vereist — geen wijziging aan de rest van de pijplijn.

---

## 2. Providers

### `message_providers`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID (FK) | |
| `channel` | enum | `push`, `wallet`, `email`, `sms`, `whatsapp` |
| `providerName` | varchar | vrij veld (`postmark`, `twilio`, `apns`, `fcm`, ...) — geen hardcoded enum-limiet, zelfde reden als Module 2's `provider`-veld |
| `credentialsRef` | varchar | verwijzing naar secrets-manager, nooit het geheim zelf |
| `status` | enum | `active`, `paused`, `error` |
| `isDefault` | boolean | per kanaal maximaal één default-provider per organisatie |
| `createdAt` / `updatedAt` | timestamp | |

**Meerdere providers per kanaal toegestaan** (bv. Twilio als primaire SMS-provider, een tweede als failover) — de Message Service kiest de `isDefault`-provider tenzij een specifiek bericht een andere aanwijst.

---

## 3. Templates

### `message_templates`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID, nullable | `null` = platform-standaardtemplate (koppelt aan Module 5's platform-templates zoals Sunny Day) |
| `channel` | enum | zie sectie 2 |
| `category` | enum | `transactional`, `marketing` (sectie 9) |
| `name` | varchar | interne naam, bv. "Credit verdiend — bevestiging" |
| `locale` | varchar | `nl`, `en`, ... (sectie 5) |
| `subject` | varchar, nullable | alleen relevant voor e-mail |
| `body` | text | met variabelen/conditionals, sectie 4 |
| `isActive` | boolean | |
| `createdAt` / `updatedAt` | timestamp | |

**Eén logische template, meerdere rijen:** een template zoals "Credit verdiend" bestaat als meerdere `message_templates`-rijen — één per taal (sectie 5) en eventueel één per kanaal (de pushtekst is korter dan de e-mailtekst) — gekoppeld via een gedeeld `templateGroupKey`-veld, zodat de Campaign Builder (Module 5) ze als één concept kan tonen.

---

## 4. Variables

Variabele-resolutie gebeurt via een kleine, platform-eigen template-taal (Handlebars-achtig, geen externe engine nodig — bewust simpel gehouden):

```
Hi {{first_name}}, je hebt nog {{credit_balance}} Beach Credit.
Gebruik het vóór {{credit_expiry}}.

{{#if credit_balance > 10}}
Dat is genoeg voor een lekker drankje bij je volgende bezoek! 🍹
{{/if}}

{{#if tier == "gold"}}
Als Gold-lid krijg je bovendien voorrang bij reserveren.
{{/if}}
```

### Beschikbare variabelen (bron)

| Variabele | Bron |
|---|---|
| `{{first_name}}` | Module 1, `customers.firstName` |
| `{{credit_balance}}` | Module 3, `wallets.availableBalance` |
| `{{credit_expiry}}` | Module 3, eerstvolgende vervallende lot (zelfde logica als de Wallet-pas, Module 3 sectie 9) |
| `{{favorite_location}}` | Module 1, `customers.favoriteLocationId` → locatienaam |
| `{{reservation_url}}` | Module 9 (Reservations, nog niet gebouwd) — placeholder-variabele, resolvet naar een lege/generieke link tot die module bestaat |
| `{{reward_amount}}` | Module 4, meest recente `reward_calculations.finalRewardAmount` (voor transactionele "je hebt X verdiend"-berichten) |
| `{{tier}}` | Module 1, klant-tier |

**Ontbrekende data:** als een variabele niet resolvet (bv. `{{favorite_location}}` voor een klant zonder favoriete locatie), wordt een template-specifieke fallback-waarde gebruikt (ingesteld per template, default leeg/weggelaten zin) — nooit een zichtbare `{{...}}` in het uiteindelijke bericht.

### Conditionele content

Ondersteunde operatoren: `>`, `<`, `>=`, `<=`, `==`, `!=`, plus de boolean-achtige aanwezigheidscheck (`{{#if credit_balance}}`). Bewust **geen** volledige programmeertaal — dit is een contentblok tonen/verbergen, geen logica, om templates beheersbaar en veilig te houden voor niet-technische managers.

---

## 5. Localization

- Elke `message_templates`-rij heeft een `locale`. Bij verzending wordt de klant's `customers.language` (Module 1) gebruikt om de juiste rij te selecteren.
- **Fallback-keten:** klanttaal → organisatie-standaardtaal → `nl` (platformdefault) — nooit een verzendfout omdat een vertaling ontbreekt.
- Variabele-waarden zelf zijn **niet** vertaald door dit systeem (bv. een locatienaam blijft zoals ingevoerd) — alleen de sjabloontekst eromheen is per taal apart.
- Datums/bedragen (`{{credit_expiry}}`, `{{credit_balance}}`) worden geformatteerd volgens de locale van de klant (bv. `12 oktober` vs. `October 12`, `€9,20` vs. `€9.20`).

---

## 6. Consent

Consent is **niet** iets dat deze module zelf bijhoudt — het leest rechtstreeks Module 1's `customer_consents` (per kanaal: `email`, `sms`, `push`, en `marketing` als overkoepelend vlag), zoals dat platform daar al staat.

```
Bericht klaar om verzonden te worden naar klant X, kanaal Y
        │
        ▼
category == 'marketing'?
        │
   ┌────┴─────┐
  Ja          Nee (transactional)
   │           │
   ▼           ▼
Heeft klant   Heeft klant ÜBERHAUPT
consent voor  een geverifieerd
kanaal Y      identity-kenmerk voor
EN marketing- kanaal Y? (bv. een
consent       e-mailadres — geen
algemeen?     aparte consent-check,
   │          zie sectie 9 voor de
┌──┴──┐       precieze nuance)
Nee  Ja            │
│     │        ┌───┴───┐
▼     ▼        Nee    Ja
Blokkeer  Doorgaan     │       │
verzending naar        ▼       ▼
frequency/          Blokkeer  Doorgaan
quiet-hours-check    (geen    naar quiet-
                      kanaal)  hours-check
                               (transactional
                               slaat frequency-
                               cap over, sectie 9)
```

**Belangrijk onderscheid:** transactionele berichten omzeilen de *marketing*-consent-check (een AVG-conforme uitzondering — een orderbevestiging is geen marketing), maar vereisen nog steeds dat de klant het kanaal zelf heeft (een geverifieerd e-mailadres/telefoonnummer). Een klant die zijn marketing-consent introk, kan nog steeds zijn transactionele "je hebt €9,20 verdiend"-bevestiging ontvangen — dat is functioneel onderdeel van de dienst, geen marketing.

---

## 7. Frequency caps

### `message_frequency_caps`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID (FK) | |
| `channel` | enum | |
| `category` | enum | alleen `marketing` relevant (sectie 9) |
| `maxMessages` | integer | bv. `2` |
| `periodDays` | integer | bv. `7` |

### `customer_message_send_log`

Lichtgewicht telling, apart van de volledige `message_queue_items`-geschiedenis (sectie 10) om de cap-check snel te houden.

| Veld | Type |
|---|---|
| `id` | UUID (PK) |
| `customerId` | UUID (FK) |
| `channel` | enum |
| `category` | enum |
| `sentAt` | timestamp |

**Cap-check:** tel `customer_message_send_log`-rijen voor deze klant/kanaal/categorie binnen de laatste `periodDays` dagen; als dat `>= maxMessages`, wordt het nieuwe bericht **niet** verzonden maar naar `message_queue_items` gezet met status `skipped_frequency_cap` (zichtbaar in het Message Center, sectie hieronder — niet stilzwijgend verdwenen).

**Cross-campagne, niet per-campagne:** de cap telt over **alle** marketingberichten van een klant heen, niet per campagne apart — anders zou een klant die toevallig in drie campagnes tegelijk zit, alsnog overspoeld worden ondanks een keurige cap per campagne. Dit is een bewuste, platformbrede bescherming.

---

## 8. Quiet hours

### Organisatie-/locatie-instelling (geen aparte tabel — twee velden op bestaande configuratie)

| Veld | Type | Omschrijving |
|---|---|---|
| `quietHoursStart` | time | bv. `21:00` |
| `quietHoursEnd` | time | bv. `09:00` |
| `quietHoursTimezone` | | erft van `locations.timezone` (Module 1) |

```
Marketingbericht klaar voor verzending
        │
        ▼
Huidige tijd (in de tijdzone van de
klant's favoriete locatie, of de
organisatie-standaard) binnen het
quiet-hours-venster?
        │
   ┌────┴─────┐
  Ja          Nee
   │           │
   ▼           ▼
Uitstellen   Direct verzenden
tot quietHoursEnd
(blijft in de
wachtrij met
status 'delayed_
quiet_hours')
```

**Transactionele berichten:** respecteren quiet hours **standaard ook** (niemand wil om 3 uur 's nachts een "je hebt tegoed verdiend"-melding), **behalve** als een bericht expliciet als `urgent: true` is gemarkeerd (bv. een toekomstige OTP-verificatiecode) — dat is een uitzondering per bericht, niet per categorie, om misbruik van de "transactional omzeilt alles"-aanname te voorkomen.

---

## 9. Transactional vs. marketing

| | Transactional | Marketing |
|---|---|---|
| Voorbeeld | "Je hebt €9,20 verdiend", credit-expiry-waarschuwing, wallet-pas-update | Campagnes (Module 5): Sunny Day, Win Back, etc. |
| Marketing-consent vereist | Nee | Ja |
| Kanaal-identity vereist | Ja (moet ergens naartoe kunnen) | Ja |
| Frequency cap | **Omzeilt** de cap (sectie 7) | Telt mee |
| Quiet hours | Respecteert (tenzij `urgent`) | Respecteert altijd |
| Unsubscribe-gevoelig | Alleen bij volledige kanaal-opt-out (sectie 15) | Ja, direct |

**Waarom dit onderscheid zo belangrijk is:** het voorkomt twee tegenovergestelde fouten — een klant die zijn marketing-pushes uitzet en daardoor per ongeluk ook geen "je tegoed verloopt"-waarschuwing meer krijgt (slecht voor de klant), én een organisatie die de frequency-cap omzeilt door alles als "transactional" te labelen (misbruik van de uitzondering). De `category` van elk bericht wordt daarom **op templateniveau vastgelegd**, niet per verzending vrij te kiezen door de aanroepende module — Module 5 (campagnes) kan alleen `marketing`-templates gebruiken, Module 3/4's systeemberichten zijn hardcoded `transactional`.

---

## 10. Queueing

```
message_send_requests (1 rij per "verzoek", bv. één campagne-run
of één systeemtrigger)
        │
        ▼
Voor elke ontvanger x kanaal: message_queue_items
        │
        ▼
Status-machine per item:
  pending → (consent/cap/quiet-hours-checks) →
  ready_to_send → sending → sent → delivered
                                  → bounced
                                  → failed (met retry, sectie 11)
            → skipped_no_consent
            → skipped_frequency_cap
            → skipped_no_channel
            → delayed_quiet_hours → ready_to_send (later)
```

### `message_send_requests`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID (FK) | |
| `sourceType` | enum | `campaign`, `journey`, `system` |
| `sourceId` | UUID, nullable | verwijst naar Module 5's `campaigns.id`, Module 8's journey-id, of leeg bij systeem |
| `templateGroupKey` | varchar | zie sectie 3 |
| `createdAt` | timestamp | |

### `message_queue_items`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `sendRequestId` | UUID (FK) | |
| `organizationId` | UUID | |
| `customerId` | UUID (FK naar Module 1) | |
| `locationId` | UUID, nullable | |
| `channel` | enum | |
| `templateId` | UUID (FK) | |
| `renderedSubject` | varchar, nullable | na variabele-resolutie |
| `renderedBody` | text | na variabele-resolutie, **bewaard** (niet alleen het template) zodat je achteraf exact kunt zien wat een klant heeft ontvangen |
| `status` | enum | zie hierboven |
| `providerId` | UUID, nullable (FK naar `message_providers`) | |
| `providerMessageId` | varchar, nullable | ID zoals de provider het teruggeeft, voor het koppelen van delivery-webhooks |
| `scheduledFor` | timestamp | direct of uitgesteld (quiet hours) |
| `sentAt` / `deliveredAt` / `failedAt` | timestamp, nullable | |
| `failureReason` | text, nullable | |
| `retryCount` | integer, default `0` | |

---

## 11. Retries

Zelfde patroon als Module 2's `failed_transactions`: exponentiële backoff (bv. 1 min, 5 min, 30 min, 2 uur — 4 pogingen, configureerbaar), daarna status `failed` definitief en zichtbaar in het Message Center. Alleen provider-technische fouten (timeout, tijdelijke 5xx) worden geretryed; een harde afwijzing door de provider (bv. "ongeldig telefoonnummer") gaat direct naar `failed` zonder retries — opnieuw proberen zou toch niet werken.

---

## 12. Delivery tracking

```
Provider stuurt een delivery-webhook (async, kan minuten tot
uren na verzending binnenkomen)
        │
        ▼
Match op providerMessageId → message_queue_items
        │
        ▼
message_events-rij aanmaken (append-only, net als Module 2/3's
gebeurtenis-logs): 'delivered' | 'opened' | 'clicked' | 'bounced'
        │
        ▼
message_queue_items.status bijgewerkt naar de laatste bekende
stand (delivered/bounced), met timestamp-velden gevuld
```

### `message_events`

| Veld | Type |
|---|---|
| `id` | UUID (PK) |
| `queueItemId` | UUID (FK) |
| `eventType` | enum (`delivered`, `opened`, `clicked`, `bounced`, `unsubscribed`) |
| `occurredAt` | timestamp |
| `metadata` | jsonb (bv. bounce-reden, welke link is aangeklikt) |

---

## 13. Link tracking

E-mail/SMS-berichten met een link (bv. `{{reservation_url}}`) krijgen die link automatisch herschreven naar een intern redirect-endpoint:

```
Origineel: https://hetplatform.nl/reserveren/noordwijk
Herschreven: https://track.hetplatform.nl/l/{linkId}
```

### `message_links`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `queueItemId` | UUID (FK) | |
| `originalUrl` | text | |
| `clickCount` | integer, default `0` | |
| `firstClickedAt` | timestamp, nullable | |

Bij een klik: `GET /l/{linkId}` → `message_events`-rij (`clicked`) + `message_links.clickCount` ophogen → **direct** doorsturen (redirect) naar `originalUrl`, zonder merkbare vertraging voor de klant.

---

## 14. Push tokens

### `customer_push_tokens`

Los van Module 3's `wallet_passes` (die zijn eigen push-mechanisme heeft voor pas-updates, zie Module 3 sectie 9) — dit zijn **app/browser-pushmeldingen**, een ander kanaal.

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `customerId` | UUID (FK) | |
| `platform` | enum | `ios`, `android`, `web` |
| `token` | varchar | |
| `isActive` | boolean | |
| `lastUsedAt` | timestamp, nullable | |
| `registeredAt` | timestamp | |

Een klant kan meerdere tokens hebben (meerdere apparaten) — een push-verzending gaat naar **alle** actieve tokens van de klant, met de daaropvolgende delivery-status per token bijgehouden (dus `message_queue_items` heeft in dat geval één rij per token, niet één rij "voor push in het algemeen").

**Token-verval:** als een provider terugmeldt dat een token niet langer geldig is (app verwijderd), wordt `isActive = false` gezet — geen verdere verzendpogingen naar dat token.

---

## 15. Unsubscribes

```
Klant klikt "uitschrijven" (in e-mail-footer, SMS STOP-woord,
of via de PWA/self-service)
        │
        ▼
Dit schrijft NIET naar een aparte messaging-tabel als bron van
waarheid — het roept Module 1's consent-endpoint aan
(POST .../consents, consentType afhankelijk van kanaal,
granted: false, source: 'unsubscribe_link' of 'sms_stop')
        │
        ▼
message_events-rij ('unsubscribed') voor traceerbaarheid
vanuit messaging-perspectief (welk bericht leidde tot de
afmelding)
        │
        ▼
Toekomstige marketingberichten op dat kanaal worden vanaf nu
geblokkeerd door de consent-check (sectie 6) — geen aparte
messaging-specifieke blokkeerlijst nodig, Module 1 is en
blijft de enige bron van waarheid voor consent
```

**SMS "STOP"-woord:** een inkomend SMS-bericht met de tekst "STOP" (of lokale equivalenten) wordt door de SMS-adapter opgevangen als een webhook, en resulteert in exact dezelfde consent-aanroep als een unsubscribe-link.

---

## 16. AI copy

```
Manager typt in de Campaign Builder (Module 5, stap 3):
"Het wordt morgen 27 graden, lunch is nog leeg en we willen
dubbel tegoed geven."
        │
        ▼
POST naar de AI-copy-endpoint van deze module, met:
- de vrije tekst-input
- de organisatie's brand_voice_profile (zie hieronder)
- het gekozen kanaal (push: kort, e-mail: uitgebreider)
- relevante platformcontext (bv. "Double Credit" als
  incentive-type, al bekend uit de wizard)
        │
        ▼
LLM-aanroep (extern, via een taalmodel-provider) genereert
3 korte varianten
        │
        ▼
ai_copy_requests-rij: prompt, gegenereerde varianten,
door de manager gekozen/bewerkte variant (audit-trail van
AI-gebruik, ook relevant voor het "AI mag nooit zelfstandig
[...] uitdelen"-basisprincipe — de AI genereert hier alleen
TEKST, geen bedragen of regels; de daadwerkelijke Double
Credit-regel wordt via Module 4/5's reguliere, door een mens
bevestigde flow aangemaakt, niet door de AI zelf)
        │
        ▼
Manager kiest/bewerkt een variant → wordt de message_templates.body
```

### `brand_voice_profiles`

| Veld | Type | Omschrijving |
|---|---|---|
| `id` | UUID (PK) | |
| `organizationId` | UUID (FK) | |
| `toneDescription` | text | bv. "Speels, gebruikt emoji's, kort en direct, nooit formeel" |
| `exampleMessages` | jsonb | een paar voorbeeldberichten die de organisatie goed vond, als few-shot-context voor de AI |

### `ai_copy_requests`

| Veld | Type |
|---|---|
| `id` | UUID (PK) |
| `organizationId` | UUID |
| `requestedByUserId` | UUID |
| `promptText` | text |
| `generatedVariants` | jsonb (array van 3 teksten) |
| `chosenVariantIndex` | integer, nullable |
| `finalEditedText` | text, nullable |
| `createdAt` | timestamp |

**Bewuste begrenzing:** de AI genereert uitsluitend **tekst**, nooit rewardpercentages, budgetten of doelgroepen — die blijven volledig binnen Module 4/5's door mensen ingestelde regels. Dit is dezelfde grens die in de allereerste basisprincipes van het platform is vastgelegd ("AI mag echter nooit zelfstandig onbeperkte korting uitdelen").

---

## 17. Analytics

Per template/campagne, afgeleid van `message_queue_items` + `message_events`:

- **Delivery rate** = delivered / sent
- **Open rate** = opened / delivered (alleen zinvol voor e-mail; push/SMS hebben doorgaans geen betrouwbare open-tracking)
- **Click rate** = clicked / delivered
- **Bounce rate** = bounced / sent
- **Unsubscribe rate** = unsubscribed / delivered
- **Skip-redenen-verdeling** — hoeveel berichten zijn nooit verzonden door consent/cap/quiet-hours, en welke reden overheerst (belangrijk operationeel signaal: een hoge `skipped_frequency_cap`-ratio betekent bijvoorbeeld dat een organisatie te veel campagnes tegelijk stuurt)

Deze cijfers voeden rechtstreeks Module 5's `campaign_metrics_snapshots` (`delivered`, `opens`, `clicks` daar zijn een directe doorgave van wat deze module meet).

---

## 18. API/events

Basis: `/api/v1/organizations/{orgId}/messaging`

| Methode | Endpoint | Omschrijving |
|---|---|---|
| `POST` | `/send` | Generieke verzend-aanroep (door Module 5/8/systeem aangeroepen) — body: `templateGroupKey`, ontvangerslijst of audience-referentie, kanalen |
| `GET` | `/templates` | Sectie 3 |
| `POST` / `PATCH` | `/templates` | Templates beheren |
| `POST` | `/ai-copy` | Sectie 16 |
| `GET` | `/queue` | Message Center-overzicht (sectie hieronder) |
| `GET` | `/queue/{id}` | Detail van één verzending, inclusief gerenderde inhoud en volledige event-historie |
| `GET` | `/providers` | Sectie 2 |
| `POST` / `PATCH` | `/providers` | Providers beheren |
| `POST` | `/webhooks/{provider}` | Ontvangst van delivery-events per provider (sectie 12) |
| `GET` | `/l/{linkId}` | Sectie 13 (redirect-endpoint, geen JSON-response) |
| `GET` | `/frequency-caps` / `POST` | Sectie 7 |
| `GET` | `/push-tokens` (per klant) / `POST` / `DELETE` | Sectie 14 |

**Publiceert:** `message.queued`, `message.sent`, `message.delivered`, `message.opened`, `message.clicked`, `message.bounced`, `message.unsubscribed`, `message.skipped` (met reden).

**Consumeert:** Module 1's consent-wijzigingen (direct gelezen, niet als event — sectie 6), Module 5's `campaign.recipient_queued`, Module 3's `wallet.credit_expiring_soon` (systeembericht-trigger), Module 8's journey-stappen (zodra die module bestaat).

### Message Center (admin-overzicht)

```
┌─────────────────────────────────────────────────────┐
│  Message Center                                          │
├─────────────────────────────────────────────────────┤
│  Verzonden vandaag: 1.240   Delivered: 1.198 (96,6%)       │
│  Opened: 412 (34%)          Clicked: 89 (7,4%)              │
│  Bounced: 12                Unsubscribed: 3                   │
│  Mislukt: 8                 Uitgesteld (quiet hours): 34        │
│  Overgeslagen (frequency cap): 21                                 │
├─────────────────────────────────────────────────────┤
│  [ tabel: elk bericht, kanaal, ontvanger, status,           │
│    bron (campagne/journey/systeem), tijdstip ]                │
└─────────────────────────────────────────────────────┘
```

---

## Voorstel implementatievolgorde

1. **Fase 1 — Kern: templates + variabele-resolutie + één kanaal (push):** het simpelste end-to-end pad, bewijst de architectuur.
2. **Fase 2 — Consent + frequency caps + quiet hours:** moet er zijn vóórdat er ook maar één marketingbericht de deur uitgaat.
3. **Fase 3 — Queueing + retries:** betrouwbaarheid, nodig zodra volumes groter worden dan "handmatig testen".
4. **Fase 4 — E-mail + SMS-adapters:** uitbreiding van kanalen, hergebruikt de volledige pijplijn uit fase 1-3.
5. **Fase 5 — Delivery tracking + link tracking + analytics:** meetbaarheid, sluit aan op Module 5's rapportagebehoefte.
6. **Fase 6 — Wallet-adapter (koppeling met Module 3):** technisch al grotendeels aanwezig in Module 3's ontwerp, hier vooral de orkestratie eromheen.
7. **Fase 7 — AI copy:** de meest zelfstandige fase, kan parallel gebouwd worden zodra fase 1-2 stabiel zijn.
8. **Fase 8 — WhatsApp:** pas zodra er een concrete behoefte is, dankzij de adapter-architectuur een relatief kleine toevoeging.

---

Wil je dat we nu de database-migraties voor Module 5 én 6 samen bouwen en testen, zoals bij de vorige modules?
