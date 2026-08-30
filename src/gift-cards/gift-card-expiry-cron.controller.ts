import { Controller, Get, Headers, UnauthorizedException } from '@nestjs/common';
import { GiftCardsService } from './gift-cards.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Endpoint getriggerd door Vercel Cron (zie vercel.json's "crons"-array)
 * — zelfde beveiligingspatroon als voucher-reminder-cron.controller.ts:
 * gedeeld CRON_SECRET, geen staff-sessie nodig/mogelijk voor een
 * geplande taak.
 */
@Controller('cron')
export class GiftCardExpiryCronController {
  constructor(
    private giftCards: GiftCardsService,
    private prisma: PrismaService,
  ) {}

  @Get('gift-card-expiry')
  async run(@Headers('authorization') authHeader: string | undefined) {
    const secret = process.env.CRON_SECRET;
    if (secret && authHeader !== `Bearer ${secret}`) {
      throw new UnauthorizedException('Invalid or missing cron secret');
    }

    const orgs = await this.prisma.organization.findMany({ select: { id: true } });
    let totalExpired = 0;
    let totalValue = 0;
    for (const org of orgs) {
      const { expiredCount, expiredValue } = await this.giftCards.processExpiredGiftCards(org.id);
      totalExpired += expiredCount;
      totalValue += expiredValue;
    }
    return { organizationsChecked: orgs.length, expiredCount: totalExpired, expiredValue: totalValue };
  }
}
