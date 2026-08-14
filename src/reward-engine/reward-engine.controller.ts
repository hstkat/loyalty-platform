import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { RewardEngineService } from './reward-engine.service';
import { SimulateRewardDto } from './dto/simulate-reward.dto';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId')
@UseGuards(PermissionsGuard)
export class RewardEngineController {
  constructor(
    private rewardEngine: RewardEngineService,
    private prisma: PrismaService,
  ) {}

  // The Rule Simulator (Module 4, section 10) — reuses the exact same
  // calculation code as a live transaction. Results are persisted with
  // isSimulation: true so they show up in the reward log for support
  // purposes without affecting any customer's real balance.
  @Post('reward-simulations')
  @RequirePermissions('reward_rule.read')
  async simulate(@Param('orgId') orgId: string, @Body() dto: SimulateRewardDto) {
    return this.rewardEngine.calculate({
      organizationId: orgId,
      customerId: dto.customerId,
      tierId: dto.tierId,
      locationId: dto.locationId,
      eligibleAmount: dto.amount,
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      isSimulation: true,
    });
  }

  @Get('reward-calculations')
  @RequirePermissions('reward_calculation.read')
  list(
    @Param('orgId') orgId: string,
    @Query('customerId') customerId?: string,
    @Query('isSimulation') isSimulation?: string,
  ) {
    return this.prisma.rewardCalculation.findMany({
      where: {
        organizationId: orgId,
        customerId: customerId || undefined,
        isSimulation: isSimulation === undefined ? undefined : isSimulation === 'true',
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Get('reward-calculations/:id')
  @RequirePermissions('reward_calculation.read')
  findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.prisma.rewardCalculation.findFirst({ where: { id, organizationId: orgId } });
  }

  // Re-runs the simulator using the exact parameters of a historical
  // transaction-based calculation (Module 4, section 11).
  @Post('reward-calculations/:id/resimulate')
  @RequirePermissions('reward_rule.read')
  async resimulate(@Param('orgId') orgId: string, @Param('id') id: string) {
    const original = await this.prisma.rewardCalculation.findFirst({ where: { id, organizationId: orgId } });
    if (!original) return { error: 'not_found' };

    return this.rewardEngine.calculate({
      organizationId: orgId,
      customerId: original.customerId ?? undefined,
      eligibleAmount: Number(original.eligibleAmount),
      occurredAt: original.createdAt,
      isSimulation: true,
    });
  }
}
