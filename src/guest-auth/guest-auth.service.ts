import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailgunService } from '../common/mailgun.service';

const CODE_TTL_MINUTES = 10;
const SESSION_TTL_DAYS = 90;
const MAX_CODE_ATTEMPTS = 5;

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

    if (this.mailgun.isConfigured()) {
      await this.mailgun.sendEmail(
        email,
        'Je inlogcode voor Mijn Tegoed',
        `Je inlogcode is: ${code}\n\nDeze code is ${CODE_TTL_MINUTES} minuten geldig. Heb je dit niet aangevraagd? Dan kun je dit bericht negeren.`,
      );
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

      const session = await this.issueSession(customer.id, deviceInfo);
      return { ...session, requiresRegistration: false as const };
    }

    // Geen bestaande klant — probeer de registratiecode. Nooit een
    // ander soort foutmelding tonen dan bij een bestaande klant (zelfde
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
   * hierboven. Controleert bewust ALSNOG op een bestaande klant (op
   * e-mail én genormaliseerd telefoonnummer) — voorkomt dubbele
   * profielen als iemand tussen verificatie en dit moment via een
   * andere weg (POS, fysieke kaart, Piggy-import) al is aangemaakt.
   */
  async completeRegistration(
    orgId: string,
    verifiedRegistrationId: string,
    profile: { firstName: string; lastName?: string; email: string; phone?: string; dateOfBirth?: string; marketingConsent?: boolean },
    deviceInfo?: string,
  ) {
    const regCode = await this.prisma.guestRegistrationCode.findFirst({
      where: { id: verifiedRegistrationId, organizationId: orgId, email: profile.email, usedAt: { not: null } },
    });
    if (!regCode) throw new UnauthorizedException('Verificatie verlopen — begin opnieuw met je e-mailadres');

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
        } as never,
      });

      if (profile.marketingConsent) {
        await this.prisma.customerConsent
          .create({ data: { customerId: customer.id, consentType: 'marketing', granted: true, source: 'signup_form', privacyPolicyVersion: '2026-01' } as never })
          .catch(() => undefined);
      }
    }

    const session = await this.issueSession(customer.id, deviceInfo);
    return { ...session, requiresRegistration: false as const };
  }

  /**
   * Uitgetrokken uit verifyCode zodat andere flows (zoals het claimen
   * van een fysieke loyaltykaart als nieuwe klant, waarbij de gast net
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
}
