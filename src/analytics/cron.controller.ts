import { Controller, Get, Headers, Query, UnauthorizedException } from '@nestjs/common';
import { DailyClosingService } from './daily-closing.service';

/**
 * Endpoint triggered by Vercel Cron (see vercel.json's "crons" array) —
 * NOT behind the normal organizations/:orgId/... PermissionsGuard, since
 * a scheduled job has no user session or org-scoped headers. Protected
 * instead by a shared secret: when the CRON_SECRET environment variable
 * is set, Vercel automatically sends `Authorization: Bearer $CRON_SECRET`
 * with every cron-triggered request — this is Vercel's own convention,
 * not something invented here.
 */
@Controller('cron')
export class CronController {
  constructor(private dailyClosing: DailyClosingService) {}

  @Get('daily-closing')
  async runDailyClosing(@Headers('authorization') authHeader: string | undefined, @Query('orgId') orgIdOverride?: string) {
    const secret = process.env.CRON_SECRET;
    if (secret && authHeader !== `Bearer ${secret}`) {
      throw new UnauthorizedException('Invalid or missing cron secret');
    }

    const orgId = orgIdOverride || process.env.DEFAULT_ORGANIZATION_ID;
    if (!orgId) {
      return { sent: false, reason: 'Geen organizatie geconfigureerd (DEFAULT_ORGANIZATION_ID ontbreekt)' };
    }

    // A cron running early in the morning closes out YESTERDAY, not today
    // (today's transactions are still coming in).
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const date = yesterday.toISOString().slice(0, 10);

    return this.dailyClosing.sendDailyClosingEmail(orgId, date);
  }
}
