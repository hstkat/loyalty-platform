import { Controller, Get, Header, Param, Post, Body, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GiftCardsService } from './gift-cards.service';
import { MollieService } from '../common/mollie.service';

interface GiftCardBrandConfig {
  name: string;
  accent: string;
  accentDark: string;
}

// Zelfde merken/kleuren als de Mijn Tegoed-portal (customer-portal.controller.ts)
// — bewust hier apart gehouden i.p.v. gedeeld geïmporteerd, want deze
// controller kent geen afhankelijkheid op de portal-module en dit is
// een kleine, stabiele config die zelden wijzigt.
const GIFT_CARD_BRANDS: Record<string, GiftCardBrandConfig> = {
  'het-strand': { name: 'Het Strand', accent: '#c47a45', accentDark: '#a1642f' },
  zomers: { name: 'Zomers Beachclub & Brewery', accent: '#497a9d', accentDark: '#376079' },
};
const DEFAULT_GIFT_CARD_BRAND: GiftCardBrandConfig = { name: 'Het Strand & Zomers', accent: '#e8604a', accentDark: '#c94d38' };

/**
 * Publiek, niet-geauthenticeerd — net als bij de fysieke loyaltykaarten
 * (/c/:token) toont deze pagina bewust minimale, niet-gevoelige info:
 * alleen het saldo en de eventuele persoonlijke boodschap horend bij
 * DEZE ene kaart, nooit koper-/ontvangergegevens of andere kaarten.
 */
@Controller('gift-cards')
export class GiftCardCheckoutController {
  constructor(
    private prisma: PrismaService,
    private giftCards: GiftCardsService,
    private mollie: MollieService,
  ) {}

  /**
   * Mollie roept dit endpoint aan met alleen een `id` — nooit met een
   * status (zie MollieService voor waarom). We halen de echte status
   * altijd zelf opnieuw op bij Mollie voordat we ook maar iets
   * activeren. Mollie verwacht een simpele 200 OK, verder niets.
   */
  @Post('mollie-webhook')
  async mollieWebhook(@Body('id') bodyId: string, @Query('id') queryId: string) {
    const paymentId = bodyId || queryId;
    if (!paymentId) return { received: true };
    await this.giftCards.confirmMolliePayment(paymentId);
    return { received: true };
  }

  @Get('thank-you/:giftCardId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async thankYouPage(@Param('giftCardId') giftCardId: string, @Res() res: Response) {
    const giftCard = await this.prisma.giftCard.findUnique({
      where: { id: giftCardId },
      select: { status: true, giftCardNumber: true, currentBalance: true, recipientEmail: true, molliePaymentId: true },
    });

    const styles = `
      :root { --cream: #f6f3ec; --navy-dark: #0e1c2a; --white: #ffffff; --muted: rgba(240,244,247,0.6); --coral: #e8604a; --coral-light: #f08c78; --teal-dark: #6496b5; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: var(--cream); font-family: -apple-system, 'Inter', sans-serif; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .card { width: 100%; max-width: 380px; background: var(--navy-dark); border-radius: 24px; padding: 36px 28px; text-align: center; color: var(--white); }
      .brand { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
      h1 { font-family: Georgia, serif; font-size: 24px; font-weight: 500; margin: 0 0 16px; }
      p { font-size: 14px; color: rgba(240,244,247,0.8); line-height: 1.6; }
      a { color: var(--coral-light); }
      .btn { display: inline-block; margin-top: 12px; background: var(--coral); color: var(--white); text-decoration: none; padding: 12px 22px; border-radius: 8px; font-weight: 600; font-size: 14px; }
    `;

    // De webhook kan iets later aankomen dan de terugkeer van de klant
    // vanuit Mollie zelf — toon daarom een neutrale, geruststellende
    // boodschap, nooit een harde "mislukt" als de status nog 'draft' is.
    // En: nooit een e-mail beloven als er geen ontvanger-adres is
    // opgegeven. In dat geval is dít de ENIGE plek waar de klant ooit
    // bij zijn eigen token kan komen — we halen het daarom (alleen hier,
    // alleen nu) opnieuw op uit Mollie's metadata, waar het al veilig
    // stond, in plaats van het zelf op te slaan.
    let body: string;
    if (!giftCard) {
      body = `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Niet gevonden</h1><p>Deze bestelling kon niet worden gevonden.</p>`;
    } else if (giftCard.status === 'active') {
      if (giftCard.recipientEmail) {
        body = `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Bedankt voor je aankoop!</h1><p>Cadeaukaart ${giftCard.giftCardNumber} — €${Number(giftCard.currentBalance).toFixed(2)}. Je ontvangt hem per e-mail op ${giftCard.recipientEmail}.</p>`;
      } else {
        const rawToken = giftCard.molliePaymentId ? await this.recoverRawToken(giftCard.molliePaymentId) : null;
        const linkBlock = rawToken
          ? `<a class="btn" href="/g/${rawToken}">Bekijk mijn cadeaukaart</a><p style="margin-top:14px;font-size:12px;">Bewaar deze link — dit is je enige toegang tot de kaart.</p>`
          : `<p>Er ging iets mis bij het ophalen van je kaartlink. Neem contact op met de zaak, onder vermelding van kaartnummer ${giftCard.giftCardNumber}.</p>`;
        body = `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Bedankt voor je aankoop!</h1><p>Cadeaukaart ${giftCard.giftCardNumber} — €${Number(giftCard.currentBalance).toFixed(2)}.</p>${linkBlock}`;
      }
    } else {
      const deliveryNote = giftCard.recipientEmail
        ? 'je ontvangt de cadeaukaart zo snel mogelijk per e-mail.'
        : 'ververs deze pagina over een moment — je krijgt dan een link naar je kaart.';
      body = `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Bedankt!</h1><p>We verwerken je betaling nog even — ${deliveryNote}</p>`;
    }

    res.status(200).send(`<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Bedankt</title><style>${styles}</style></head><body><div class="card">${body}</div></body></html>`);
  }

  @Get('buy/:orgId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  buyPage(@Param('orgId') orgId: string, @Query('brand') brandParam: string | undefined, @Res() res: Response) {
    const brand = (brandParam && GIFT_CARD_BRANDS[brandParam]) || DEFAULT_GIFT_CARD_BRAND;
    res.status(200).send(this.renderBuyPage(orgId, brand));
  }

  // Voorkomt spam van lege concept-cadeaukaarten en herhaalde
  // Mollie-betaalverzoeken vanaf één bron.
  @Throttle({ default: { limit: 10, ttl: 300000 } })
  @Post('buy/:orgId')
  async startPurchase(
    @Param('orgId') orgId: string,
    @Body()
    body: {
      originalValue: number;
      recipientName?: string;
      recipientEmail?: string;
      personalMessage?: string;
    },
  ) {
    const publicAppUrl = process.env.PUBLIC_APP_URL || 'https://loyalty-platform-live.vercel.app';
    return this.giftCards.startOnlinePurchase(orgId, body, publicAppUrl);
  }

  private async recoverRawToken(molliePaymentId: string): Promise<string | null> {
    const payment = await this.mollie.getPayment(molliePaymentId);
    const rawToken = (payment?.metadata as { rawToken?: string } | null)?.rawToken;
    return rawToken ?? null;
  }

  private renderBuyPage(orgId: string, brand: GiftCardBrandConfig): string {
    const styles = `
      :root { --cream: #f6f3ec; --white: #ffffff; --navy: #1b3a5c; --navy-dark: #0e1c2a; --body-text: #3a4a5c; --muted: #7a8ea0; --accent: ${brand.accent}; --accent-dark: ${brand.accentDark}; --line: rgba(27,58,92,0.12); }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--cream); font-family: -apple-system, 'Inter', sans-serif; padding: 20px; }
      .card { width: 100%; max-width: 420px; margin: 0 auto; background: var(--white); border-radius: 20px; padding: 24px 22px; }
      .brand-label { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); font-weight: 600; margin-bottom: 6px; }
      h1 { font-family: Georgia, serif; font-size: 22px; color: var(--navy); margin: 0 0 18px; }
      .amounts { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
      .amount-chip { border: 1px solid var(--line); background: var(--cream); color: var(--navy); padding: 10px 18px; border-radius: 20px; font-size: 14px; cursor: pointer; }
      .amount-chip.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, white); color: var(--accent-dark); font-weight: 600; }
      input, textarea { width: 100%; padding: 11px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--cream); font-size: 14px; margin-bottom: 12px; font-family: inherit; color: var(--body-text); }
      textarea { resize: vertical; min-height: 60px; }
      button { width: 100%; padding: 14px; border-radius: 10px; border: none; background: var(--accent); color: white; font-weight: 600; font-size: 15px; cursor: pointer; }
      button:disabled { opacity: 0.6; }
      .error { color: var(--accent-dark); font-size: 13px; margin-top: 8px; min-height: 16px; }
      label { font-size: 12px; color: var(--navy); font-weight: 500; display: block; margin-bottom: 6px; }
    `;
    return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cadeaukaart kopen — ${brand.name}</title>
<style>${styles}</style>
</head>
<body>
  <div class="card">
    <div class="brand-label">${brand.name}</div>
    <h1>Cadeaukaart kopen</h1>
    <label>Bedrag</label>
    <div class="amounts" id="amounts">
      <div class="amount-chip" data-value="25">€25</div>
      <div class="amount-chip" data-value="50">€50</div>
      <div class="amount-chip" data-value="100">€100</div>
      <div class="amount-chip" data-value="custom">Anders…</div>
    </div>
    <input type="number" id="custom-amount" name="custom-amount" placeholder="Bedrag in € (min. €10)" min="10" step="0.01" style="display:none;">
    <label>Naam ontvanger (optioneel)</label>
    <input type="text" id="recipient-name" name="recipient-name" placeholder="Voor jezelf? Leeg laten" autocomplete="name">
    <label>E-mailadres ontvanger (optioneel)</label>
    <input type="email" id="recipient-email" name="recipient-email" placeholder="Waar mag de kaart heen?" autocomplete="email">
    <label>Persoonlijke boodschap (optioneel)</label>
    <textarea id="message" name="message" placeholder="Bijv. Gefeliciteerd!"></textarea>
    <button id="pay-btn">Doorgaan naar betalen</button>
    <div class="error" id="error"></div>
  </div>
  <script>
    // Hoogte doorgeven aan de omringende pagina — zelfde mechanisme als
    // de Mijn Tegoed-portal, zodat de WordPress-widget de iframe precies
    // zo hoog kan maken als de inhoud, zonder interne scrollbalk.
    function reportHeight() {
      window.parent.postMessage({ type: 'gift-card-buy-resize', height: document.body.scrollHeight }, '*');
    }
    window.addEventListener('load', reportHeight);
    setInterval(reportHeight, 500);

    let selectedAmount = null;
    document.querySelectorAll('.amount-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.amount-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        const customInput = document.getElementById('custom-amount');
        if (chip.dataset.value === 'custom') {
          customInput.style.display = 'block';
          selectedAmount = null;
        } else {
          customInput.style.display = 'none';
          selectedAmount = parseFloat(chip.dataset.value);
        }
        setTimeout(reportHeight, 50);
      });
    });

    document.getElementById('pay-btn').addEventListener('click', async () => {
      const errorEl = document.getElementById('error');
      errorEl.textContent = '';
      const amount = selectedAmount || parseFloat(document.getElementById('custom-amount').value);
      if (!amount || amount < 10) { errorEl.textContent = 'Minimaal bedrag is €10 (i.v.m. transactiekosten).'; setTimeout(reportHeight, 50); return; }

      const btn = document.getElementById('pay-btn');
      btn.disabled = true;
      btn.textContent = 'Bezig…';
      try {
        const res = await fetch(window.location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originalValue: amount,
            recipientName: document.getElementById('recipient-name').value || undefined,
            recipientEmail: document.getElementById('recipient-email').value || undefined,
            personalMessage: document.getElementById('message').value || undefined,
          }),
        });
        const data = await res.json();
        if (data.checkoutUrl) {
          // Cadeaukaart-checkout gaat naar Mollie's eigen betaalpagina —
          // dat kan (en mag) niet in de kleine widget-iframe, dus we
          // navigeren het HELE bovenliggende venster erheen (net als een
          // gewone "afrekenen"-link zou doen), niet alleen de iframe.
          if (window.top) { window.top.location.href = data.checkoutUrl; } else { window.location.href = data.checkoutUrl; }
        } else {
          errorEl.textContent = data.reason || 'Kon geen betaling starten.';
          btn.disabled = false;
          btn.textContent = 'Doorgaan naar betalen';
          setTimeout(reportHeight, 50);
        }
      } catch (err) {
        errorEl.textContent = 'Er ging iets mis. Probeer het opnieuw.';
        btn.disabled = false;
        btn.textContent = 'Doorgaan naar betalen';
        setTimeout(reportHeight, 50);
      }
    });
  </script>
</body>
</html>`;
  }
}

@Controller('g')
export class PublicGiftCardController {
  constructor(private prisma: PrismaService) {}

  @Get(':token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async viewPage(@Param('token') token: string, @Res() res: Response) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const giftCard = await this.prisma.giftCard.findUnique({
      where: { publicTokenHash: tokenHash },
      select: { status: true, currentBalance: true, originalValue: true, personalMessage: true, recipientName: true },
    });
    res.status(200).send(this.renderPage(giftCard, token));
  }

  private renderPage(
    card: { status: string; currentBalance: unknown; originalValue: unknown; personalMessage: string | null; recipientName: string | null } | null,
    token: string,
  ): string {
    const styles = `
      :root { --cream: #f6f3ec; --navy-dark: #0e1c2a; --white: #ffffff; --muted: rgba(240,244,247,0.6); --coral: #e8604a; --coral-light: #f08c78; --line: rgba(240,244,247,0.12); }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: var(--cream); font-family: -apple-system, 'Inter', sans-serif; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .card { width: 100%; max-width: 380px; background: var(--navy-dark); border-radius: 24px; padding: 36px 28px; text-align: center; color: var(--white); }
      .brand { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
      h1 { font-family: Georgia, serif; font-size: 24px; font-weight: 500; margin: 0 0 16px; }
      .balance { font-family: Georgia, serif; font-size: 48px; color: var(--coral-light); margin: 20px 0 6px; }
      .balance-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
      .message { font-style: italic; color: rgba(240,244,247,0.85); margin: 20px 0; padding: 16px; background: rgba(255,255,255,0.06); border-radius: 12px; font-size: 14px; }
      .qr-wrap { background: var(--white); border-radius: 16px; padding: 16px; display: inline-block; margin: 20px 0; }
      .qr-wrap img { display: block; width: 200px; height: 200px; }
      .token-text {
        font-family: 'Courier New', monospace; font-size: 16px; letter-spacing: 0.04em;
        color: var(--white); background: rgba(255,255,255,0.08); border-radius: 8px;
        padding: 10px 14px; margin: 4px 0 16px; word-break: break-all;
      }
      .token-hint { font-size: 11px; color: var(--muted); margin: 0 0 4px; }
      p { font-size: 14px; color: rgba(240,244,247,0.8); line-height: 1.6; margin: 0 0 8px; }
    `;

    if (!card) {
      return this.htmlShell(styles, `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Cadeaukaart niet gevonden</h1><p>Deze QR-code hoort niet bij een geldige cadeaukaart.</p>`);
    }
    if (card.status === 'draft') {
      return this.htmlShell(styles, `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Nog niet actief</h1><p>Deze fysieke kaart is nog niet geactiveerd — vraag dit bij de kassa aan.</p>`);
    }
    if (card.status === 'blocked' || card.status === 'expired' || card.status === 'cancelled') {
      return this.htmlShell(styles, `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Niet meer geldig</h1><p>Deze cadeaukaart is niet langer bruikbaar. Neem contact op met de zaak bij vragen.</p>`);
    }

    // Codeert het ruwe token zelf (niet de hele weergavepagina-URL) —
    // dat is precies wat de kassa's cadeaukaart-opzoekveld verwacht.
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(token)}`;
    const greeting = card.recipientName ? `Voor ${card.recipientName}` : 'Cadeaukaart';
    return this.htmlShell(
      styles,
      `<div class="brand">HET STRAND &amp; ZOMERS</div>
       <h1>${greeting}</h1>
       ${card.personalMessage ? `<div class="message">"${card.personalMessage}"</div>` : ''}
       <div class="balance-label">Beschikbaar saldo</div>
       <div class="balance">€${Number(card.currentBalance).toFixed(2)}</div>
       <div class="qr-wrap"><img src="${qrUrl}" alt="Cadeaukaart-QR"></div>
       <div class="token-hint">Werkt scannen niet? Geef deze code door aan de kassa:</div>
       <div class="token-text">${token}</div>
       <p>Toon deze pagina of de QR-code bij de kassa om te gebruiken.</p>`,
    );
  }

  private htmlShell(styles: string, bodyContent: string): string {
    return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Strand tegoed — Cadeaukaart</title>
<style>${styles}</style>
</head>
<body><div class="card">${bodyContent}</div></body>
</html>`;
  }
}
