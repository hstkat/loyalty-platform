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
 * online-purchase flow (iDEAL etc.).
 *
 * BELANGRIJK — per-locatie/merk-routing: Het Strand en Zomers zijn TWEE
 * LOCATIES binnen ÉÉN Organization in dit platform (geen twee losse
 * organisaties — zie Location.mollieProfileId in schema.prisma). Elke
 * locatie/merk heeft een EIGEN Mollie-account, zodat een online
 * kadobon-betaling altijd op het juiste account van de eigenaar
 * terechtkomt, nooit per ongeluk op dat van het andere merk.
 *
 * De API-sleutel zelf staat BEWUST NOOIT in de database (niet
 * versleuteld opgeslagen mogelijk in dit platform) — alleen in
 * environment variables, per locatie-slug:
 *   MOLLIE_API_KEY__HET_STRAND — sleutel voor de locatie met slug "het-strand"
 *   MOLLIE_API_KEY__ZOMERS     — sleutel voor de locatie met slug "zomers"
 *   PUBLIC_APP_URL — this deployment's public base URL, used to build
 *                    the redirectUrl/webhookUrl Mollie needs to call us
 *                    back on
 *
 * Ontbreekt de sleutel voor een locatie, dan geeft elke methode hier een
 * DUIDELIJKE fout terug — er is bewust GEEN stille terugval naar een
 * "standaard" account (zie de aanroepende code in GiftCardsService).
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

  /**
   * Zet een locatie-slug (bijv. "het-strand") om naar de bijbehorende
   * environment-variable-naam (MOLLIE_API_KEY__HET_STRAND).
   */
  private envVarNameFor(locationSlug: string): string {
    const normalized = locationSlug.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    return `MOLLIE_API_KEY__${normalized}`;
  }

  private resolveApiKey(locationSlug: string): string | undefined {
    return process.env[this.envVarNameFor(locationSlug)];
  }

  isConfigured(locationSlug: string): boolean {
    return !!this.resolveApiKey(locationSlug);
  }

  async createPayment(
    locationSlug: string,
    params: {
      amount: number;
      description: string;
      redirectUrl: string;
      webhookUrl: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ created: true; payment: MolliePayment } | { created: false; reason: string }> {
    const apiKey = this.resolveApiKey(locationSlug);
    if (!apiKey) {
      const envVar = this.envVarNameFor(locationSlug);
      this.logger.error(`Geen Mollie-configuratie voor locatie "${locationSlug}" — ${envVar} ontbreekt.`);
      return { created: false, reason: `Online betalen is voor deze locatie nog niet ingesteld (${envVar} ontbreekt) — neem contact op met de zaak.` };
    }

    const res = await fetch(`${MOLLIE_API_BASE}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
      this.logger.error(`Mollie payment creation failed for location "${locationSlug}": ${res.status} ${errorText}`);
      return { created: false, reason: `Mollie-fout ${res.status}` };
    }

    const payment = (await res.json()) as MolliePayment;
    return { created: true, payment };
  }

  /**
   * Haalt de actuele status rechtstreeks bij Mollie op — dit is de
   * ENIGE bron van waarheid voor "is er echt betaald", nooit de
   * webhook-payload zelf (die bevat alleen een ID, geen status).
   *
   * `locationSlug` moet de locatie zijn die BIJ AANMAAK van deze
   * betaling is gebruikt (opgehaald via GiftCard.brandLocationId) —
   * elke Mollie-betaling bestaat maar op één account, dus de juiste
   * sleutel moet hier al bekend zijn, niet geraden.
   */
  async getPayment(locationSlug: string, paymentId: string): Promise<MolliePayment | null> {
    const apiKey = this.resolveApiKey(locationSlug);
    if (!apiKey) {
      this.logger.error(`Geen Mollie-configuratie voor locatie "${locationSlug}" bij opzoeken betaling ${paymentId}.`);
      return null;
    }
    const res = await fetch(`${MOLLIE_API_BASE}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      this.logger.error(`Mollie payment lookup failed for location "${locationSlug}": ${res.status}`);
      return null;
    }
    return (await res.json()) as MolliePayment;
  }

  /**
   * Terugbetaling — loopt ALTIJD via hetzelfde Mollie-account als de
   * oorspronkelijke betaling. `locationSlug` moet daarom komen van de
   * opgeslagen GiftCard.brandLocationId van de kaart in kwestie, nooit
   * van de "huidige" context van wie de terugbetaling aanvraagt.
   */
  async refundPayment(
    locationSlug: string,
    paymentId: string,
    amount: number,
    description?: string,
  ): Promise<{ refunded: true; refundId: string } | { refunded: false; reason: string }> {
    const apiKey = this.resolveApiKey(locationSlug);
    if (!apiKey) {
      const envVar = this.envVarNameFor(locationSlug);
      this.logger.error(`Geen Mollie-configuratie voor locatie "${locationSlug}" bij terugbetaling van ${paymentId} — ${envVar} ontbreekt.`);
      return { refunded: false, reason: `Terugbetalen kan niet — Mollie-configuratie voor deze locatie ontbreekt (${envVar}).` };
    }

    const res = await fetch(`${MOLLIE_API_BASE}/payments/${encodeURIComponent(paymentId)}/refunds`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: { currency: 'EUR', value: amount.toFixed(2) },
        description,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      this.logger.error(`Mollie refund failed for location "${locationSlug}", payment ${paymentId}: ${res.status} ${errorText}`);
      return { refunded: false, reason: `Mollie-fout bij terugbetaling: ${res.status}` };
    }

    const refund = (await res.json()) as { id: string };
    return { refunded: true, refundId: refund.id };
  }
}
