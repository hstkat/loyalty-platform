import { Controller, Get, Header, Param, Post, Body, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GiftCardsService } from './gift-cards.service';

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
      select: { status: true, giftCardNumber: true, currentBalance: true },
    });

    const styles = `
      :root { --cream: #f6f3ec; --navy-dark: #0e1c2a; --white: #ffffff; --muted: rgba(240,244,247,0.6); --coral: #e8604a; --coral-light: #f08c78; --teal-dark: #6496b5; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: var(--cream); font-family: -apple-system, 'Inter', sans-serif; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .card { width: 100%; max-width: 380px; background: var(--navy-dark); border-radius: 24px; padding: 36px 28px; text-align: center; color: var(--white); }
      .brand { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
      h1 { font-family: Georgia, serif; font-size: 24px; font-weight: 500; margin: 0 0 16px; }
      p { font-size: 14px; color: rgba(240,244,247,0.8); line-height: 1.6; }
    `;

    // De webhook kan iets later aankomen dan de terugkeer van de klant
    // vanuit Mollie zelf — toon daarom een neutrale, geruststellende
    // boodschap, nooit een harde "mislukt" als de status nog 'draft' is.
    let body: string;
    if (!giftCard) {
      body = `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Niet gevonden</h1><p>Deze bestelling kon niet worden gevonden.</p>`;
    } else if (giftCard.status === 'active') {
      body = `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Bedankt voor je aankoop!</h1><p>Cadeaukaart ${giftCard.giftCardNumber} — €${Number(giftCard.currentBalance).toFixed(2)}. Je ontvangt hem per e-mail.</p>`;
    } else {
      body = `<div class="brand">HET STRAND &amp; ZOMERS</div><h1>Bedankt!</h1><p>We verwerken je betaling nog even — je ontvangt de cadeaukaart zo snel mogelijk per e-mail.</p>`;
    }

    res.status(200).send(`<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Bedankt</title><style>${styles}</style></head><body><div class="card">${body}</div></body></html>`);
  }

  @Get('buy/:orgId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  buyPage(@Param('orgId') orgId: string, @Res() res: Response) {
    res.status(200).send(this.renderBuyPage(orgId));
  }

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

  private renderBuyPage(orgId: string): string {
    const styles = `
      :root { --cream: #f6f3ec; --white: #ffffff; --navy: #1b3a5c; --navy-dark: #0e1c2a; --body-text: #3a4a5c; --muted: #7a8ea0; --coral: #e8604a; --line: rgba(27,58,92,0.12); }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: var(--cream); font-family: -apple-system, 'Inter', sans-serif; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .card { width: 100%; max-width: 420px; background: var(--white); border-radius: 24px; padding: 32px 28px; box-shadow: 0 4px 24px rgba(27,58,92,0.1); }
      h1 { font-family: Georgia, serif; font-size: 22px; color: var(--navy); margin: 0 0 18px; }
      .amounts { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
      .amount-chip { border: 1px solid var(--line); background: var(--cream); color: var(--navy); padding: 10px 18px; border-radius: 20px; font-size: 14px; cursor: pointer; }
      .amount-chip.selected { border-color: var(--coral); background: rgba(232,96,74,0.08); color: var(--coral); font-weight: 600; }
      input, textarea { width: 100%; padding: 11px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--cream); font-size: 14px; margin-bottom: 12px; font-family: inherit; color: var(--body-text); }
      textarea { resize: vertical; min-height: 60px; }
      button { width: 100%; padding: 14px; border-radius: 10px; border: none; background: var(--coral); color: white; font-weight: 600; font-size: 15px; cursor: pointer; }
      button:disabled { opacity: 0.6; }
      .error { color: var(--coral); font-size: 13px; margin-top: 8px; min-height: 16px; }
      label { font-size: 12px; color: var(--navy); font-weight: 500; display: block; margin-bottom: 6px; }
    `;
    return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cadeaukaart kopen — Het Strand &amp; Zomers</title>
<style>${styles}</style>
</head>
<body>
  <div class="card">
    <h1>Cadeaukaart kopen</h1>
    <label>Bedrag</label>
    <div class="amounts" id="amounts">
      <div class="amount-chip" data-value="25">€25</div>
      <div class="amount-chip" data-value="50">€50</div>
      <div class="amount-chip" data-value="100">€100</div>
      <div class="amount-chip" data-value="custom">Anders…</div>
    </div>
    <input type="number" id="custom-amount" placeholder="Bedrag in €" min="1" step="0.01" style="display:none;">
    <label>Naam ontvanger (optioneel)</label>
    <input type="text" id="recipient-name" placeholder="Voor jezelf? Leeg laten">
    <label>E-mailadres ontvanger (optioneel)</label>
    <input type="email" id="recipient-email" placeholder="Waar mag de kaart heen?">
    <label>Persoonlijke boodschap (optioneel)</label>
    <textarea id="message" placeholder="Bijv. Gefeliciteerd!"></textarea>
    <button id="pay-btn">Doorgaan naar betalen</button>
    <div class="error" id="error"></div>
  </div>
  <script>
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
      });
    });

    document.getElementById('pay-btn').addEventListener('click', async () => {
      const errorEl = document.getElementById('error');
      errorEl.textContent = '';
      const amount = selectedAmount || parseFloat(document.getElementById('custom-amount').value);
      if (!amount || amount <= 0) { errorEl.textContent = 'Kies of vul een geldig bedrag in.'; return; }

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
          window.location.href = data.checkoutUrl;
        } else {
          errorEl.textContent = data.reason || 'Kon geen betaling starten.';
          btn.disabled = false;
          btn.textContent = 'Doorgaan naar betalen';
        }
      } catch (err) {
        errorEl.textContent = 'Er ging iets mis. Probeer het opnieuw.';
        btn.disabled = false;
        btn.textContent = 'Doorgaan naar betalen';
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
