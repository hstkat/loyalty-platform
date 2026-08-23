import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { StaffAuthService } from './staff-auth.service';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PERMISSION_CATALOG } from './permission-catalog';

class CreateStaffUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(10)
  password!: string;

  @IsString()
  firstName!: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsArray()
  @IsString({ each: true })
  permissions!: string[];
}

class UpdateStaffUserDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class ResetPasswordDto {
  @IsString()
  @MinLength(10)
  newPassword!: string;
}

// Alle routes hier vereisen al een geldige, geverifieerde staff-sessie
// (PermissionsGuard) — dit is dus zelf al alleen bereikbaar ná inloggen,
// en verder afgeschermd met 'admin.read'/'admin.write' zodat gewone
// medewerkers (zonder die rechten) geen andere accounts kunnen zien of
// wijzigen.
@Controller('organizations/:orgId/staff-users')
@UseGuards(PermissionsGuard)
export class StaffUsersController {
  constructor(private staffAuth: StaffAuthService) {}

  @Get('permission-catalog')
  @RequirePermissions('admin.read')
  getPermissionCatalog() {
    return PERMISSION_CATALOG;
  }

  @Get()
  @RequirePermissions('admin.read')
  list(@Param('orgId') orgId: string) {
    return this.staffAuth.listUsers(orgId);
  }

  @Post()
  @RequirePermissions('admin.write')
  create(@Param('orgId') orgId: string, @Body() dto: CreateStaffUserDto) {
    return this.staffAuth.createUser(orgId, dto);
  }

  @Patch(':id')
  @RequirePermissions('admin.write')
  update(@Param('orgId') orgId: string, @Param('id') id: string, @Body() dto: UpdateStaffUserDto) {
    return this.staffAuth.updateUser(orgId, id, dto);
  }

  @Post(':id/reset-password')
  @RequirePermissions('admin.write')
  resetPassword(@Param('orgId') orgId: string, @Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.staffAuth.adminResetPassword(orgId, id, dto.newPassword);
  }

  @Delete(':id')
  @RequirePermissions('admin.write')
  deactivate(@Param('orgId') orgId: string, @Param('id') id: string, @Req() req: { staffContext?: { actorId: string | null } }) {
    return this.staffAuth.deactivateUser(orgId, id, req.staffContext?.actorId ?? '');
  }
}
