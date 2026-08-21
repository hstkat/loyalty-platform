import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { createHash, randomBytes } from 'crypto';
import { GuestAuthService } from './guest-auth.service';
import { GuestSessionGuard } from './guest-session.guard';
import { PrismaService } from '../prisma/prisma.service';
import { WalletPassService } from '../wallet/wallet-pass.service';
import { LoyaltyCardsService } from '../loyalty-cards/loyalty-cards.service';
import { MailgunService } from '../common/mailgun.service';

class RequestCodeDto {
  @IsEmail()
  email!: string;
}

class VerifyCodeDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  @IsOptional()
  @IsString()
  deviceInfo?: string;
}

class RegisterCustomerDto {
  @IsString()
  firstName!: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  dateOfBirth?: string;

  @IsOptional()
  marketingConsent?: boolean;

  @IsString()
  verifiedRegistrationId!: string;

  @IsOptional()
  @IsString()
  deviceInfo?: string;
}

class RegisterPushTokenDto {
  @IsString()
  expoPushToken!: string;

  @IsOptional()
  @IsString()
  deviceInfo?: string;
}

/**
 * The guest-app API surface: public login endpoints (no guard — a guest
 * has no token yet when logging in) plus authenticated "my profile"
 * endpoints (behind GuestSessionGuard, scoped to whichever customer the
 * bearer token resolves to — never to an arbitrary customerId the app
 * might pass, unlike the internal backoffice endpoints).
 */
@Controller('guest-app/organizations/:orgId')
export class GuestAppController {
  constructor(
    private guestAuth: GuestAuthService,
    private prisma: PrismaService,
    private walletPass: WalletPassService,
    private loyaltyCards: LoyaltyCardsService,
    private mailgun: MailgunService,
  ) {}

  @Post('auth/request-code')
  requestCode(@Param('orgId') orgId: string, @Body() dto: RequestCodeDto) {
    return this.guestAuth.requestCode(orgId, dto.email);
  }

  @Post('auth/verify-code')
  verifyCode(@Param('orgId') orgId: string, @Body() dto: VerifyCodeDto) {
    return this.guestAuth.verifyCode(orgId, dto.email, dto.code, dto.deviceInfo);
  }

  @Post('auth/complete-registration')
  completeRegistration(@Param('orgId') orgId: string, @Body() dto: RegisterCustomerDto) {
    return this.guestAuth.completeRegistration(
      orgId,
      dto.verifiedRegistrationId,
      { firstName: dto.firstName, lastName: dto.lastName, email: dto.email, phone: dto.phone, dateOfBirth: dto.dateOfBirth, marketingConsent: dto.marketingConsent },
      dto.deviceInfo,
    );
  }

  @Post('auth/logout')
  @UseGuards(GuestSessionGuard)
  logout(@Req() req: { headers: { authorization?: string } }) {
    const token = req.headers.authorization!.slice(7);
    return this.guestAuth.logout(token);
  }

  @Get('me')
  @UseGuards(GuestSessionGuard)
  async getMe(@Req() req: { guestCustomer: { id: string; organizationId: string } }) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: req.guestCustomer.id },
      include: { wallet: true, tier: true },
    });

    // Eerstvolgend vervallend tegoed — voor "Tegoed verloopt: 12 oktober"
    // op zowel de Wallet-kaart als het portaal. Puntensaldo en
    // vervaldata komen altijd uit de bestaande ledger, nooit een apart
    // veld — dit is puur een leesquery erbovenop.
    const soonestExpiring = customer!.wallet
      ? await this.prisma.walletLedgerEntry.findFirst({
          where: { walletId: customer!.wallet.id, status: 'available', expiresAt: { not: null, gte: new Date() }, remainingAmount: { gt: 0 } },
          orderBy: { expiresAt: 'asc' },
          select: { expiresAt: true, remainingAmount: true },
        })
      : null;

    return {
      id: customer!.id,
      firstName: customer!.firstName,
      lastName: customer!.lastName,
      tier: customer!.tier?.name ?? null,
      // Bewust NIET afgerond naar hele euro's (was een bestaande bug —
      // €18,40 werd getoond als "18") — twee decimalen, exact zoals de
      // ledger het vastlegt.
      balance: customer!.wallet ? Number(customer!.wallet.availableBalance) : 0,
      pendingBalance: customer!.wallet ? Number(customer!.wallet.pendingBalance) : 0,
      lifetimeEarned: customer!.wallet ? Number(customer!.wallet.lifetimeEarned) : 0,
      expiringSoon: soonestExpiring
        ? { amount: Number(soonestExpiring.remainingAmount), expiresAt: soonestExpiring.expiresAt }
        : null,
    };
  }

  @Get('me/ledger')
  @UseGuards(GuestSessionGuard)
  async getMyLedger(@Req() req: { guestCustomer: { id: string } }) {
    const wallet = await this.prisma.wallet.findUnique({ where: { customerId: req.guestCustomer.id } });
    if (!wallet) return [];
    return this.prisma.walletLedgerEntry.findMany({
      where: { walletId: wallet.id },
      orderBy: { occurredAt: 'desc' },
      take: 30,
      select: { entryType: true, amount: true, occurredAt: true, reason: true },
    });
  }

  // -- Cadeaukaarten van deze klant — bewust een apart endpoint, apart
  // saldo, nooit samengevoegd met het loyaltytegoed hierboven. --------

  @Get('me/wallet-pass/google')
  @UseGuards(GuestSessionGuard)
  async getGoogleWalletLink(@Param('orgId') orgId: string, @Req() req: { guestCustomer: { id: string } }) {
    return this.walletPass.getOrCreateGoogleWalletLink(orgId, req.guestCustomer.id);
  }

  @Get('me/gift-cards')
  @UseGuards(GuestSessionGuard)
  async getMyGiftCards(@Req() req: { guestCustomer: { id: string } }) {
    const cards = await this.prisma.giftCard.findMany({
      where: {
        recipientCustomerId: req.guestCustomer.id,
        status: { in: ['active', 'partially_redeemed'] },
      },
      orderBy: { issuedAt: 'desc' },
      select: { id: true, giftCardNumber: true, currentBalance: true, originalValue: true, issuedAt: true, expiresAt: true },
    });
    return cards.map((c) => ({
      id: c.id,
      // Gemaskeerd kaartnummer — "GC-000123" -> "GC-••••23", zelfde
      // gedachte als een gemaskeerd betaalkaartnummer.
      maskedNumber: c.giftCardNumber.replace(/^(GC-)(\d+)$/, (_m, prefix: string, digits: string) => prefix + '••••' + digits.slice(-2)),
      currentBalance: Number(c.currentBalance),
      originalValue: Number(c.originalValue),
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
    }));
  }

  // -- Eén samengevoegde tijdlijn voor de UI — puur een leesweergave die
  // bestaande, gescheiden ledgers naast elkaar toont. De bedragen zelf
  // blijven te allen tijde herleidbaar naar hun eigen bron; er wordt
  // nergens een gecombineerd saldo berekend of opgeslagen. -----------

  @Get('me/activity')
  @UseGuards(GuestSessionGuard)
  async getMyActivity(@Req() req: { guestCustomer: { id: string } }) {
    const wallet = await this.prisma.wallet.findUnique({ where: { customerId: req.guestCustomer.id } });

    const [walletEntries, giftCardEntries] = await Promise.all([
      wallet
        ? this.prisma.walletLedgerEntry.findMany({
            where: { walletId: wallet.id },
            orderBy: { occurredAt: 'desc' },
            take: 20,
            select: { entryType: true, amount: true, occurredAt: true, reason: true },
          })
        : Promise.resolve([]),
      this.prisma.giftCardLedgerEntry.findMany({
        where: { giftCard: { recipientCustomerId: req.guestCustomer.id } },
        orderBy: { occurredAt: 'desc' },
        take: 20,
        select: { entryType: true, amount: true, occurredAt: true, reason: true, giftCard: { select: { giftCardNumber: true } } },
      }),
    ]);

    const combined = [
      ...walletEntries.map((e) => ({ source: 'loyalty' as const, type: e.entryType, amount: Number(e.amount), occurredAt: e.occurredAt, reason: e.reason })),
      ...giftCardEntries.map((e) => ({
        source: 'gift_card' as const,
        type: e.entryType,
        amount: Number(e.amount),
        occurredAt: e.occurredAt,
        reason: e.reason,
        giftCardNumber: e.giftCard.giftCardNumber,
      })),
    ];
    combined.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    return combined.slice(0, 30);
  }

  // -- Portal-QR: een kortlevend, apart token (nooit het bestaande
  // fysieke-kaart-systeem hergebruikt — dat token kan na aanmaken nooit
  // opnieuw getoond worden, een portal-QR moet dat juist elke sessie
  // wel kunnen). Alleen identificatie, geen accountsessie: een
  // gefotografeerde QR geeft dus nooit toegang tot dit account. --------

  @Get('me/qr-token')
  @UseGuards(GuestSessionGuard)
  async getMyQrToken(@Req() req: { guestCustomer: { id: string } }) {
    const token = randomBytes(16).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.prisma.customerQrToken.create({
      data: { customerId: req.guestCustomer.id, tokenHash, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    return { token, expiresInHours: 24 };
  }

  /**
   * "E-mail mijn QR om te printen" — gebruikt bewust NIET het
   * kortlevende portal-QR-token hierboven (dat verloopt na 24 uur, dus
   * onbruikbaar voor iets wat op papier in een portemonnee belandt).
   * In plaats daarvan wordt een echte, nooit-verlopende fysieke-
   * loyaltykaart uitgegeven — hetzelfde, al bewezen systeem als de
   * vooraf gedrukte kaarten, alleen nu direct aan de al-ingelogde klant.
   */
  @Post('me/email-qr-card')
  @UseGuards(GuestSessionGuard)
  async emailQrCard(@Param('orgId') orgId: string, @Req() req: { guestCustomer: { id: string; firstName: string | null; email: string | null } }) {
    if (!req.guestCustomer.email) {
      return { sent: false, reason: 'Geen e-mailadres bekend op dit account' };
    }

    const card = await this.loyaltyCards.issueDirectToCustomer(orgId, req.guestCustomer.id);
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(card.token)}`;
    const greeting = req.guestCustomer.firstName ? `Beste ${req.guestCustomer.firstName},` : 'Beste,';

    if (this.mailgun.isConfigured()) {
      await this.mailgun.sendEmail(
        req.guestCustomer.email,
        'Je loyaltykaart om te printen',
        `${greeting}\n\nHierbij je persoonlijke loyaltykaart (kaartnummer ${card.cardNumber}). Print deze e-mail uit of bewaar de QR-code op je telefoon — laat 'm scannen bij de kassa.`,
        `<p>${greeting}</p><p>Hierbij je persoonlijke loyaltykaart.</p><p style="text-align:center;"><img src="${qrImageUrl}" alt="Loyaltykaart QR" width="240" height="240"></p><p style="text-align:center;color:#7a8ea0;font-size:13px;">Kaartnummer ${card.cardNumber}</p><p>Print deze e-mail uit of bewaar de QR-code op je telefoon — laat 'm scannen bij de kassa.</p>`,
      );
    }

    return { sent: this.mailgun.isConfigured(), cardNumber: card.cardNumber };
  }

  @Get('rewards')
  @UseGuards(GuestSessionGuard)
  async getAvailableRewards(@Param('orgId') orgId: string) {
    const items = await this.prisma.rewardCatalogItem.findMany({
      where: { organizationId: orgId, isActive: true },
      orderBy: { pointsCost: 'asc' },
      include: { location: { select: { name: true, slug: true } } },
    });
    // Reuses the same day/date availability rule as the kassa —
    // duplicated here in a minimal form since RewardCatalogService's
    // check is private; a shared exported helper would be a reasonable
    // follow-up cleanup once this app is in real use.
    const now = new Date();
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getUTCDay()];
    return items.filter((item) => {
      if (item.validFrom && now < item.validFrom) return false;
      if (item.validUntil) {
        const end = new Date(item.validUntil);
        end.setUTCHours(23, 59, 59, 999);
        if (now > end) return false;
      }
      if (item.availableDays && (item.availableDays as string[]).length > 0) {
        if (!(item.availableDays as string[]).includes(weekday)) return false;
      }
      return true;
    });
  }

  // Publiek (geen sessietoken nodig) — puur informatief, geen persoonlijke
  // data: hoeveel korting een gast krijgt voor een inwisselblok, per dag.
  // De inlogpagina zelf toont dit ook al aan potentiële gasten, dus dit
  // hoeft niet achter authenticatie te zitten.
  @Get('redemption-rates')
  async getRedemptionRates(@Param('orgId') orgId: string) {
    const [rules, creditRule] = await Promise.all([
      this.prisma.redemptionRateRule.findMany({ where: { organizationId: orgId, isActive: true } }),
      this.prisma.creditRule.findFirst({ where: { organizationId: orgId, isActive: true } }),
    ]);
    const blockSize = creditRule?.redemptionBlockSize ?? null;

    return rules.map((rule) => ({
      name: rule.name,
      appliesOnDays: rule.appliesOnDays,
      pointsPerEuro: Number(rule.pointsPerEuro),
      blockSize,
      blockEuroValue: blockSize ? Math.round((blockSize / Number(rule.pointsPerEuro)) * 100) / 100 : null,
    }));
  }

  @Post('me/push-token')
  @UseGuards(GuestSessionGuard)
  async registerPushToken(
    @Req() req: { guestCustomer: { id: string } },
    @Body() dto: RegisterPushTokenDto,
  ) {
    // Upsert on the token itself (unique) rather than on customer+token,
    // so if a guest logs in on a NEW phone, the token that phone reports
    // gets reassigned to them — a stale token from a previous owner
    // (e.g. a second-hand phone) never silently keeps receiving someone
    // else's messages.
    await this.prisma.guestPushToken.upsert({
      where: { expoPushToken: dto.expoPushToken },
      create: {
        customerId: req.guestCustomer.id,
        expoPushToken: dto.expoPushToken,
        deviceInfo: dto.deviceInfo,
      },
      update: {
        customerId: req.guestCustomer.id,
        deviceInfo: dto.deviceInfo,
      },
    });
    return { registered: true };
  }
}
