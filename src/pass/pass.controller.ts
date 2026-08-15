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
    --dark: #0e1c2a; --amber: #1b3a5c; --sand: #f0f4f7; --text-light: #7a8ea0;
    --teal-light: #6496b5; --coral: #e8604a; --wood: #c47a45; --line: rgba(240,244,247,0.1);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: var(--dark); color: var(--sand);
    font-family: 'Inter', sans-serif; display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 380px; background: var(--amber); border: 1px solid var(--line);
    border-radius: 24px; padding: 32px 28px; text-align: center;
  }
  .brand { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-light); }
  .name { font-family: 'Fraunces', serif; font-size: 26px; margin: 6px 0 22px; }
  .balance-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-light); }
  .balance { font-family: 'Fraunces', serif; font-size: 46px; color: var(--coral); margin: 4px 0 24px; }
  .qr-wrap { background: white; border-radius: 16px; padding: 14px; display: inline-block; }
  .qr-wrap img { display: block; width: 200px; height: 200px; }
  .hint {
    margin-top: 22px; font-size: 12px; color: var(--text-light); line-height: 1.7;
    border-top: 1px solid var(--line); padding-top: 18px;
  }
  .hint strong { color: var(--teal-light); }
  .refresh-btn {
    margin-top: 18px; background: none; border: 1px solid var(--line); color: var(--text-light);
    padding: 9px 18px; border-radius: 20px; font-size: 12px; cursor: pointer;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">Het Strand &amp; Zomers</div>
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
