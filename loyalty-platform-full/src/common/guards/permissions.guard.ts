import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { StaffAuthService } from '../../staff-auth/staff-auth.service';

/**
 * SECURITY-KRITIEKE GUARD — dit is de enige plek die bepaalt of een
 * backoffice-aanroep mag doorgaan.
 *
 * Verving een vorige versie die permissies (en, via de losse Ctx()-
 * decorator, óók organizationId/actorId) blindelings overnam uit
 * client-gestuurde headers (x-permissions, x-organization-id,
 * x-actor-id) — zonder ENIGE verificatie. Iedereen die de API-URL kende
 * kon zichzelf zo elk rechtenniveau én elke organisatie toe-eigenen
 * (zie security-audit). Nu:
 *
 *   1. Een geldige, niet-verlopen sessietoken is verplicht (Bearer-
 *      header) — geverifieerd tegen de database, niet vertrouwd.
 *   2. De organizationId van DIE sessie moet exact overeenkomen met de
 *      :orgId in de URL — een ingelogde medewerker van organisatie A
 *      kan zo nooit bij organisatie B's data, ook niet door simpelweg
 *      een andere org-UUID in de URL te zetten.
 *   3. Permissies worden gecontroleerd tegen de ECHTE, in de database
 *      opgeslagen permissielijst van dat account — nooit meer tegen een
 *      header die de aanvrager zelf kan invullen.
 *
 * Zet bij succes `request.staffContext` — dat leest de Ctx()-decorator
 * nu uit (zie current-context.decorator.ts), in plaats van headers.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private staffAuth: StaffAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const authHeader: string | undefined = request.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Geen sessietoken meegegeven — log in als medewerker');

    const staffUser = await this.staffAuth.resolveSession(token);

    const urlOrgId: string | undefined = request.params?.orgId;
    if (urlOrgId && urlOrgId !== staffUser.organizationId) {
      // Bewust een generieke 403, geen details over welke org wel klopt
      // — voorkomt dat dit endpoint gebruikt kan worden om te testen
      // welke org-UUID's daadwerkelijk bestaan/geldig zijn.
      throw new ForbiddenException('Geen toegang tot deze organisatie');
    }

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && required.length > 0) {
      const granted = staffUser.permissions;
      const hasAll = required.every((perm) => granted.includes(perm));
      if (!hasAll) {
        throw new ForbiddenException(
          `Missing required permission(s): ${required.filter((p) => !granted.includes(p)).join(', ')}`,
        );
      }
    }

    request.staffContext = {
      organizationId: staffUser.organizationId,
      actorId: staffUser.id,
      actorType: 'staff' as const,
      permissions: staffUser.permissions,
      ipAddress: request.ip ?? null,
      homeLocationId: staffUser.homeLocationId ?? null,
    };

    return true;
  }
}
