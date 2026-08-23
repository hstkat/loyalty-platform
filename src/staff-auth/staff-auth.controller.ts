import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { StaffAuthService } from './staff-auth.service';
import { PermissionsGuard } from '../common/guards/permissions.guard';

class StaffLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;

  @IsOptional()
  @IsString()
  deviceInfo?: string;
}

class StaffLogoutDto {
  @IsString()
  token!: string;
}

class ChangePasswordDto {
  @IsString()
  @MinLength(10)
  newPassword!: string;
}

// Bewust een APARTE, publieke login-route (geen PermissionsGuard) — een
// staff-lid heeft nog geen sessietoken vóórdat ingelogd is. Alle andere
// routes in deze controller vereisen wél een geldige sessie.
@Controller('organizations/:orgId/auth/staff')
export class StaffAuthController {
  constructor(private staffAuth: StaffAuthService) {}

  // Bovenop de account-level lockout in StaffAuthService (5 pogingen,
  // dan 15 min. geblokkeerd) ook een IP-level rate limit — voorkomt dat
  // iemand tegelijk veel VERSCHILLENDE e-mailadressen afgaat vanaf één
  // bron.
  @Throttle({ default: { limit: 10, ttl: 300000 } })
  @Post('login')
  login(@Param('orgId') orgId: string, @Body() dto: StaffLoginDto) {
    return this.staffAuth.login(orgId, dto.email, dto.password, dto.deviceInfo);
  }

  @Post('logout')
  logout(@Body() dto: StaffLogoutDto) {
    return this.staffAuth.logout(dto.token);
  }

  // Elke backoffice-pagina roept dit aan bij het laden om te weten welke
  // tabbladen te tonen — de bron van waarheid is hier altijd de
  // geverifieerde sessie (staffContext, door PermissionsGuard gezet),
  // nooit iets dat de pagina zelf onthoudt uit het loginmoment (rechten
  // kunnen tussentijds wijzigen).
  @Get('me')
  @UseGuards(PermissionsGuard)
  me(@Req() req: { staffContext?: { actorId: string | null; permissions: string[] } }) {
    return { permissions: req.staffContext?.permissions ?? [] };
  }

  @Post('change-password')
  @UseGuards(PermissionsGuard)
  changePassword(@Req() req: { staffContext?: { actorId: string | null } }, @Body() dto: ChangePasswordDto) {
    const staffUserId = req.staffContext?.actorId;
    if (!staffUserId) throw new Error('No authenticated staff user on request');
    return this.staffAuth.changeOwnPassword(staffUserId, dto.newPassword);
  }
}
