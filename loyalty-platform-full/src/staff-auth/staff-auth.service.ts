import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { VALID_PERMISSION_KEYS } from './permission-catalog';

const SESSION_TTL_DAYS = 14;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const BCRYPT_ROUNDS = 12;

/**
 * Vervangt de vorige "auth-stub" (organizationId/permissions/actorId
 * zomaar overgenomen uit x-organization-id / x-permissions / x-actor-id
 * headers, zonder enige verificatie — zie security-audit). Zelfde
 * bewezen patroon als de gastportal: bcrypt-wachtwoorden, alleen een
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
    // hebben (zelfde anti-enumeratie-principe als de gastportal-login).
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

  // -- Medewerkersbeheer (alleen voor accounts met 'admin.write') ---------
  // Rechten worden hier gevalideerd tegen de vaste PERMISSION_CATALOG —
  // een admin kan dus nooit per ongeluk (of via een geknutselde request)
  // een niet-bestaande of verkeerd gespelde permissiestring toekennen.

  private validatePermissions(permissions: string[]) {
    const invalid = permissions.filter((p) => !VALID_PERMISSION_KEYS.has(p));
    if (invalid.length > 0) {
      throw new BadRequestException(`Onbekende permissie(s): ${invalid.join(', ')}`);
    }
  }

  async listUsers(orgId: string) {
    const users = await this.prisma.staffUser.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        permissions: true,
        isActive: true,
        lastLoginAt: true,
        lockedUntil: true,
        createdAt: true,
        homeLocationId: true,
        homeLocation: { select: { name: true, slug: true } },
      },
    });
    return users;
  }

  async createUser(
    orgId: string,
    dto: { email: string; password: string; firstName: string; lastName?: string; permissions: string[]; homeLocationId?: string },
  ) {
    this.validatePermissions(dto.permissions);
    if (!dto.password || dto.password.length < 10) {
      throw new BadRequestException('Wachtwoord moet minstens 10 tekens lang zijn');
    }

    const existing = await this.prisma.staffUser.findFirst({ where: { organizationId: orgId, email: dto.email } });
    if (existing) throw new ConflictException('Er bestaat al een medewerker met dit e-mailadres');

    // Bestaat de opgegeven locatie ook echt binnen deze organisatie? Een
    // ongeldig/vreemd ID hier zou stilzwijgend een medewerker zonder
    // werkende locatie-afdwinging opleveren — beter meteen duidelijk
    // weigeren.
    if (dto.homeLocationId) {
      const location = await this.prisma.location.findFirst({ where: { id: dto.homeLocationId, organizationId: orgId } });
      if (!location) throw new BadRequestException('Opgegeven locatie niet gevonden binnen deze organisatie');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const staffUser = await this.prisma.staffUser.create({
      data: {
        organizationId: orgId,
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        permissions: dto.permissions,
        homeLocationId: dto.homeLocationId || null,
      },
      select: { id: true, email: true, firstName: true, lastName: true, permissions: true, isActive: true, homeLocationId: true, homeLocation: { select: { name: true } } },
    });
    return staffUser;
  }

  async updateUser(
    orgId: string,
    targetUserId: string,
    dto: { firstName?: string; lastName?: string; permissions?: string[]; isActive?: boolean; homeLocationId?: string },
  ) {
    if (dto.permissions) this.validatePermissions(dto.permissions);

    const target = await this.prisma.staffUser.findFirst({ where: { id: targetUserId, organizationId: orgId } });
    if (!target) throw new NotFoundException('Medewerker niet gevonden');

    // Onderscheid tussen "veld niet meegegeven" (niet wijzigen) en
    // "expliciet lege string meegegeven" (koppeling verwijderen) — bij
    // een gewone update-aanroep die het veld gewoon weglaat, moet de
    // bestaande homeLocationId onaangeroerd blijven.
    let homeLocationIdUpdate: string | null | undefined = undefined;
    if (dto.homeLocationId !== undefined) {
      if (dto.homeLocationId === '') {
        homeLocationIdUpdate = null;
      } else {
        const location = await this.prisma.location.findFirst({ where: { id: dto.homeLocationId, organizationId: orgId } });
        if (!location) throw new BadRequestException('Opgegeven locatie niet gevonden binnen deze organisatie');
        homeLocationIdUpdate = dto.homeLocationId;
      }
    }

    const updated = await this.prisma.staffUser.update({
      where: { id: targetUserId },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        permissions: dto.permissions,
        isActive: dto.isActive,
        homeLocationId: homeLocationIdUpdate,
      },
      select: { id: true, email: true, firstName: true, lastName: true, permissions: true, isActive: true, homeLocationId: true, homeLocation: { select: { name: true } } },
    });

    // Alle actieve sessies van dit account intrekken zodra iemand het
    // account deactiveert of de rechten aanpast — anders blijft een
    // bestaande, nog niet verlopen sessietoken de OUDE rechten houden
    // tot die vanzelf afloopt (tot 14 dagen).
    if (dto.isActive === false || dto.permissions) {
      await this.prisma.staffSession.updateMany({
        where: { staffUserId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return updated;
  }

  /**
   * Een admin zet een nieuw wachtwoord voor EEN ANDER account (in
   * tegenstelling tot changeOwnPassword, dat alleen het eigen
   * wachtwoord kan wijzigen). Trekt ook meteen alle bestaande sessies
   * van dat account in — belangrijk als dit gebruikt wordt omdat een
   * medewerker uit dienst is of het account gecompromitteerd leek.
   */
  async adminResetPassword(orgId: string, targetUserId: string, newPassword: string) {
    if (!newPassword || newPassword.length < 10) {
      throw new BadRequestException('Wachtwoord moet minstens 10 tekens lang zijn');
    }
    const target = await this.prisma.staffUser.findFirst({ where: { id: targetUserId, organizationId: orgId } });
    if (!target) throw new NotFoundException('Medewerker niet gevonden');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.staffUser.update({
      where: { id: targetUserId },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
    });
    await this.prisma.staffSession.updateMany({
      where: { staffUserId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { reset: true };
  }

  /**
   * Zachte verwijdering (isActive: false), nooit een harde delete —
   * behoudt de audit-trail (wie heeft wat gedaan) en voorkomt kapotte
   * verwijzingen. Een admin kan zichzelf niet deactiveren, dat zou
   * kunnen leiden tot een organisatie zonder enig actief admin-account.
   */
  async deactivateUser(orgId: string, targetUserId: string, requestingUserId: string) {
    if (targetUserId === requestingUserId) {
      throw new ForbiddenException('Je kunt je eigen account niet deactiveren');
    }
    return this.updateUser(orgId, targetUserId, { isActive: false });
  }

  /**
   * Écht verwijderen (geen soft-delete) — bedoeld voor accounts zonder
   * relevante geschiedenis. Sessies gaan automatisch mee (cascade).
   * Losse verwijzingen elders (performedByUserId e.d.) zijn bewust GEEN
   * echte foreign-key-koppeling in dit platform, dus die blokkeren een
   * verwijdering nooit — zie ook scripts/delete-staff-users-except.ts.
   */
  async deleteUser(orgId: string, targetUserId: string, requestingUserId: string) {
    if (targetUserId === requestingUserId) {
      throw new ForbiddenException('Je kunt je eigen account niet verwijderen');
    }
    const target = await this.prisma.staffUser.findFirst({ where: { id: targetUserId, organizationId: orgId } });
    if (!target) throw new NotFoundException('Medewerker niet gevonden');

    await this.prisma.staffUser.delete({ where: { id: targetUserId } });
    return { deleted: true };
  }
}
