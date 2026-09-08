import { Controller, Get, Headers, UnauthorizedException } from '@nestjs/common';
import { WalletService } from './wallet.service';

/**
 * Endpoint getriggerd door Vercel Cron (zie vercel.json's "crons"-array)
 * — NIET achter de normale organizations/:orgId/... PermissionsGuard,
 * want een geplande taak heeft geen staff-sessie. Beveiligd met
 * hetzelfde gedeelde geheim als de andere cron-endpoints — Vercel
 * stuurt automatisch `Authorization: Bearer $CRON_SECRET` mee zodra
 * die environment variable gezet is.
 *
 * Doel: zet earn-tegoed dat gisteren (of eerder) is bijgeschreven van
 * "pending" naar "available" zodra de kalenderdag voorbij is — de
 * concrete uitvoering van de credit-regel "usableFromNextVisit"
 * (module 3 design doc, sectie 2 & 11). Draait 's ochtends vroeg, ruim
 * vóór openingstijd en vóór de andere ochtend-crons.
 */
@Controller('cron')
export class PendingCreditReleaseCronController {
  constructor(private wallet: WalletService) {}

  @Get('release-pending-credit')
  async run(@Headers('authorization') authHeader: string | undefined) {
    const secret = process.env.CRON_SECRET;
    if (secret && authHeader !== `Bearer ${secret}`) {
      throw new UnauthorizedException('Invalid or missing cron secret');
    }

    const { released } = await this.wallet.releasePendingCredit();
    return { released };
  }
}
