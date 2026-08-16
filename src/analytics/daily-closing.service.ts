import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { MailgunService } from '../common/mailgun.service';

@Injectable()
export class DailyClosingService {
  private readonly logger = new Logger(DailyClosingService.name);

  constructor(
    private analytics: AnalyticsService,
    private mailgun: MailgunService,
  ) {}

  async sendDailyClosingEmail(orgId: string, date: string, recipientOverride?: string) {
    const closing = await this.analytics.getDailyClosing(orgId, date);
    const recipient = recipientOverride || process.env.ACCOUNTING_EMAIL;

    if (!recipient) {
      return { sent: false, reason: 'Geen ontvanger geconfigureerd (ACCOUNTING_EMAIL ontbreekt)', closing };
    }

    const subject = `Dagafsluiting Strand tegoed — ${closing.date} (${closing.dayName})`;
    const textBody = this.buildTextReport(closing);

    const result = await this.mailgun.sendEmail(recipient, subject, textBody);
    if (!result.sent) {
      this.logger.warn(`Daily closing email not sent for ${orgId} / ${date}: ${result.reason}`);
    }

    return { ...result, closing, recipient };
  }

  buildTextReport(closing: Awaited<ReturnType<AnalyticsService['getDailyClosing']>>): string {
    return [
      `Dagafsluiting — ${closing.date} (${closing.dayName})`,
      ``,
      `Aantal transacties:        ${closing.transactionCount}`,
      `Omzet:                     €${closing.grossRevenue.toFixed(2)}`,
      ``,
      `Punten gespaard vandaag:   ${closing.pointsIssued} pt`,
      `Punten ingewisseld:        ${closing.pointsRedeemed} pt  (≈ €${closing.redeemedEuroValue.toFixed(2)} bij koers ${closing.pointsPerEuroThatDay} pt/€ van vandaag)`,
      `Waarvan cadeaus:           ${closing.catalogGiftsCount}x, totale kostprijs €${closing.catalogGiftsValue.toFixed(2)}`,
      `Punten verlopen:           ${closing.pointsExpired} pt`,
      ``,
      `Dit is een automatisch gegenereerd overzicht van Het Strand & Zomers — Strand tegoed platform.`,
    ].join('\n');
  }
}
