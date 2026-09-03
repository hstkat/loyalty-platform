import { Injectable, Logger } from '@nestjs/common';

/**
 * Real email delivery via Mailgun's HTTP API — the first real (non-
 * simulated) send path on the platform. Module 6's MessagingService
 * remains simulated for push/wallet/sms; this is a separate, narrow
 * integration specifically for the daily accounting report, since that's
 * the first genuine business need for actual email delivery.
 *
 * Configured via environment variables (set in Vercel project settings,
 * never committed to the repo):
 *   MAILGUN_API_KEY   — Mailgun private API key (or a domain sending key)
 *   MAILGUN_DOMAIN    — the sending domain configured in Mailgun (e.g. mg.het-strand.nl)
 *   MAILGUN_REGION    — 'eu' or 'us'. Mailgun's EU and US instances are
 *                       separate systems with separate API hosts — a
 *                       domain created under the EU account (dashboard
 *                       URL contains app.eu.mailgun.com) MUST be called
 *                       via api.eu.mailgun.net, or every send fails with
 *                       an auth/not-found error despite a correct key.
 *                       Defaults to 'eu' since that's this organization's
 *                       account; override with MAILGUN_REGION=us if a
 *                       US-region domain is used instead.
 *   MAILGUN_FROM      — optional, defaults to "Strand tegoed <noreply@{domain}>"
 */
@Injectable()
export class MailgunService {
  private readonly logger = new Logger(MailgunService.name);

  isConfigured(): boolean {
    return !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN);
  }

  private getApiHost(): string {
    const region = (process.env.MAILGUN_REGION || 'eu').toLowerCase();
    return region === 'us' ? 'api.mailgun.net' : 'api.eu.mailgun.net';
  }

  async sendEmail(to: string, subject: string, textBody: string, htmlBody?: string): Promise<{ sent: boolean; reason?: string }> {
    const apiKey = process.env.MAILGUN_API_KEY;
    const domain = process.env.MAILGUN_DOMAIN;

    if (!apiKey || !domain) {
      this.logger.warn('Mailgun not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN missing) — email not sent');
      return { sent: false, reason: 'Mailgun is niet geconfigureerd (ontbrekende environment variables)' };
    }

    const from = process.env.MAILGUN_FROM || `Strand tegoed <noreply@${domain}>`;

    const form = new URLSearchParams();
    form.set('from', from);
    form.set('to', to);
    form.set('subject', subject);
    form.set('text', textBody);
    if (htmlBody) form.set('html', htmlBody);

    const auth = Buffer.from(`api:${apiKey}`).toString('base64');

    const res = await fetch(`https://${this.getApiHost()}/v3/${domain}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      this.logger.error(`Mailgun send failed: ${res.status} ${errorText}`);
      return { sent: false, reason: `Mailgun-fout ${res.status}: ${errorText}` };
    }

    return { sent: true };
  }
}
