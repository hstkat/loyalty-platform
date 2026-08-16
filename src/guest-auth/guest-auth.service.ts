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

    // Deliberately the SAME response whether or not the email exists —
    // never reveal to an unauthenticated caller whether a given email
    // address is a member (a common account-enumeration protection).
    if (!customer) {
      return { sent: true };
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.prisma.guestLoginCode.create({
      data: {
        customerId: customer.id,
        codeHash: this.hash(code),
        expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
      },
    });

    if (this.mailgun.isConfigured()) {
      await this.mailgun.sendEmail(
        email,
        'Je inlogcode voor Strand tegoed',
        `Je inlogcode is: ${code}\n\nDeze code is ${CODE_TTL_MINUTES} minuten geldig. Heb je dit niet aangevraagd? Dan kun je dit bericht negeren.`,
      );
    }

    return { sent: true };
  }

  async verifyCode(orgId: string, email: string, code: string, deviceInfo?: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { organizationId: orgId, email, deletedAt: null },
    });
    if (!customer) throw new UnauthorizedException('Ongeldige code');

    const loginCode = await this.prisma.guestLoginCode.findFirst({
      where: { customerId: customer.id, usedAt: null, expiresAt: { gte: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!loginCode) throw new UnauthorizedException('Code verlopen of niet gevonden — vraag een nieuwe aan');

    if (loginCode.attempts >= MAX_CODE_ATTEMPTS) {
      throw new UnauthorizedException('Te veel pogingen — vraag een nieuwe code aan');
    }

    if (loginCode.codeHash !== this.hash(code)) {
      await this.prisma.guestLoginCode.update({ where: { id: loginCode.id }, data: { attempts: { increment: 1 } } });
      throw new UnauthorizedException('Ongeldige code');
    }

    await this.prisma.guestLoginCode.update({ where: { id: loginCode.id }, data: { usedAt: new Date() } });

    const token = randomBytes(32).toString('hex');
    await this.prisma.guestSession.create({
      data: {
        customerId: customer.id,
        tokenHash: this.hash(token),
        deviceInfo,
        expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });

    return { token, customerId: customer.id, expiresInDays: SESSION_TTL_DAYS };
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
