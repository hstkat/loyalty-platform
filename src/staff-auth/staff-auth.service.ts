import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

const SESSION_TTL_DAYS = 14;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const BCRYPT_ROUNDS = 12;

/**
 * Vervangt de vorige "auth-stub" (organizationId/permissions/actorId
 * zomaar overgenomen uit x-organization-id / x-permissions / x-actor-id
 * headers, zonder enige verificatie — zie security-audit). Zelfde
 * bewezen patroon als de klantportal: bcrypt-wachtwoorden, alleen een
 * GEHASHTE sessietoken in de database (nooit de ruwe token zelf), en
 * brute-force-lockout.
 *
 * Deze service wordt zowel door de login/logout-endpoints gebruikt als
 * door PermissionsGuard (die de ruwe sessie-lookup nodig heeft op élke
 * beveiligde aanroep).
 */
@Injectable()
export class StaffAuthService {
  constructor(private prisma: PrismaService) {}

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private readonly GENERIC_LOGIN_ERROR = 'E-mailadres of wachtwoord onjuist';

  async login(orgId: string, email: string, password: string, deviceInfo?: string) {
    const staffUser = await this.prisma.staffUser.findFirst({
      where: { organizationId: orgId, email, isActive: true },
    });

    // Generieke foutmelding ongeacht of het account bestaat, inactief
    // is, of het wachtwoord fout is — voorkomt dat een aanvaller kan
    // afleiden welke e-mailadressen wel/niet een backoffice-account
    // hebben (zelfde anti-enumeratie-principe als de klantportal-login).
    if (!staffUser) throw new UnauthorizedException(this.GENERIC_LOGIN_ERROR);

    if (staffUser.lockedUntil && staffUser.lockedUntil > new Date()) {
      throw new UnauthorizedException('Te veel mislukte pogingen — probeer het over enkele minuten opnieuw');
    }

    const valid = await bcrypt.compare(password, staffUser.passwordHash);
    if (!valid) {
      const attempts = staffUser.failedLoginAttempts + 1;
      const lockedOut = attempts >= MAX_LOGIN_ATTEMPTS;
      await this.prisma.staffUser.update({
        where: { id: staffUser.id },
        data: {
          failedLoginAttempts: lockedOut ? 0 : attempts,
          lockedUntil: lockedOut ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null,
        },
      });
      throw new UnauthorizedException(this.GENERIC_LOGIN_ERROR);
    }

    await this.prisma.staffUser.update({
      where: { id: staffUser.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const token = randomBytes(32).toString('base64url');
    await this.prisma.staffSession.create({
      data: {
        staffUserId: staffUser.id,
        tokenHash: this.hash(token),
        deviceInfo,
        expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });

    return {
      token,
      staffUser: {
        id: staffUser.id,
        organizationId: staffUser.organizationId,
        firstName: staffUser.firstName,
        lastName: staffUser.lastName,
        permissions: staffUser.permissions,
      },
    };
  }

  /**
   * Gebruikt door PermissionsGuard op ELKE beveiligde backoffice-
   * aanroep. Geeft de geverifieerde identiteit terug — organizationId
   * en permissions komen hier vandaan, nooit meer uit een header.
   */
  async resolveSession(token: string) {
    const session = await this.prisma.staffSession.findFirst({
      where: { tokenHash: this.hash(token), revokedAt: null, expiresAt: { gte: new Date() } },
      include: { staffUser: true },
    });
    if (!session || !session.staffUser.isActive) {
      throw new UnauthorizedException('Sessie ongeldig of verlopen — log opnieuw in');
    }
    return session.staffUser;
  }

  async logout(token: string) {
    await this.prisma.staffSession.updateMany({
      where: { tokenHash: this.hash(token) },
      data: { revokedAt: new Date() },
    });
    return { loggedOut: true };
  }

  /**
   * Wachtwoord wijzigen voor het eigen account (vereist al een geldige
   * sessie — zie StaffAuthController). Geen "huidig wachtwoord"-check
   * hier nodig bovenop de sessie zelf, want de sessie IS al het bewijs
   * dat deze aanvrager recent correct is ingelogd.
   */
  async changeOwnPassword(staffUserId: string, newPassword: string) {
    if (!newPassword || newPassword.length < 10) {
      throw new BadRequestException('Wachtwoord moet minstens 10 tekens lang zijn');
    }
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.staffUser.update({
      where: { id: staffUserId },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
    });
    return { changed: true };
  }
}
