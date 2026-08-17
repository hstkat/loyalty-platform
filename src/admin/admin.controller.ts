import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId/admin')
@UseGuards(PermissionsGuard)
export class AdminController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  @Get('overview')
  @RequirePermissions('admin.read')
  async getOverview(@Param('orgId') orgId: string) {
    const [organization, locations, customerCount, activeCardCount] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: orgId } }),
      this.prisma.location.findMany({ where: { organizationId: orgId } }),
      this.prisma.customer.count({ where: { organizationId: orgId, deletedAt: null } }),
      this.prisma.loyaltyCard.count({ where: { organizationId: orgId, status: 'active' } }),
    ]);
    return { organization, locations, customerCount, activeCardCount };
  }

  @Get('audit-log')
  @RequirePermissions('admin.read')
  getAuditLog(@Param('orgId') orgId: string, @Query('entityType') entityType?: string, @Query('search') search?: string) {
    return this.audit.list(orgId, { entityType, search });
  }
}
