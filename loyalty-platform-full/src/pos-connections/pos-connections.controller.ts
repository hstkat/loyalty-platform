import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePosConnectionDto } from './dto/create-pos-connection.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

/**
 * Covers the "beheer" endpoints from Module 2 section 5. Webhook receivers
 * (section 6), polling workers, bulk/CSV import, and the full integration
 * health dashboard (section 14) are designed but NOT built in this pass —
 * see the README for scope. This gives you connection management and a
 * basic health readout only.
 */
@Controller('organizations/:orgId/pos-connections')
@UseGuards(PermissionsGuard)
export class PosConnectionsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermissions('transaction.read')
  list(@Param('orgId') orgId: string) {
    return this.prisma.posConnection.findMany({ where: { organizationId: orgId } });
  }

  @Post()
  @RequirePermissions('transaction.write')
  create(@Param('orgId') orgId: string, @Body() dto: CreatePosConnectionDto) {
    return this.prisma.posConnection.create({
      data: {
        organizationId: orgId,
        locationId: dto.locationId,
        provider: dto.provider,
        connectionMode: dto.connectionMode,
        apiCredentialsRef: dto.apiCredentialsRef,
        status: 'active',
      },
    });
  }

  @Get(':id/health')
  @RequirePermissions('transaction.read')
  async health(@Param('orgId') orgId: string, @Param('id') id: string) {
    const connection = await this.prisma.posConnection.findFirst({ where: { id, organizationId: orgId } });
    if (!connection) return { error: 'not_found' };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [transactionsToday, openErrors, unmatchedProducts] = await Promise.all([
      this.prisma.transaction.count({ where: { posConnectionId: id, occurredAt: { gte: today } } }),
      this.prisma.failedTransaction.count({ where: { posEvent: { posConnectionId: id }, status: 'pending_retry' } }),
      this.prisma.posProductMapping.count({ where: { posConnectionId: id, mappingStatus: 'unmapped' } }),
    ]);

    return {
      connectionId: id,
      status: connection.status,
      lastSyncedAt: connection.lastSyncedAt,
      lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
      transactionsToday,
      openErrors,
      unmatchedProducts,
    };
  }
}
