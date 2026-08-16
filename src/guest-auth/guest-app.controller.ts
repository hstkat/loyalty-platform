import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { GuestAuthService } from './guest-auth.service';
import { GuestSessionGuard } from './guest-session.guard';
import { PrismaService } from '../prisma/prisma.service';

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
  ) {}

  @Post('auth/request-code')
  requestCode(@Param('orgId') orgId: string, @Body() dto: RequestCodeDto) {
    return this.guestAuth.requestCode(orgId, dto.email);
  }

  @Post('auth/verify-code')
  verifyCode(@Param('orgId') orgId: string, @Body() dto: VerifyCodeDto) {
    return this.guestAuth.verifyCode(orgId, dto.email, dto.code, dto.deviceInfo);
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
    return {
      id: customer!.id,
      firstName: customer!.firstName,
      lastName: customer!.lastName,
      tier: customer!.tier?.name ?? null,
      balance: customer!.wallet ? Math.round(Number(customer!.wallet.availableBalance)) : 0,
      lifetimeEarned: customer!.wallet ? Math.round(Number(customer!.wallet.lifetimeEarned)) : 0,
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

  @Get('rewards')
  @UseGuards(GuestSessionGuard)
  async getAvailableRewards(@Param('orgId') orgId: string) {
    const items = await this.prisma.rewardCatalogItem.findMany({
      where: { organizationId: orgId, isActive: true },
      orderBy: { pointsCost: 'asc' },
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
}
