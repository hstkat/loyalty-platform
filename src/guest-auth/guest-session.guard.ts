import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { GuestAuthService } from './guest-auth.service';

@Injectable()
export class GuestSessionGuard implements CanActivate {
  constructor(private guestAuth: GuestAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (!token) throw new UnauthorizedException('Geen sessietoken meegegeven');

    const customer = await this.guestAuth.resolveSession(token);
    request.guestCustomer = customer;
    return true;
  }
}
