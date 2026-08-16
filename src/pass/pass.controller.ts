import { Controller, Get, Header, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A real Apple Wallet / Google Wallet pass (.pkpass / Google Wallet API)
 * requires the business's own Apple Developer account (paid, requires
 * business verification) and/or Google Cloud + Wallet API enrollment —
 * credentials only the business owner can obtain, the same constraint
 * as Mailgun. This is the practical, no-external-accounts-needed
 * alternative: a public, mobile-first web page a guest can open (via a
 * QR code) and "Add to Home Screen" on iOS/Android, which then behaves
 * like an app icon — the same UX pattern countless businesses use
 * instead of a native wallet pass.
 *
 * PUBLIC on purpose (no PermissionsGuard): a guest's phone has no staff
 * credentials. Safety comes from the customerId being an unguessable
 * UUID (same trust model as, e.g., an order-confirmation link) and from
 * exposing only non-sensitive info: first name and points balance.
 */
@Controller('pass')
export class PassController {
  constructor(private prisma: PrismaService) {}

  @Get(':orgId/:customerId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async getPass(@Param('orgId') orgId: string, @Param('customerId') customerId: string, @Res() res: Response) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId: orgId, deletedAt: null },
      include: { wallet: true, organization: true },
    });

    if (!customer) {
      res.status(404).send(this.renderNotFound());
      return;
    }

    const balance = customer.wallet ? Math.round(Number(customer.wallet.availableBalance)) : 0;
    const name = customer.firstName || 'Gast';
    const payload = JSON.stringify({ type: 'strand_tegoed_pass', customerId: customer.id });
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(payload)}`;

    res.status(200).send(this.renderPass(name, balance, qrUrl));
  }

  private renderPass(name: string, balance: number, qrUrl: string): string {
    return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Strand tegoed — ${this.escape(name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,450;9..144,600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --cream: #f6f3ec; --navy-dark: #0e1c2a; --white: #ffffff; --muted: rgba(240,244,247,0.6);
    --teal-light: #6496b5; --coral: #e8604a; --coral-light: #f08c78; --line: rgba(240,244,247,0.12);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: var(--cream); color: var(--white);
    font-family: 'Inter', sans-serif; display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 380px; background: var(--navy-dark);
    border-radius: 24px; padding: 32px 28px; text-align: center;
  }
  .brand { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); }
  .brand-logo { display: block; margin: 0 auto 4px; }
  .name { font-family: 'Fraunces', serif; font-size: 26px; margin: 6px 0 22px; }
  .balance-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  .balance { font-family: 'Fraunces', serif; font-size: 46px; color: var(--coral-light); margin: 4px 0 24px; }
  .qr-wrap { background: white; border-radius: 16px; padding: 14px; display: inline-block; }
  .qr-wrap img { display: block; width: 200px; height: 200px; }
  .hint {
    margin-top: 22px; font-size: 12px; color: var(--muted); line-height: 1.7;
    border-top: 1px solid var(--line); padding-top: 18px;
  }
  .hint strong { color: var(--teal-light); }
  .refresh-btn {
    margin-top: 18px; background: none; border: 1px solid var(--line); color: var(--muted);
    padding: 9px 18px; border-radius: 20px; font-size: 12px; cursor: pointer;
  }
</style>
</head>
<body>
  <div class="card">
    <img class="brand-logo" src="data:image/png;base64,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" alt="Zomers Beachclub &amp; Brewery / Het Strand" height="26">
    <div class="name">${this.escape(name)}</div>
    <div class="balance-label">Strand tegoed</div>
    <div class="balance">${balance} pt</div>
    <div class="qr-wrap"><img src="${qrUrl}" alt="Pas-QR"></div>
    <div class="hint">
      Laat deze code scannen bij de kassa.<br>
      <strong>Tip:</strong> zet deze pagina op je beginscherm (deel-knop → "Zet op beginscherm") zodat hij als een app werkt.
    </div>
    <button class="refresh-btn" onclick="location.reload()">Saldo vernieuwen</button>
  </div>
</body>
</html>`;
  }

  private renderNotFound(): string {
    return `<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pas niet gevonden</title>
    <style>body{background:#0e1c2a;color:#f0f4f7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px;}</style>
    </head><body><div>Deze pas kon niet worden gevonden.</div></body></html>`;
  }

  private escape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
