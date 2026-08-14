import { createParamDecorator, ExecutionContext, BadRequestException } from '@nestjs/common';

/**
 * Everything downstream code needs to know about "who is making this call
 * and for which organization". Populated by the (stub) auth layer below.
 *
 * NOTE — auth stub: this module (Customer & CRM) does not define Users,
 * Roles, or authentication itself; those live in a shared platform/auth
 * module that hasn't been built yet. Until it exists, request context is
 * read from headers so the API is fully wireable and testable end-to-end:
 *
 *   x-organization-id : UUID of the tenant (required)
 *   x-actor-id         : UUID of the staff user / api key (optional)
 *   x-actor-type       : 'staff' | 'system' | 'api_key' | 'customer_self_service'
 *   x-permissions      : comma-separated permission strings, e.g.
 *                        "customer.read,customer.write"
 *
 * Swap this decorator's implementation for a real JWT/session-based one
 * once the auth module lands — every controller in this codebase reads
 * context through this single decorator, so that's a one-file change.
 */
export interface RequestContext {
  organizationId: string;
  actorId: string | null;
  actorType: 'staff' | 'system' | 'api_key' | 'customer_self_service';
  permissions: string[];
  ipAddress: string | null;
}

export const Ctx = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  const request = ctx.switchToHttp().getRequest();

  const organizationId = request.headers['x-organization-id'];
  if (!organizationId) {
    throw new BadRequestException('Missing required x-organization-id header');
  }

  const permissionsHeader = request.headers['x-permissions'];
  const permissions =
    typeof permissionsHeader === 'string' && permissionsHeader.length > 0
      ? permissionsHeader.split(',').map((p: string) => p.trim())
      : [];

  return {
    organizationId,
    actorId: request.headers['x-actor-id'] ?? null,
    actorType: (request.headers['x-actor-type'] as RequestContext['actorType']) ?? 'system',
    permissions,
    ipAddress: request.ip ?? null,
  };
});
