import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRewardRuleDto } from './dto/create-reward-rule.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId/reward-rules')
@UseGuards(PermissionsGuard)
export class RewardRulesController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermissions('reward_rule.read')
  list(
    @Param('orgId') orgId: string,
    @Query('bucket') bucket?: string,
    @Query('ruleType') ruleType?: string,
    @Query('isActive') isActive?: string,
  ) {
    return this.prisma.rewardRule.findMany({
      where: {
        organizationId: orgId,
        bucket: (bucket as never) || undefined,
        ruleType: (ruleType as never) || undefined,
        isActive: isActive === undefined ? undefined : isActive === 'true',
      },
      orderBy: [{ bucket: 'asc' }, { priority: 'desc' }],
    });
  }

  @Post()
  @RequirePermissions('reward_rule.write')
  create(@Param('orgId') orgId: string, @Body() dto: CreateRewardRuleDto) {
    return this.prisma.rewardRule.create({
      data: {
        organizationId: orgId,
        ruleType: dto.ruleType,
        bucket: dto.bucket,
        name: dto.name,
        stackingMode: dto.stackingMode,
        priority: dto.priority ?? 0,
        locationId: dto.locationId,
        tierId: dto.tierId,
        percentageValue: dto.percentageValue,
        multiplierValue: dto.multiplierValue,
        flatBonusAmount: dto.flatBonusAmount,
        flatBonusThreshold: dto.flatBonusThreshold,
        maximumRewardPerTransaction: dto.maximumRewardPerTransaction,
        appliesOnDay: dto.appliesOnDay,
        timeWindowStart: dto.timeWindowStart ? new Date(dto.timeWindowStart) : undefined,
        timeWindowEnd: dto.timeWindowEnd ? new Date(dto.timeWindowEnd) : undefined,
        productCategories: dto.productCategories,
        isExclusion: dto.isExclusion ?? false,
        activeFrom: dto.activeFrom ? new Date(dto.activeFrom) : undefined,
        activeUntil: dto.activeUntil ? new Date(dto.activeUntil) : undefined,
      },
    });
  }

  // Versioning per Module 4, section 15: a rule that has already been used
  // in a reward_calculation is never edited in place — a new version is
  // published instead, and the old one is marked superseded.
  @Patch(':id')
  @RequirePermissions('reward_rule.write')
  async update(@Param('orgId') orgId: string, @Param('id') id: string, @Body() dto: Partial<CreateRewardRuleDto>) {
    const existing = await this.prisma.rewardRule.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) return { error: 'not_found' };

    const usageCount = await this.prisma.rewardCalculation.count({
      where: { organizationId: orgId },
    });
    const wasUsed = usageCount > 0; // simplified check; production should inspect appliedRuleIds

    if (!wasUsed) {
      return this.prisma.rewardRule.update({ where: { id }, data: dto as never });
    }

    const newVersion = await this.prisma.rewardRule.create({
      data: {
        ...existing,
        id: undefined,
        version: existing.version + 1,
        parentRuleId: existing.parentRuleId ?? existing.id,
        createdAt: undefined,
        updatedAt: undefined,
        ...dto,
        activeFrom: new Date(),
      } as never,
    });

    await this.prisma.rewardRule.update({
      where: { id: existing.id },
      data: { supersededByRuleId: newVersion.id, activeUntil: new Date(), isActive: false },
    });

    return newVersion;
  }

  @Delete(':id')
  @RequirePermissions('reward_rule.write')
  deactivate(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.prisma.rewardRule.update({ where: { id }, data: { isActive: false } });
  }
}
