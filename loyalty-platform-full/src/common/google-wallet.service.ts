import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const WALLET_API_BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';
const WALLET_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export interface LoyaltyCardData {
  serialNumber: string; // WalletPass.serialNumber — het veilige, willekeurige token; NOOIT een database-ID
  firstName: string;
  tierName: string | null;
  balance: number; // Beach Credit — apart getoond van punten, nooit samengevoegd
  points: number;
}

/**
 * Echte Google Wallet-koppeling voor de digitale loyaltykaart.
 *
 * Configuratie (Vercel-omgevingsvariabelen, nooit committen):
 *   GOOGLE_WALLET_ISSUER_ID          — te vinden in de Google Wallet Business Console
 *   GOOGLE_WALLET_SERVICE_ACCOUNT_KEY — de VOLLEDIGE inhoud van het JSON-sleutelbestand
 *                                       van een Google Cloud service-account met de
 *                                       "Wallet Object Issuer"-rol, als één regel string
 *
 * Werking (twee losse stappen, vaak door elkaar gehaald):
 *  1. REST-aanroepen naar walletobjects.googleapis.com (klasse/object aanmaken of
 *     bijwerken) — vereisen een OAuth2-toegangstoken, verkregen door een JWT te
 *     ondertekenen met het service-account en die te wisselen bij Google's
 *     token-endpoint. Dit gebeurt bij elke serverside wijziging (bijv. na een
 *     nieuwe transactie).
 *  2. De "Voeg toe aan Google Wallet"-link zelf — een APARTE, kortere JWT
 *     ("savetowallet"), die de gast in de browser aanklikt. Google leest die
 *     zelf uit; hier is geen los toegangstoken voor nodig.
 *
 * QR-beveiliging: het barcode-veld bevat uitsluitend WalletPass.serialNumber
 * (een 96-bits willekeurige token, hetzelfde principe als de fysieke
 * loyaltykaarten) — nooit een gast-ID, saldo of naam. Een gefotografeerde
 * QR-code geeft dus nooit meer dan identificatie; alle actuele gegevens
 * (saldo, tier) worden altijd server-side opgehaald bij het scannen.
 */
@Injectable()
export class GoogleWalletService {
  private readonly logger = new Logger(GoogleWalletService.name);
  private cachedAccessToken: { token: string; expiresAt: number } | null = null;

  private get issuerId(): string | undefined {
    return process.env.GOOGLE_WALLET_ISSUER_ID;
  }

  private get serviceAccount(): ServiceAccountKey | null {
    const raw = process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ServiceAccountKey;
    } catch {
      this.logger.error('GOOGLE_WALLET_SERVICE_ACCOUNT_KEY is geen geldige JSON');
      return null;
    }
  }

  isConfigured(): boolean {
    return !!this.issuerId && !!this.serviceAccount;
  }

  private classId(organizationSlug: string): string {
    return `${this.issuerId}.${organizationSlug}_loyalty`;
  }

  private objectId(serialNumber: string): string {
    // Google staat alleen [A-Za-z0-9_.-] toe in het object-ID-achtervoegsel.
    const safeSuffix = serialNumber.replace(/[^A-Za-z0-9_.-]/g, '');
    return `${this.issuerId}.${safeSuffix}`;
  }

  /** OAuth2-toegangstoken voor de REST-API, kortstondig gecachet (Google's tokens gelden 1 uur). */
  private async getAccessToken(): Promise<string | null> {
    const account = this.serviceAccount;
    if (!account) return null;

    if (this.cachedAccessToken && this.cachedAccessToken.expiresAt > Date.now() + 60_000) {
      return this.cachedAccessToken.token;
    }

    const assertion = jwt.sign(
      { scope: WALLET_SCOPE, aud: GOOGLE_TOKEN_URL },
      account.private_key,
      { algorithm: 'RS256', issuer: account.client_email, expiresIn: '1h' },
    );

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });

    if (!res.ok) {
      this.logger.error(`Google OAuth-token ophalen mislukt: ${res.status} ${await res.text().catch(() => '')}`);
      return null;
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedAccessToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  /**
   * Maakt de gedeelde "klasse" (sjabloon: logo, kleuren, programmanaam) aan
   * — één keer per organisatie, idempotent (bestaat hij al, dan negeren we
   * de 409-fout van Google gewoon).
   */
  async ensureLoyaltyClass(organizationSlug: string, organizationName: string): Promise<boolean> {
    const token = await this.getAccessToken();
    if (!token) return false;

    const res = await fetch(`${WALLET_API_BASE}/loyaltyClass`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: this.classId(organizationSlug),
        issuerName: organizationName,
        programName: `${organizationName} Loyalty`,
        reviewStatus: 'UNDER_REVIEW',
        hexBackgroundColor: '#0e1c2a',
      }),
    });

    // 409 = bestaat al, dat is prima — alle andere fouten wél loggen.
    if (!res.ok && res.status !== 409) {
      this.logger.error(`Google Wallet-klasse aanmaken mislukt: ${res.status} ${await res.text().catch(() => '')}`);
      return false;
    }
    return true;
  }

  /**
   * Maakt of werkt het per-gast "object" bij — de daadwerkelijke pasgegevens.
   * Wordt aangeroepen bij het eerste keer toevoegen én bij elke latere
   * saldowijziging (zie de aanroep vanuit WalletService).
   */
  async upsertLoyaltyObject(organizationSlug: string, data: LoyaltyCardData): Promise<boolean> {
    const token = await this.getAccessToken();
    if (!token) return false;

    const objectBody = {
      id: this.objectId(data.serialNumber),
      classId: this.classId(organizationSlug),
      state: 'ACTIVE',
      accountName: data.firstName,
      accountId: data.serialNumber,
      loyaltyPoints: {
        label: 'Punten',
        balance: { int: Math.round(data.points) },
      },
      secondaryLoyaltyPoints: {
        label: 'Beach Credit',
        balance: { string: `€${data.balance.toFixed(2)}` },
      },
      textModulesData: data.tierName ? [{ header: 'Status', body: data.tierName, id: 'tier' }] : [],
      barcode: {
        type: 'QR_CODE',
        // Uitsluitend het veilige, willekeurige token — zie klassecommentaar.
        value: data.serialNumber,
        alternateText: '',
      },
    };

    let res = await fetch(`${WALLET_API_BASE}/loyaltyObject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(objectBody),
    });

    if (res.status === 409) {
      // Bestaat al — bijwerken in plaats van aanmaken.
      res = await fetch(`${WALLET_API_BASE}/loyaltyObject/${encodeURIComponent(this.objectId(data.serialNumber))}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(objectBody),
      });
    }

    if (!res.ok) {
      this.logger.error(`Google Wallet-object bijwerken mislukt: ${res.status} ${await res.text().catch(() => '')}`);
      return false;
    }
    return true;
  }

  /**
   * De daadwerkelijke "Voeg toe aan Google Wallet"-link — een korte,
   * losstaande JWT die alleen verwijst naar het al aangemaakte object
   * (geen los toegangstoken nodig, dit leest Google zelf uit de link).
   */
  buildSaveLink(organizationSlug: string, serialNumber: string): string | null {
    const account = this.serviceAccount;
    if (!account) return null;

    const claims = {
      iss: account.client_email,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      payload: {
        loyaltyObjects: [{ id: this.objectId(serialNumber), classId: this.classId(organizationSlug) }],
      },
    };

    const token = jwt.sign(claims, account.private_key, { algorithm: 'RS256' });
    return `https://pay.google.com/gp/v/save/${token}`;
  }
}
