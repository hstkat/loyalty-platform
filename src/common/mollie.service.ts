import { Injectable, Logger } from '@nestjs/common';

const MOLLIE_API_BASE = 'https://api.mollie.com/v2';

export interface MolliePayment {
  id: string;
  status: 'open' | 'canceled' | 'pending' | 'authorized' | 'expired' | 'failed' | 'paid';
  amount: { currency: string; value: string };
  metadata: Record<string, unknown> | null;
  _links: { checkout?: { href: string } };
}

/**
 * Real online payments via Mollie — used specifically for the gift-card
 * online-purchase flow (iDEAL etc.). Configured via environment
 * variables (Vercel project settings, never committed):
 *   MOLLIE_API_KEY — a live_ or test_ key from the Mollie dashboard
 *   PUBLIC_APP_URL — this deployment's public base URL, used to build
 *                    the redirectUrl/webhookUrl Mollie needs to call us
 *                    back on
 *
 * CRITICAL SECURITY RULE (per Mollie's own webhook design): the webhook
 * Mollie calls contains ONLY a payment id, never a trustworthy status —
 * anyone could POST a fake id to that same URL. The only safe way to
 * know a payment is genuinely paid is to fetch it fresh FROM Mollie's
 * API using our own API key, every single time, and never activate a
 * gift card based on anything else. See GiftCardsService.confirmMolliePayment.
 */
@Injectable()
export class MollieService {
  private readonly logger = new Logger(MollieService.name);

  private get apiKey(): string | undefined {
    return process.env.MOLLIE_API_KEY;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async createPayment(params: {
    amount: number;
    description: string;
    redirectUrl: string;
    webhookUrl: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ created: true; payment: MolliePayment } | { created: false; reason: string }> {
    if (!this.apiKey) {
      return { created: false, reason: 'Mollie is niet geconfigureerd (MOLLIE_API_KEY ontbreekt)' };
    }

    const res = await fetch(`${MOLLIE_API_BASE}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: { currency: 'EUR', value: params.amount.toFixed(2) },
        description: params.description,
        redirectUrl: params.redirectUrl,
        webhookUrl: params.webhookUrl,
        metadata: params.metadata,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      this.logger.error(`Mollie payment creation failed: ${res.status} ${errorText}`);
      return { created: false, reason: `Mollie-fout ${res.status}` };
    }

    const payment = (await res.json()) as MolliePayment;
    return { created: true, payment };
  }

  /**
   * Haalt de actuele status rechtstreeks bij Mollie op — dit is de
   * ENIGE bron van waarheid voor "is er echt betaald", nooit de
   * webhook-payload zelf (die bevat alleen een ID, geen status).
   */
  async getPayment(paymentId: string): Promise<MolliePayment | null> {
    if (!this.apiKey) return null;
    const res = await fetch(`${MOLLIE_API_BASE}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      this.logger.error(`Mollie payment lookup failed: ${res.status}`);
      return null;
    }
    return (await res.json()) as MolliePayment;
  }
}
