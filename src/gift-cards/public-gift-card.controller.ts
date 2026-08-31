import { Controller, Get, Header, Param, Post, Body, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { escapeHtml } from '../common/escape-html';
import { GiftCardsService } from './gift-cards.service';
import { MollieService } from '../common/mollie.service';

interface GiftCardBrandConfig {
  slug: string;
  name: string;
  accent: string;
  accentDark: string;
  websiteUrl: string;
}

// Zelfde merken/kleuren als de Mijn Tegoed-portal (customer-portal.controller.ts)
// — bewust hier apart gehouden i.p.v. gedeeld geïmporteerd, want deze
// controller kent geen afhankelijkheid op de portal-module en dit is
// een kleine, stabiele config die zelden wijzigt.
const GIFT_CARD_BRANDS: Record<string, GiftCardBrandConfig> = {
  'het-strand': { slug: 'het-strand', name: 'Het Strand', accent: '#c47a45', accentDark: '#a1642f', websiteUrl: 'https://hetstrand.nl' },
  zomers: { slug: 'zomers', name: 'Zomers Beachclub & Brewery', accent: '#497a9d', accentDark: '#376079', websiteUrl: 'https://zomersbeachclub.nl' },
};
const DEFAULT_GIFT_CARD_BRAND: GiftCardBrandConfig = { slug: '', name: 'Het Strand & Zomers', accent: '#e8604a', accentDark: '#c94d38', websiteUrl: 'https://hetstrand.nl' };

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
  async thankYouPage(@Param('giftCardId') giftCardId: string, @Query('brand') brandParam: string | undefined, @Res() res: Response) {
    const brand = (brandParam && GIFT_CARD_BRANDS[brandParam]) || DEFAULT_GIFT_CARD_BRAND;
    const brandLabel = brand.slug ? brand.name.toUpperCase() : 'HET STRAND &amp; ZOMERS';
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
      .redirect-note { margin-top: 22px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,0.12); font-size: 12.5px; color: var(--muted); }
      .redirect-note a { color: var(--white); text-decoration: underline; }
    `;

    // De webhook kan iets later aankomen dan de terugkeer van de gast
    // vanuit Mollie zelf — toon daarom een neutrale, geruststellende
    // boodschap, nooit een harde "mislukt" als de status nog 'draft' is.
    // En: nooit een e-mail beloven als er geen ontvanger-adres is
    // opgegeven. In dat geval is dít de ENIGE plek waar de gast ooit
    // bij zijn eigen token kan komen — we halen het daarom (alleen hier,
    // alleen nu) opnieuw op uit Mollie's metadata, waar het al veilig
    // stond, in plaats van het zelf op te slaan.
    let body: string;
    if (!giftCard) {
      body = `<div class="brand">${brandLabel}</div><h1>Niet gevonden</h1><p>Deze bestelling kon niet worden gevonden.</p>`;
    } else if (giftCard.status === 'active') {
      if (giftCard.recipientEmail) {
        body = `<div class="brand">${brandLabel}</div><h1>Bedankt voor je aankoop!</h1><p>Kadobon ${giftCard.giftCardNumber} — €${Number(giftCard.currentBalance).toFixed(2)}. Je ontvangt hem per e-mail op ${escapeHtml(giftCard.recipientEmail)}.</p>`;
      } else {
        const rawToken = giftCard.molliePaymentId ? await this.recoverRawToken(giftCard.molliePaymentId) : null;
        const linkBlock = rawToken
          ? `<a class="btn" href="/g/${rawToken}">Bekijk mijn kadobon</a><p style="margin-top:14px;font-size:12px;">Bewaar deze link — dit is je enige toegang tot de kaart.</p>`
          : `<p>Er ging iets mis bij het ophalen van je kaartlink. Neem contact op met de zaak, onder vermelding van kaartnummer ${giftCard.giftCardNumber}.</p>`;
        body = `<div class="brand">${brandLabel}</div><h1>Bedankt voor je aankoop!</h1><p>Kadobon ${giftCard.giftCardNumber} — €${Number(giftCard.currentBalance).toFixed(2)}.</p>${linkBlock}`;
      }
    } else {
      const deliveryNote = giftCard.recipientEmail
        ? 'je ontvangt de kadobon zo snel mogelijk per e-mail.'
        : 'ververs deze pagina over een moment — je krijgt dan een link naar je kaart.';
      body = `<div class="brand">${brandLabel}</div><h1>Bedankt!</h1><p>We verwerken je betaling nog even — ${deliveryNote}</p>`;
    }

    // Automatisch terug naar de website na 10 seconden — met zichtbare
    // aftelling en een directe link als iemand niet wil wachten. Geen
    // meta-refresh (die kan de countdown-tekst niet live bijwerken);
    // gewoon JS, met de handmatige link als terugval voor het geval JS
    // faalt of iemand 'm eerder wil gebruiken.
    const redirectScript = `
      <script>
        (function () {
          var seconds = 10;
          var el = document.getElementById('redirect-countdown');
          var timer = setInterval(function () {
            seconds -= 1;
            if (el) el.textContent = seconds;
            if (seconds <= 0) {
              clearInterval(timer);
              window.location.href = ${JSON.stringify(brand.websiteUrl)};
            }
          }, 1000);
        })();
      </script>
    `;
    body += `<div class="redirect-note">Je wordt over <span id="redirect-countdown">10</span> seconden teruggestuurd naar de website. <a href="${brand.websiteUrl}">Ga nu direct terug</a></div>`;

    res.status(200).send(`<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Bedankt</title><style>${styles}</style></head><body><div class="card">${body}</div>${redirectScript}</body></html>`);
  }

  /**
   * Bulk-variant van thankYouPage: giftCardId in de URL is de EERSTE
   * kaart van de batch (zie startBulkOnlinePurchase — Mollie kent zijn
   * eigen payment-ID nog niet op het moment dat de redirectUrl wordt
   * opgegeven). Zoekt via die kaart het molliePaymentId op en toont
   * daarna ALLE kaarten die bij diezelfde betaling horen.
   */
  @Get('thank-you-bulk/:giftCardId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async thankYouBulkPage(@Param('giftCardId') giftCardId: string, @Query('brand') brandParam: string | undefined, @Res() res: Response) {
    const brand = (brandParam && GIFT_CARD_BRANDS[brandParam]) || DEFAULT_GIFT_CARD_BRAND;
    const brandLabel = brand.slug ? brand.name.toUpperCase() : 'HET STRAND &amp; ZOMERS';

    const firstCard = await this.prisma.giftCard.findUnique({ where: { id: giftCardId }, select: { molliePaymentId: true } });

    const styles = `
      :root { --cream: #f6f3ec; --navy-dark: #0e1c2a; --white: #ffffff; --muted: rgba(240,244,247,0.6); --coral: #e8604a; --coral-light: #f08c78; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: var(--cream); font-family: -apple-system, 'Inter', sans-serif; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .card { width: 100%; max-width: 420px; background: var(--navy-dark); border-radius: 24px; padding: 36px 28px; text-align: center; color: var(--white); }
      .brand { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
      h1 { font-family: Georgia, serif; font-size: 24px; font-weight: 500; margin: 0 0 16px; }
      p { font-size: 14px; color: rgba(240,244,247,0.8); line-height: 1.6; }
      .card-list { text-align: left; margin-top: 18px; border-top: 1px solid rgba(255,255,255,0.12); padding-top: 14px; }
      .card-row { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.08); }
      .card-row .recipient { color: rgba(240,244,247,0.65); }
      .redirect-note { margin-top: 22px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,0.12); font-size: 12.5px; color: var(--muted); }
      .redirect-note a { color: var(--white); text-decoration: underline; }
    `;

    let body: string;
    if (!firstCard || !firstCard.molliePaymentId) {
      body = `<div class="brand">${brandLabel}</div><h1>Niet gevonden</h1><p>Deze bestelling kon niet worden gevonden.</p>`;
    } else {
      const allCards = await this.prisma.giftCard.findMany({
        where: { molliePaymentId: firstCard.molliePaymentId },
        select: { giftCardNumber: true, currentBalance: true, originalValue: true, status: true, recipientName: true, recipientEmail: true },
        orderBy: { giftCardNumber: 'asc' },
      });
      const anyActive = allCards.some((c) => c.status === 'active');
      const totalAmount = allCards.reduce((sum, c) => sum + Number(c.originalValue), 0);

      if (anyActive) {
        const rows = allCards
          .map((c) => {
            const recipient = c.recipientEmail ? `${escapeHtml(c.recipientName || '(geen naam)')} — ${escapeHtml(c.recipientEmail)}` : '(voor jezelf)';
            return `<div class="card-row"><span>${c.giftCardNumber} — €${Number(c.originalValue).toFixed(2)}</span><span class="recipient">${recipient}</span></div>`;
          })
          .join('');
        body = `<div class="brand">${brandLabel}</div><h1>Bedankt voor je aankoop!</h1><p>${allCards.length} kadobonnen — totaal €${totalAmount.toFixed(2)}. Ontvangers met een e-mailadres krijgen hun kaart per e-mail.</p><div class="card-list">${rows}</div>`;
      } else {
        body = `<div class="brand">${brandLabel}</div><h1>Bedankt!</h1><p>We verwerken je betaling nog even — je ontvangt je kadobonnen zo snel mogelijk per e-mail.</p>`;
      }
    }

    const redirectScript = `
      <script>
        (function () {
          var seconds = 10;
          var el = document.getElementById('redirect-countdown');
          var timer = setInterval(function () {
            seconds -= 1;
            if (el) el.textContent = seconds;
            if (seconds <= 0) {
              clearInterval(timer);
              window.location.href = ${JSON.stringify(brand.websiteUrl)};
            }
          }, 1000);
        })();
      </script>
    `;
    body += `<div class="redirect-note">Je wordt over <span id="redirect-countdown">10</span> seconden teruggestuurd naar de website. <a href="${brand.websiteUrl}">Ga nu direct terug</a></div>`;

    res.status(200).send(`<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Bedankt</title><style>${styles}</style></head><body><div class="card">${body}</div>${redirectScript}</body></html>`);
  }

  @Get('buy/:orgId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  buyPage(@Param('orgId') orgId: string, @Query('brand') brandParam: string | undefined, @Res() res: Response) {
    const brand = (brandParam && GIFT_CARD_BRANDS[brandParam]) || DEFAULT_GIFT_CARD_BRAND;
    res.status(200).send(this.renderBuyPage(orgId, brand));
  }

  // Voorkomt spam van lege concept-kadobonnen en herhaalde
  // Mollie-betaalverzoeken vanaf één bron.
  @Throttle({ default: { limit: 10, ttl: 300000 } })
  @Post('buy/:orgId')
  async startPurchase(
    @Param('orgId') orgId: string,
    @Body()
    body: {
      originalValue: number;
      brand?: string;
      recipientName?: string;
      recipientEmail?: string;
      senderName?: string;
      senderEmail?: string;
      personalMessage?: string;
    },
  ) {
    const publicAppUrl = process.env.PUBLIC_APP_URL || 'https://loyalty-platform-live.vercel.app';
    return this.giftCards.startOnlinePurchase(orgId, body, publicAppUrl);
  }

  // Bulk-aankoop: meerdere ontvangers/bedragen, één betaling — zelfde
  // spam-beperking als de losse aankoop.
  @Throttle({ default: { limit: 10, ttl: 300000 } })
  @Post('buy-bulk/:orgId')
  async startBulkPurchase(
    @Param('orgId') orgId: string,
    @Body()
    body: {
      brand?: string;
      senderName: string;
      senderEmail: string;
      items: { originalValue: number; recipientName?: string; recipientEmail?: string; personalMessage?: string }[];
    },
  ) {
    const publicAppUrl = process.env.PUBLIC_APP_URL || 'https://loyalty-platform-live.vercel.app';
    return this.giftCards.startBulkOnlinePurchase(orgId, body, publicAppUrl);
  }

  private async recoverRawToken(molliePaymentId: string): Promise<string | null> {
    const payment = await this.mollie.getPayment(molliePaymentId);
    const rawToken = (payment?.metadata as { rawToken?: string } | null)?.rawToken;
    return rawToken ?? null;
  }

  private renderBuyPage(orgId: string, brand: GiftCardBrandConfig): string {
    const styles = `
      :root { --cream: #f6f3ec; --white: #ffffff; --navy: #1b3a5c; --navy-dark: #0e1c2a; --body-text: #3a4a5c; --muted: #7a8ea0; --accent: ${brand.accent}; --accent-dark: ${brand.accentDark}; --line: rgba(27,58,92,0.1); }
      * { box-sizing: border-box; }
      body { margin: 0; background: transparent; font-family: -apple-system, 'Inter', sans-serif; padding: 14px; }
      .frame { width: 100%; max-width: 420px; margin: 0 auto; background: var(--accent); border-radius: 22px; padding: 14px; }
      .banner { border-radius: 14px; padding: 22px 20px 18px; margin-bottom: 14px; background: linear-gradient(160deg, var(--navy-dark), var(--navy)); }
      .banner-label { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: color-mix(in srgb, var(--accent) 70%, white); font-weight: 700; margin-bottom: 6px; }
      .banner-title { font-family: Georgia, serif; font-size: 26px; color: var(--white); font-weight: 700; letter-spacing: 0.01em; text-transform: uppercase; }
      .panel { background: var(--white); border-radius: 14px; padding: 18px 18px 6px; margin-bottom: 12px; }
      .panel-title { font-family: Georgia, serif; font-size: 17px; color: var(--navy); margin-bottom: 3px; }
      .panel-sub { font-size: 12.5px; color: var(--muted); margin-bottom: 14px; line-height: 1.4; }
      .amounts { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
      .amount-chip { border: 1px solid var(--line); background: var(--cream); color: var(--navy); padding: 10px 18px; border-radius: 20px; font-size: 14px; cursor: pointer; }
      .amount-chip.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, white); color: var(--accent-dark); font-weight: 600; }
      .field-row { display: flex; gap: 10px; }
      .field-row > div { flex: 1; min-width: 0; }
      input, textarea { width: 100%; padding: 11px 13px; border-radius: 9px; border: 1px solid var(--line); background: var(--cream); font-size: 14px; margin-bottom: 14px; font-family: inherit; color: var(--body-text); }
      textarea { resize: vertical; min-height: 60px; }
      label { font-size: 12.5px; color: var(--navy); font-weight: 600; display: block; margin-bottom: 6px; }
      .toggle-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; cursor: pointer; user-select: none; }
      .toggle-row span.label-text { font-size: 13.5px; color: var(--navy); font-weight: 500; }
      .toggle-switch { position: relative; width: 40px; height: 23px; flex-shrink: 0; }
      .toggle-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
      .toggle-slider { position: absolute; inset: 0; background: var(--line); border-radius: 20px; transition: background 0.15s; pointer-events: none; }
      .toggle-slider::before { content: ''; position: absolute; width: 17px; height: 17px; left: 3px; top: 3px; background: var(--white); border-radius: 50%; transition: transform 0.15s; }
      .toggle-switch input:checked + .toggle-slider { background: var(--accent); }
      .toggle-switch input:checked + .toggle-slider::before { transform: translateX(17px); }
      #message-field { display: none; }
      button#pay-btn, button#bulk-pay-btn { width: 100%; padding: 15px; border-radius: 11px; border: none; background: var(--accent-dark); color: white; font-weight: 700; font-size: 15px; cursor: pointer; margin-top: 2px; }
      button#pay-btn:disabled, button#bulk-pay-btn:disabled { opacity: 0.6; }
      .bulk-row { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; position: relative; }
      .bulk-row .bulk-row-title { font-size: 12px; font-weight: 700; color: var(--navy); margin-bottom: 8px; }
      .bulk-row input, .bulk-row textarea { margin-bottom: 8px; }
      .bulk-row-remove { position: absolute; top: 10px; right: 10px; background: none; border: none; color: var(--muted); font-size: 18px; cursor: pointer; line-height: 1; padding: 2px 6px; }
      .error { color: var(--white); background: rgba(0,0,0,0.18); border-radius: 8px; padding: 0; font-size: 13px; margin-top: 10px; min-height: 0; text-align: center; }
      .error:not(:empty) { padding: 10px; }
    `;
    return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kadobon kopen — ${brand.name}</title>
<style>${styles}</style>
</head>
<body>
  <div class="frame">
    <div class="banner">
      <div class="banner-label">${brand.name}</div>
      <div class="banner-title">Kadobon</div>
    </div>

    <div id="bulk-toggle-row" style="text-align:center;margin-bottom:12px;">
      <a href="#" id="switch-to-bulk-link" style="color:var(--white);font-size:12.5px;font-weight:600;text-decoration:underline;">Meerdere kadobonnen voor verschillende mensen kopen?</a>
    </div>

    <div class="panel" id="single-amount-panel">
      <div class="panel-title">Bedrag</div>
      <div class="panel-sub">Kies een bedrag of vul er zelf een in.</div>
      <div class="amounts" id="amounts">
        <div class="amount-chip" data-value="25">€25</div>
        <div class="amount-chip" data-value="50">€50</div>
        <div class="amount-chip" data-value="100">€100</div>
        <div class="amount-chip" data-value="custom">Anders…</div>
      </div>
      <input type="number" id="custom-amount" name="custom-amount" placeholder="Bedrag in € (min. €10)" min="10" step="0.01" style="display:none;">
    </div>

    <div class="panel">
      <div class="panel-title">Je gegevens</div>
      <div class="panel-sub">Je ontvangt een bevestiging van je bestelling.</div>
      <label>Je naam</label>
      <input type="text" id="sender-name" name="sender-name" placeholder="Voornaam en achternaam" autocomplete="name">
      <label>Je e-mailadres</label>
      <input type="email" id="sender-email" name="sender-email" placeholder="Voor je aankoopbevestiging" autocomplete="email">
    </div>

    <div class="panel" id="single-recipient-panel">
      <div class="panel-title">Gegevens ontvanger</div>
      <div class="panel-sub">De ontvanger ontvangt een e-mail met de kaart. Voor jezelf? Laat leeg.</div>
      <label>Naam ontvanger (optioneel)</label>
      <input type="text" id="recipient-name" name="recipient-name" placeholder="Voor wie is de kaart?" autocomplete="off">
      <label>E-mailadres ontvanger (optioneel)</label>
      <input type="email" id="recipient-email" name="recipient-email" placeholder="Waar mag de kaart heen?" autocomplete="off">
    </div>

    <div class="panel" id="single-message-panel">
      <label class="toggle-row" id="message-toggle-row">
        <span class="toggle-switch"><input type="checkbox" id="message-toggle"><span class="toggle-slider"></span></span>
        <span class="label-text">Voeg een persoonlijk bericht toe</span>
      </label>
      <div id="message-field">
        <textarea id="message" name="message" placeholder="Bijv. Gefeliciteerd!"></textarea>
      </div>
    </div>

    <div class="panel" id="bulk-panel" style="display:none;">
      <div class="panel-title">Meerdere kadobonnen</div>
      <div class="panel-sub">Elke rij wordt een eigen kadobon met eigen bedrag en ontvanger — allemaal in één betaling.</div>
      <div id="bulk-rows"></div>
      <button type="button" id="bulk-add-row-btn" style="width:100%;padding:10px;border-radius:9px;border:1px dashed var(--line);background:var(--cream);color:var(--navy);font-size:13px;font-weight:600;cursor:pointer;margin-top:4px;">+ Nog een kadobon toevoegen</button>
      <div id="bulk-total" style="text-align:right;font-size:13px;color:var(--navy);font-weight:600;margin-top:10px;"></div>
    </div>

    <div id="single-mode-footer">
      <button id="pay-btn">Doorgaan naar betalen</button>
    </div>
    <div id="bulk-mode-footer" style="display:none;">
      <button id="bulk-pay-btn">Doorgaan naar betalen</button>
      <div style="text-align:center;margin-top:8px;"><a href="#" id="switch-to-single-link" style="color:var(--white);opacity:0.85;font-size:12px;text-decoration:underline;">← Terug naar één kadobon</a></div>
    </div>
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

    // Bewust GEEN regex-literal hier — dit stukje JS zit genest in een
    // grote TypeScript-template-literal (renderBuyPage() bouwt de hele
    // pagina als één backtick-string), en een \s daarin verloor zijn
    // backslash bij het compileren (werd stille "s"), waardoor elk
    // e-mailadres met een letter "s" vóór de @ per ongeluk werd
    // afgekeurd. Deze check gebruikt alleen losse stringbewerkingen,
    // dus geen backslash die verkeerd kan escapen.
    function isValidEmailFormat(value) {
      if (!value || value.indexOf(' ') !== -1) return false;
      const atParts = value.split('@');
      if (atParts.length !== 2 || !atParts[0] || !atParts[1]) return false;
      const domainParts = atParts[1].split('.');
      if (domainParts.length < 2) return false;
      return domainParts.every(function (part) { return part.length > 0; });
    }

    document.getElementById('message-toggle').addEventListener('change', function () {
      document.getElementById('message-field').style.display = this.checked ? 'block' : 'none';
      setTimeout(reportHeight, 50);
    });

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

      const senderName = document.getElementById('sender-name').value.trim();
      const senderEmail = document.getElementById('sender-email').value.trim();
      const recipientEmail = document.getElementById('recipient-email').value.trim();
      if (!senderName) { errorEl.textContent = 'Vul je naam in.'; setTimeout(reportHeight, 50); return; }
      if (!isValidEmailFormat(senderEmail)) { errorEl.textContent = 'Vul een geldig e-mailadres in (voor je aankoopbevestiging).'; setTimeout(reportHeight, 50); return; }
      if (recipientEmail && !isValidEmailFormat(recipientEmail)) { errorEl.textContent = 'Het e-mailadres van de ontvanger lijkt niet geldig.'; setTimeout(reportHeight, 50); return; }

      const btn = document.getElementById('pay-btn');
      btn.disabled = true;
      btn.textContent = 'Bezig…';
      try {
        const res = await fetch(window.location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originalValue: amount,
            brand: ${JSON.stringify(brand.slug)},
            recipientName: document.getElementById('recipient-name').value || undefined,
            recipientEmail: recipientEmail || undefined,
            senderName: senderName,
            senderEmail: senderEmail,
            personalMessage: document.getElementById('message').value || undefined,
          }),
        });
        const data = await res.json();
        if (data.checkoutUrl) {
          // Kadobon-checkout gaat naar Mollie's eigen betaalpagina —
          // dat kan (en mag) niet in de kleine widget-iframe, dus we
          // navigeren het HELE bovenliggende venster erheen (net als een
          // gewone "afrekenen"-link zou doen), niet alleen de iframe.
          if (window.top) { window.top.location.href = data.checkoutUrl; } else { window.location.href = data.checkoutUrl; }
        } else {
          errorEl.textContent = data.reason || data.message || 'Kon geen betaling starten.';
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

    // -- Bulk-modus: meerdere ontvangers/bedragen in één betaling ---------

    let bulkRowCount = 0;
    function addBulkRow() {
      bulkRowCount += 1;
      const rowId = bulkRowCount;
      const wrap = document.createElement('div');
      wrap.className = 'bulk-row';
      wrap.dataset.rowId = rowId;
      wrap.innerHTML =
        '<button type="button" class="bulk-row-remove" title="Verwijderen">&times;</button>' +
        '<div class="bulk-row-title">Kadobon ' + rowId + '</div>' +
        '<input type="number" class="bulk-amount" placeholder="Bedrag in € (min. €10)" min="10" step="0.01">' +
        '<input type="text" class="bulk-recipient-name" placeholder="Naam ontvanger (optioneel)" autocomplete="off">' +
        '<input type="email" class="bulk-recipient-email" placeholder="E-mailadres ontvanger (optioneel)" autocomplete="off">' +
        '<textarea class="bulk-message" placeholder="Persoonlijk bericht (optioneel)" style="min-height:44px;"></textarea>';
      document.getElementById('bulk-rows').appendChild(wrap);
      wrap.querySelector('.bulk-row-remove').addEventListener('click', () => {
        // Minstens 1 rij moet overblijven — een lege bulk-bestelling kan niet.
        if (document.querySelectorAll('.bulk-row').length <= 1) return;
        wrap.remove();
        updateBulkTotal();
        setTimeout(reportHeight, 50);
      });
      wrap.querySelector('.bulk-amount').addEventListener('input', updateBulkTotal);
      setTimeout(reportHeight, 50);
    }

    function updateBulkTotal() {
      const total = Array.from(document.querySelectorAll('.bulk-amount'))
        .reduce((sum, input) => sum + (parseFloat(input.value) || 0), 0);
      document.getElementById('bulk-total').textContent = total > 0 ? 'Totaal: €' + total.toFixed(2) : '';
    }

    document.getElementById('bulk-add-row-btn').addEventListener('click', addBulkRow);

    document.getElementById('switch-to-bulk-link').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('single-amount-panel').style.display = 'none';
      document.getElementById('single-recipient-panel').style.display = 'none';
      document.getElementById('single-message-panel').style.display = 'none';
      document.getElementById('single-mode-footer').style.display = 'none';
      document.getElementById('bulk-toggle-row').style.display = 'none';
      document.getElementById('bulk-panel').style.display = 'block';
      document.getElementById('bulk-mode-footer').style.display = 'block';
      if (document.querySelectorAll('.bulk-row').length === 0) { addBulkRow(); addBulkRow(); }
      document.getElementById('error').textContent = '';
      setTimeout(reportHeight, 50);
    });

    document.getElementById('switch-to-single-link').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('single-amount-panel').style.display = 'block';
      document.getElementById('single-recipient-panel').style.display = 'block';
      document.getElementById('single-message-panel').style.display = 'block';
      document.getElementById('single-mode-footer').style.display = 'block';
      document.getElementById('bulk-toggle-row').style.display = 'block';
      document.getElementById('bulk-panel').style.display = 'none';
      document.getElementById('bulk-mode-footer').style.display = 'none';
      document.getElementById('error').textContent = '';
      setTimeout(reportHeight, 50);
    });

    document.getElementById('bulk-pay-btn').addEventListener('click', async () => {
      const errorEl = document.getElementById('error');
      errorEl.textContent = '';

      const senderName = document.getElementById('sender-name').value.trim();
      const senderEmail = document.getElementById('sender-email').value.trim();
      if (!senderName) { errorEl.textContent = 'Vul je naam in.'; setTimeout(reportHeight, 50); return; }
      if (!isValidEmailFormat(senderEmail)) { errorEl.textContent = 'Vul een geldig e-mailadres in (voor je aankoopbevestiging).'; setTimeout(reportHeight, 50); return; }

      const rows = Array.from(document.querySelectorAll('.bulk-row'));
      const items = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const amount = parseFloat(row.querySelector('.bulk-amount').value);
        if (!amount || amount < 10) { errorEl.textContent = 'Kadobon ' + (i + 1) + ': minimaal bedrag is €10.'; setTimeout(reportHeight, 50); return; }
        const recipientEmail = row.querySelector('.bulk-recipient-email').value.trim();
        if (recipientEmail && !isValidEmailFormat(recipientEmail)) { errorEl.textContent = 'Kadobon ' + (i + 1) + ': het e-mailadres van de ontvanger lijkt niet geldig.'; setTimeout(reportHeight, 50); return; }
        items.push({
          originalValue: amount,
          recipientName: row.querySelector('.bulk-recipient-name').value.trim() || undefined,
          recipientEmail: recipientEmail || undefined,
          personalMessage: row.querySelector('.bulk-message').value.trim() || undefined,
        });
      }

      const btn = document.getElementById('bulk-pay-btn');
      btn.disabled = true;
      btn.textContent = 'Bezig…';
      try {
        const bulkPath = window.location.pathname.replace('/buy/', '/buy-bulk/');
        const res = await fetch(bulkPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            brand: ${JSON.stringify(brand.slug)},
            senderName: senderName,
            senderEmail: senderEmail,
            items: items,
          }),
        });
        const data = await res.json();
        if (data.checkoutUrl) {
          if (window.top) { window.top.location.href = data.checkoutUrl; } else { window.location.href = data.checkoutUrl; }
        } else {
          errorEl.textContent = data.reason || data.message || 'Kon geen betaling starten.';
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
      select: { status: true, currentBalance: true, originalValue: true, personalMessage: true, recipientName: true, expiresAt: true },
    });
    res.status(200).send(this.renderPage(giftCard, token));
  }

  private renderPage(
    card: { status: string; currentBalance: unknown; originalValue: unknown; personalMessage: string | null; recipientName: string | null; expiresAt: Date | null } | null,
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
      return this.htmlShell(styles, `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Kadobon niet gevonden</h1><p>Deze QR-code hoort niet bij een geldige kadobon.</p>`);
    }
    if (card.status === 'draft') {
      return this.htmlShell(styles, `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Nog niet actief</h1><p>Deze fysieke kaart is nog niet geactiveerd — vraag dit bij de kassa aan.</p>`);
    }
    if (card.status === 'blocked' || card.status === 'expired' || card.status === 'cancelled') {
      return this.htmlShell(styles, `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Niet meer geldig</h1><p>Deze kadobon is niet langer bruikbaar. Neem contact op met de zaak bij vragen.</p>`);
    }

    // Codeert het ruwe token zelf (niet de hele weergavepagina-URL) —
    // dat is precies wat de kassa's kadobon-opzoekveld verwacht.
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(token)}`;
    const greeting = card.recipientName ? `Voor ${escapeHtml(card.recipientName)}` : 'Kadobon';
    const expiryLine = card.expiresAt
      ? `<p style="margin-top:12px;">Geldig tot ${card.expiresAt.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}</p>`
      : '';
    return this.htmlShell(
      styles,
      `<div class="brand">HET STRAND &amp; ZOMERS</div>
       <h1>${greeting}</h1>
       ${card.personalMessage ? `<div class="message">"${escapeHtml(card.personalMessage)}"</div>` : ''}
       <div class="balance-label">Beschikbaar saldo</div>
       <div class="balance">€${Number(card.currentBalance).toFixed(2)}</div>
       <div class="qr-wrap"><img src="${qrUrl}" alt="Kadobon-QR"></div>
       <div class="token-hint">Werkt scannen niet? Geef deze code door aan de kassa:</div>
       <div class="token-text">${token}</div>
       <p>Toon deze pagina of de QR-code bij de kassa om te gebruiken.</p>
       ${expiryLine}`,
    );
  }

  private htmlShell(styles: string, bodyContent: string): string {
    return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Strand tegoed — Kadobon</title>
<style>${styles}</style>
</head>
<body><div class="card">${bodyContent}</div></body>
</html>`;
  }
}
