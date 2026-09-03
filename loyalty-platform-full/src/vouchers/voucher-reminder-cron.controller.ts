import { Controller, Get, Headers, UnauthorizedException } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Endpoint getriggerd door Vercel Cron (zie vercel.json's "crons"-array)
 * — NIET achter de normale organizations/:orgId/... PermissionsGuard,
 * want een geplande taak heeft geen staff-sessie. Beveiligd met
 * hetzelfde gedeelde geheim als de bestaande cron/daily-closing
 * (CronController in analytics-module) — Vercel stuurt automatisch
 * `Authorization: Bearer $CRON_SECRET` mee zodra die environment
 * variable gezet is, dat is Vercels eigen conventie, niets zelf
 * verzonnen. Losstaand gehouden van CronController (i.p.v. daarin
 * geplakt) om vouchers/analytics module-onafhankelijk te houden.
 */
@Controller('cron')
export class VoucherReminderCronController {
  constructor(
    private vouchers: VouchersService,
    private prisma: PrismaService,
  ) {}

  @Get('voucher-expiry-reminders')
  async run(@Headers('authorization') authHeader: string | undefined) {
    const secret = process.env.CRON_SECRET;
    if (secret && authHeader !== `Bearer ${secret}`) {
      throw new UnauthorizedException('Invalid or missing cron secret');
    }

    const orgs = await this.prisma.organization.findMany({ select: { id: true } });
    let totalSent = 0;
    for (const org of orgs) {
      const { remindersSent } = await this.vouchers.sendExpiryReminders(org.id);
      totalSent += remindersSent;
    }
    return { organizationsChecked: orgs.length, remindersSent: totalSent };
  }
}
