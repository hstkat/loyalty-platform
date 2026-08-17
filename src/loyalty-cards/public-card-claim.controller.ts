import { Body, Controller, Get, Header, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LoyaltyCardsService } from './loyalty-cards.service';
import { ClaimNewCustomerDto, ClaimLinkExistingDto } from './dto/loyalty-cards.dto';

/**
 * Publiek, niet-geauthenticeerd — een gast heeft nog geen sessie
 * wanneer die voor het eerst een kaart scant. Veiligheid komt uit het
 * token zelf (96 bits entropie, gehasht opgeslagen) en uit het feit dat
 * deze pagina bewust NOOIT gevoelige klantgegevens toont zonder
 * authenticatie (sectie 13) — alleen de status van de kaart.
 */
@Controller('c')
export class PublicCardClaimController {
  constructor(private cards: LoyaltyCardsService) {}

  @Get(':token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async claimPage(@Param('token') token: string, @Res() res: Response) {
    const lookup = await this.cards.publicLookup(token);
    res.status(200).send(this.renderPage(lookup, token));
  }  @Post(':token/claim/new-customer')
  claimAsNewCustomer(@Param('token') token: string, @Body() dto: ClaimNewCustomerDto) {
    return this.cards.claimAsNewCustomer(token, dto);
  }

  @Post(':token/claim/link-existing')
  claimAsExistingCustomer(@Param('token') token: string, @Body() dto: ClaimLinkExistingDto) {
    return this.cards.claimAsExistingCustomer(token, dto);
  }

  private renderPage(lookup: { found: boolean; status?: string; organizationId?: string }, token: string): string {
    const styles = `
      :root { --cream: #f6f3ec; --navy-dark: #0e1c2a; --white: #ffffff; --muted: rgba(240,244,247,0.6);
        --teal: #497a9d; --coral: #e8604a; --coral-light: #f08c78; --line: rgba(240,244,247,0.12); }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: var(--cream); font-family: 'Inter', -apple-system, sans-serif;
        display: flex; align-items: center; justify-content: center; padding: 24px; }
      .card { width: 100%; max-width: 380px; background: var(--navy-dark); border-radius: 24px; padding: 36px 28px;
        text-align: center; color: var(--white); }
      .brand { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
      h1 { font-family: Georgia, serif; font-size: 24px; font-weight: 500; margin: 0 0 16px; }
      p { font-size: 14px; color: rgba(240,244,247,0.8); line-height: 1.6; margin: 0 0 24px; }
      .btn { display: block; width: 100%; padding: 14px; border-radius: 10px; font-weight: 600; font-size: 15px;
        border: none; cursor: pointer; margin-bottom: 10px; text-decoration: none; }
      .btn-primary { background: var(--coral); color: var(--white); }
      .btn-secondary { background: none; border: 1px solid var(--line); color: var(--white); }
      input { width: 100%; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--line);
        background: rgba(255,255,255,0.06); color: var(--white); font-size: 14px; margin-bottom: 10px; }
      input::placeholder { color: var(--muted); }
      .step { display: none; }
      .step.active { display: block; }
      .error { color: var(--coral-light); font-size: 13px; margin-top: 8px; min-height: 16px; }
    `;

    if (!lookup.found) {
      return this.htmlShell(styles, `
        <div class="brand">HET STRAND &amp; ZOMERS</div>
        <h1>Kaart niet gevonden</h1>
        <p>Deze QR-code hoort niet bij een geldige loyaltykaart.</p>
      `);
    }

    if (lookup.status !== 'unclaimed') {
      const message = lookup.status === 'active'
        ? 'Deze loyaltykaart is al geactiveerd.'
        : 'Deze loyaltykaart is niet meer geldig.';
      return this.htmlShell(styles, `
        <div class="brand">HET STRAND &amp; ZOMERS</div>
        <h1>${message}</h1>
        <p>Heb je hier vragen over? Neem contact op met de zaak.</p>
      `);
    }

    // Onbeheerde kaart — de volledige claim-flow, client-side, zonder framework
    return this.htmlShell(styles, `
      <div class="brand">HET STRAND &amp; ZOMERS</div>
      <div id="step-choice" class="step active">
        <h1>Activeer je loyaltykaart</h1>
        <p>Je kunt met deze kaart sparen en je tegoed gebruiken bij een volgend bezoek.</p>
        <button class="btn btn-primary" onclick="showStep('new')">Nieuwe klant</button>
        <button class="btn btn-secondary" onclick="showStep('existing-email')">Ik heb al een account</button>
      </div>

      <div id="step-new" class="step">
        <h1>Nieuw account</h1>
        <input id="new-firstname" placeholder="Voornaam">
        <input id="new-lastname" placeholder="Achternaam (optioneel)">
        <input id="new-email" type="email" placeholder="E-mailadres">
        <input id="new-phone" type="tel" placeholder="Telefoonnummer">
        <label style="display:block;font-size:11px;color:var(--muted);text-align:left;margin-bottom:6px;">Geboortedatum (optioneel)</label>
        <input id="new-dob" type="date">
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-bottom:16px;">
          <input type="checkbox" id="new-consent" checked style="width:auto;margin:0;"> Ik wil aanbiedingen en nieuws ontvangen
        </label>
        <button class="btn btn-primary" onclick="submitNewCustomer()">Kaart activeren</button>
        <div class="error" id="new-error"></div>
      </div>

      <div id="step-existing-email" class="step">
        <h1>Inloggen</h1>
        <p>Vul je e-mailadres in — we sturen je een 6-cijferige code.</p>
        <input id="existing-email" type="email" placeholder="E-mailadres">
        <button class="btn btn-primary" onclick="requestExistingCode()">Stuur inlogcode</button>
        <div class="error" id="existing-email-error"></div>
      </div>

      <div id="step-existing-code" class="step">
        <h1>Voer je code in</h1>
        <p>Check je inbox voor de 6-cijferige code.</p>
        <input id="existing-code" placeholder="000000" maxlength="6">
        <button class="btn btn-primary" onclick="verifyAndLink()">Kaart koppelen</button>
        <div class="error" id="existing-code-error"></div>
      </div>

      <div id="step-done" class="step">
        <h1>Je kaart is geactiveerd!</h1>
        <p>Veel plezier bij je volgende bezoek.</p>
      </div>

      <script>
        const TOKEN = ${JSON.stringify(token)};
        const ORG_ID = ${JSON.stringify(lookup.organizationId || '')};
        const API_BASE = 'https://loyalty-platform-live.vercel.app';

        function showStep(name) {
          document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
          document.getElementById('step-' + name).classList.add('active');
        }

        async function submitNewCustomer() {
          const errorEl = document.getElementById('new-error');
          errorEl.textContent = '';
          try {
            const res = await fetch(API_BASE + '/c/' + TOKEN + '/claim/new-customer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                firstName: document.getElementById('new-firstname').value,
                lastName: document.getElementById('new-lastname').value || undefined,
                email: document.getElementById('new-email').value,
                phone: document.getElementById('new-phone').value,
                dateOfBirth: document.getElementById('new-dob').value || undefined,
                marketingConsent: document.getElementById('new-consent').checked,
              }),
            });
            if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || 'Activeren mislukt'); }
            showStep('done');
          } catch (err) { errorEl.textContent = err.message; }
        }

        let existingEmail = '';
        async function requestExistingCode() {
          const errorEl = document.getElementById('existing-email-error');
          errorEl.textContent = '';
          existingEmail = document.getElementById('existing-email').value;
          try {
            // Hergebruikt exact hetzelfde endpoint als de app-inlogflow.
            await fetch(API_BASE + '/guest-app/organizations/' + ORG_ID + '/auth/request-code', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: existingEmail }),
            });
            showStep('existing-code');
          } catch (err) { errorEl.textContent = 'Kon geen code versturen'; }
        }

        async function verifyAndLink() {
          const errorEl = document.getElementById('existing-code-error');
          errorEl.textContent = '';
          try {
            const verifyRes = await fetch(API_BASE + '/guest-app/organizations/' + ORG_ID + '/auth/verify-code', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: existingEmail, code: document.getElementById('existing-code').value }),
            });
            if (!verifyRes.ok) throw new Error('Ongeldige code');
            const { token: sessionToken } = await verifyRes.json();

            const linkRes = await fetch(API_BASE + '/c/' + TOKEN + '/claim/link-existing', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionToken }),
            });
            if (!linkRes.ok) throw new Error('Koppelen mislukt');
            showStep('done');
          } catch (err) { errorEl.textContent = err.message; }
        }
      </script>
    `);
  }

  private htmlShell(styles: string, bodyContent: string): string {
    return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Strand tegoed — Kaart activeren</title>
<style>${styles}</style>
</head>
<body>
  <div class="card">${bodyContent}</div>
</body>
</html>`;
  }
}
