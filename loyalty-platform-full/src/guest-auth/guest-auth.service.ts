import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { MailgunService } from '../common/mailgun.service';
import { GiftCardsService } from '../gift-cards/gift-cards.service';

const CODE_TTL_MINUTES = 10;
const SESSION_TTL_DAYS = 90;
const MAX_CODE_ATTEMPTS = 5;
const MAX_PASSWORD_ATTEMPTS = 5;
const PASSWORD_LOCKOUT_MINUTES = 15;
const BCRYPT_ROUNDS = 12;

/**
 * Passwordless guest authentication for the mobile app: the guest enters
 * their email, receives a 6-digit code (via the same Mailgun account
 * already wired up for the daily accounting report), enters it, and
 * receives a long-lived session token the app stores on-device.
 *
 * This is deliberately separate from the backoffice's internal
 * staff-header pattern (x-organization-id / x-permissions) — that
 * pattern assumes a trusted staff member on an internal tool. A public
 * app cannot make that assumption; every guest-facing endpoint must
 * verify a real, individually-issued session token instead.
 *
 * Codes and tokens are stored only as SHA-256 hashes, never in plain
 * text — the same principle as a password, even though these are
 * short-lived/single-purpose values.
 */
@Injectable()
export class GuestAuthService {
  constructor(
    private prisma: PrismaService,
    private mailgun: MailgunService,
    private giftCards: GiftCardsService,
  ) {}

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  async requestCode(orgId: string, email: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { organizationId: orgId, email, deletedAt: null },
    });

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    // Deliberately the SAME response, and an identical-looking code
    // email, whether or not the address is a member — never reveal to
    // an unauthenticated caller whether a given email is a member
    // (account-enumeration protection). The registration-vs-login
    // branch only becomes visible AFTER a correct code is entered.
    if (!customer) {
      await this.prisma.guestRegistrationCode.create({
        data: { organizationId: orgId, email, codeHash: this.hash(code), expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000) },
      });
    } else {
      await this.prisma.guestLoginCode.create({
        data: { customerId: customer.id, codeHash: this.hash(code), expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000) },
      });
    }

    // Deliberately de-coupled from whether the account exists (zie de
    // OR/anti-enumeratie-opmerking hierboven), maar WEL zichtbaar voor de
    // aanvrager als het versturen zelf mislukt — anders lijkt de portal
    // "een code gestuurd" te hebben terwijl er niets is aangekomen, wat
    // eerder een stille Mailgun-storing verborg in plaats van meldde.
    if (!this.mailgun.isConfigured()) {
      throw new BadRequestException('E-mailverzending is nog niet geconfigureerd — neem contact op met de zaak.');
    }
    const emailResult = await this.mailgun.sendEmail(
      email,
      'Je inlogcode voor Mijn Tegoed',
      `Je inlogcode is: ${code}\n\nDeze code is ${CODE_TTL_MINUTES} minuten geldig. Heb je dit niet aangevraagd? Dan kun je dit bericht negeren.`,
    );
    if (!emailResult.sent) {
      throw new BadRequestException('We konden de code niet versturen — probeer het opnieuw of neem contact op met de zaak.');
    }

    return { sent: true };
  }

  async verifyCode(orgId: string, email: string, code: string, deviceInfo?: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { organizationId: orgId, email, deletedAt: null },
    });

    if (customer) {
      const loginCode = await this.prisma.guestLoginCode.findFirst({
        where: { customerId: customer.id, usedAt: null, expiresAt: { gte: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      if (!loginCode) throw new UnauthorizedException('Code verlopen of niet gevonden — vraag een nieuwe aan');
      if (loginCode.attempts >= MAX_CODE_ATTEMPTS) throw new UnauthorizedException('Te veel pogingen — vraag een nieuwe code aan');
      if (loginCode.codeHash !== this.hash(code)) {
        await this.prisma.guestLoginCode.update({ where: { id: loginCode.id }, data: { attempts: { increment: 1 } } });
        throw new UnauthorizedException('Ongeldige code');
      }
      await this.prisma.guestLoginCode.update({ where: { id: loginCode.id }, data: { usedAt: new Date() } });

      // Zelfde vangnet als bij nieuwe registraties: als er ondertussen
      // (bijv. vóór deze koppel-logica bestond, of door de eerder
      // gevonden duplicate-gast-ambiguïteit) nog een niet-gekoppelde
      // kadobon voor dit e-mailadres klaarstaat, alsnog koppelen.
      await this.giftCards.linkUnclaimedGiftCardsToCustomer(orgId, customer.id, email).catch(() => undefined);

      const session = await this.issueSession(customer.id, deviceInfo);
      return { ...session, requiresRegistration: false as const };
    }

    // Geen bestaande gast — probeer de registratiecode. Nooit een
    // ander soort foutmelding tonen dan bij een bestaande gast (zelfde
    // anti-enumeratie-principe als bij requestCode hierboven).
    const regCode = await this.prisma.guestRegistrationCode.findFirst({
      where: { organizationId: orgId, email, usedAt: null, expiresAt: { gte: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!regCode) throw new UnauthorizedException('Code verlopen of niet gevonden — vraag een nieuwe aan');
    if (regCode.attempts >= MAX_CODE_ATTEMPTS) throw new UnauthorizedException('Te veel pogingen — vraag een nieuwe code aan');
    if (regCode.codeHash !== this.hash(code)) {
      await this.prisma.guestRegistrationCode.update({ where: { id: regCode.id }, data: { attempts: { increment: 1 } } });
      throw new UnauthorizedException('Ongeldige code');
    }
    await this.prisma.guestRegistrationCode.update({ where: { id: regCode.id }, data: { usedAt: new Date() } });

    // Het e-mailadres is nu geverifieerd, maar er is nog geen profiel —
    // de frontend toont het korte registratieformulier en rondt af via
    // completeRegistration(), met dit ID als bewijs van de zojuist
    // geslaagde verificatie.
    return { requiresRegistration: true as const, verifiedRegistrationId: regCode.id };
  }

  /**
   * Rondt de registratie af ná een succesvolle e-mailverificatie
   * hierboven. Controleert bewust ALSNOG op een bestaande gast (op
   * e-mail én genormaliseerd telefoonnummer) — voorkomt dubbele
   * profielen als iemand tussen verificatie en dit moment via een
   * andere weg (POS, fysieke kaart, Piggy-import) al is aangemaakt.
   */
  async completeRegistration(
    orgId: string,
    verifiedRegistrationId: string,
    profile: { firstName: string; lastName?: string; email: string; phone?: string; dateOfBirth?: string; marketingConsent?: boolean; password?: string },
    deviceInfo?: string,
  ) {
    const regCode = await this.prisma.guestRegistrationCode.findFirst({
      where: { id: verifiedRegistrationId, organizationId: orgId, email: profile.email, usedAt: { not: null } },
    });
    if (!regCode) throw new UnauthorizedException('Verificatie verlopen — begin opnieuw met je e-mailadres');

    if (profile.password && profile.password.length < 8) {
      throw new BadRequestException('Wachtwoord moet minstens 8 tekens lang zijn');
    }
    const passwordHash = profile.password ? await bcrypt.hash(profile.password, BCRYPT_ROUNDS) : undefined;

    const normalizedPhone = profile.phone ? profile.phone.replace(/[^\d]/g, '') : undefined;
    let customer = await this.prisma.customer.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
        OR: [{ email: profile.email }, ...(normalizedPhone ? [{ phone: { contains: normalizedPhone } }] : [])],
      },
    });

    if (!customer) {
      customer = await this.prisma.customer.create({
        data: {
          organizationId: orgId,
          firstName: profile.firstName,
          lastName: profile.lastName,
          email: profile.email,
          phone: profile.phone,
          dateOfBirth: profile.dateOfBirth ? new Date(profile.dateOfBirth) : undefined,
          sourceChannel: 'website',
          passwordHash,
        } as never,
      });

      if (profile.marketingConsent) {
        await this.prisma.customerConsent
          .create({ data: { customerId: customer.id, consentType: 'marketing', granted: true, source: 'signup_form', privacyPolicyVersion: '2026-01' } as never })
          .catch(() => undefined);
      }
    } else if (passwordHash) {
      // Bestond al (bv. via POS aangemaakt) maar stelt nu voor het eerst
      // een wachtwoord in tijdens deze portalregistratie.
      await this.prisma.customer.update({ where: { id: customer.id }, data: { passwordHash } });
    }

    // Kadobonnen die eerder naar dit e-mailadres verstuurd zijn (vóórdat
    // er een account bestond) alsnog koppelen — anders blijven ze
    // onzichtbaar in Mijn Tegoed. Nooit de registratie laten mislukken als
    // dit om wat voor reden dan ook faalt.
    await this.giftCards.linkUnclaimedGiftCardsToCustomer(orgId, customer.id, profile.email).catch(() => undefined);

    const session = await this.issueSession(customer.id, deviceInfo);
    return { ...session, requiresRegistration: false as const };
  }

  /**
   * Uitgetrokken uit verifyCode zodat andere flows (zoals het claimen
   * van een fysieke loyaltykaart als nieuwe gast, waarbij de gast net
   * verse contactgegevens heeft opgegeven) ook direct een sessie kunnen
   * uitgeven, zonder de e-mailcode-stap te dupliceren.
   */
  async issueSession(customerId: string, deviceInfo?: string) {
    const token = randomBytes(32).toString('hex');
    await this.prisma.guestSession.create({
      data: {
        customerId,
        tokenHash: this.hash(token),
        deviceInfo,
        expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });

    return { token, customerId, expiresInDays: SESSION_TTL_DAYS };
  }

  /** Resolves a bearer token to a customer, or throws. Used by a guard on every guest-app endpoint. */
  async resolveSession(token: string) {
    const session = await this.prisma.guestSession.findFirst({
      where: { tokenHash: this.hash(token), revokedAt: null, expiresAt: { gte: new Date() } },
      include: { customer: true },
    });
    if (!session) throw new UnauthorizedException('Sessie ongeldig of verlopen — log opnieuw in');
    return session.customer;
  }

  async logout(token: string) {
    await this.prisma.guestSession.updateMany({
      where: { tokenHash: this.hash(token) },
      data: { revokedAt: new Date() },
    });
    return { loggedOut: true };
  }

  // -- Wachtwoord-login: EXTRA optie naast de e-mailcode-flow, nooit een
  // vervanging. Een gast die nooit een wachtwoord instelt, blijft
  // gewoon de codeflow gebruiken (passwordHash blijft dan null). ------

  private readonly GENERIC_PASSWORD_ERROR = 'E-mailadres of wachtwoord onjuist';

  async loginWithPassword(orgId: string, email: string, password: string, deviceInfo?: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { organizationId: orgId, email, deletedAt: null },
    });

    // Zelfde generieke foutmelding of de gast nu wel/niet bestaat, nog
    // geen wachtwoord heeft ingesteld, of een fout wachtwoord invoerde —
    // voorkomt dat een aanvaller e-mailadressen kan "raden" op basis van
    // het verschil in foutmelding (zelfde principe als bij de codeflow).
    if (!customer || !customer.passwordHash) {
      throw new UnauthorizedException(this.GENERIC_PASSWORD_ERROR);
    }

    if (customer.passwordLockedUntil && customer.passwordLockedUntil > new Date()) {
      throw new UnauthorizedException('Te veel mislukte pogingen — probeer het over enkele minuten opnieuw, of log in met een code');
    }

    const valid = await bcrypt.compare(password, customer.passwordHash);
    if (!valid) {
      const attempts = customer.passwordFailedAttempts + 1;
      const lockedOut = attempts >= MAX_PASSWORD_ATTEMPTS;
      await this.prisma.customer.update({
        where: { id: customer.id },
        data: {
          passwordFailedAttempts: lockedOut ? 0 : attempts,
          passwordLockedUntil: lockedOut ? new Date(Date.now() + PASSWORD_LOCKOUT_MINUTES * 60 * 1000) : null,
        },
      });
      throw new UnauthorizedException(this.GENERIC_PASSWORD_ERROR);
    }

    if (customer.passwordFailedAttempts > 0 || customer.passwordLockedUntil) {
      await this.prisma.customer.update({
        where: { id: customer.id },
        data: { passwordFailedAttempts: 0, passwordLockedUntil: null },
      });
    }

    await this.giftCards.linkUnclaimedGiftCardsToCustomer(orgId, customer.id, email).catch(() => undefined);

    const session = await this.issueSession(customer.id, deviceInfo);
    return { ...session, requiresRegistration: false as const };
  }

  /**
   * Wachtwoord instellen of wijzigen. Vereist een geldige, ingelogde
   * sessie (via de guard op de controller) — een gast kan dus nooit het
   * wachtwoord van een ander account zetten, alleen het eigen account
   * nádat die zich al via een code heeft aangemeld.
   */
  async setPassword(customerId: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('Wachtwoord moet minstens 8 tekens lang zijn');
    }
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { passwordHash, passwordFailedAttempts: 0, passwordLockedUntil: null },
    });
    return { passwordSet: true };
  }
}
