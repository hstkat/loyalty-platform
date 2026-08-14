import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const permissionsHeader: string | undefined = request.headers['x-permissions'];
    const granted = permissionsHeader
      ? permissionsHeader.split(',').map((p: string) => p.trim())
      : [];

    const hasAll = required.every((perm) => granted.includes(perm));
    if (!hasAll) {
      throw new ForbiddenException(
        `Missing required permission(s): ${required.filter((p) => !granted.includes(p)).join(', ')}`,
      );
    }

    return true;
  }
}
