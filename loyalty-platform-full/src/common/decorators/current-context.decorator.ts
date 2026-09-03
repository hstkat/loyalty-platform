import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';

/**
 * Everything downstream code needs to know about "who is making this
 * call and for which organization".
 *
 * Voorheen (auth-stub): rechtstreeks uit client-headers gelezen, zonder
 * verificatie — x-organization-id, x-actor-id, x-actor-type,
 * x-permissions konden door de aanvrager zelf worden ingevuld. Zie
 * security-audit: dat gaf iedereen die de API-URL kende volledige
 * cross-tenant admin-toegang.
 *
 * Nu: leest UITSLUITEND `request.staffContext`, dat PermissionsGuard
 * hiervoor al heeft gezet ná een echte sessie-/permissie-verificatie
 * (zie common/guards/permissions.guard.ts). Deze decorator doet zelf
 * geen verificatie meer — hij vertrouwt puur op wat de guard net heeft
 * vastgesteld. Elke route die @Ctx() gebruikt MOET dus ook
 * @UseGuards(PermissionsGuard) hebben (alle backoffice-controllers doen
 * dat al op class-niveau); zonder de guard is staffContext nooit gezet
 * en gooien we bewust een harde serverfout in plaats van hier alsnog
 * headers te vertrouwen.
 */
export interface RequestContext {
  organizationId: string;
  actorId: string | null;
  actorType: 'staff' | 'system' | 'api_key' | 'customer_self_service';
  permissions: string[];
  ipAddress: string | null;
  // Vaste locatie van de ingelogde medewerker (StaffUser.homeLocationId)
  // — null voor accounts zonder vaste locatie. Zie
  // common/location-resolution.ts voor hoe dit wordt afgedwongen.
  homeLocationId: string | null;
}

export const Ctx = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  const request = ctx.switchToHttp().getRequest();
  const staffContext = request.staffContext;

  if (!staffContext) {
    // Programmeerfout, geen client-fout: een controller gebruikt @Ctx()
    // zonder PermissionsGuard ervoor. Bewust NIET terugvallen op
    // headers — dat zou precies het lek herintroduceren dat deze fix
    // dichtte.
    throw new InternalServerErrorException(
      'RequestContext opgevraagd zonder geverifieerde staff-sessie — ontbreekt PermissionsGuard op deze route?',
    );
  }

  return staffContext as RequestContext;
});
