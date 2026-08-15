import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AudienceFilterService, FilterGroup } from '../common/audience-filter.service';
import { MessagingService } from '../messaging/messaging.service';
import { CreateCampaignDto, PreviewCampaignDto } from './dto/campaign.dto';

/**
 * Implements Module 5 (Campaign Manager). Reuses Module 4's reward_rules
 * mechanism for the incentive (a campaign never computes its own reward
 * math), and the shared AudienceFilterService for the doelgroep-DSL.
 *
 * SIMPLIFICATION vs. the design doc: scheduling (period/recurring),
 * approvals, and message-sending (Module 6 isn't built yet) are not
 * implemented here — `launch` only supports `direct` scheduling and
 * registers recipients without actually sending anything. See README.
 */
@Injectable()
export class CampaignsService {
  constructor(
    private prisma: PrismaService,
    private audienceFilter: AudienceFilterService,
    private messaging: MessagingService,
  ) {}

  create(orgId: string, dto: CreateCampaignDto) {
    return this.prisma.campaign.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        goal: dto.goal,
        audienceFilter: dto.audienceFilter as Prisma.InputJsonValue | undefined,
        incentiveType: dto.incentiveType ?? 'none',
        incentiveValue: dto.incentiveValue as Prisma.InputJsonValue | undefined,
        channels: (dto.channels ?? []) as Prisma.InputJsonValue,
        scheduleType: dto.scheduleType ?? 'direct',
        maxRecipients: dto.maxRecipients,
        maxRewardExposure: dto.maxRewardExposure,
        maxRedemptionCost: dto.maxRedemptionCost,
        maxIncentivePerCustomer: dto.maxIncentivePerCustomer ?? 1,
        controlGroupPercentage: dto.controlGroupPercentage,
      },
    });
  }

  findAll(orgId: string, status?: string) {
    return this.prisma.campaign.findMany({
      where: { organizationId: orgId, status: (status as never) || undefined },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(orgId: string, id: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  async preview(orgId: string, dto: PreviewCampaignDto) {
    const result = await this.audienceFilter.evaluate(orgId, dto.audienceFilter as unknown as FilterGroup);
    return { audienceCount: result.count };
  }

  async update(orgId: string, id: string, dto: Partial<CreateCampaignDto>) {
    await this.findOne(orgId, id);
    return this.prisma.campaign.update({
      where: { id },
      data: dto as never,
    });
  }

  /**
   * Launch (Module 5 design doc section 11): resolves the audience,
   * splits off a control group, registers recipients, and — if an
   * incentive is configured — creates the underlying Module 4 reward
   * rule scoped to this campaign via reward_rules.campaignId.
   */
  async launch(orgId: string, id: string) {
    const campaign = await this.findOne(orgId, id);
    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      throw new BadRequestException(`Cannot launch a campaign with status ${campaign.status}`);
    }
    if (!campaign.audienceFilter) {
      throw new BadRequestException('Campaign has no audience filter defined');
    }

    const { matchedCustomerIds } = await this.audienceFilter.evaluate(
      orgId,
      campaign.audienceFilter as unknown as FilterGroup,
    );

    if (matchedCustomerIds.length === 0) {
      throw new BadRequestException('Audience filter matched 0 customers — launch blocked');
    }

    const limited = campaign.maxRecipients ? matchedCustomerIds.slice(0, campaign.maxRecipients) : matchedCustomerIds;

    const controlGroupSize = campaign.controlGroupPercentage
      ? Math.floor((Number(campaign.controlGroupPercentage) / 100) * limited.length)
      : 0;
    const shuffled = [...limited].sort(() => Math.random() - 0.5);
    const controlGroupIds = new Set(shuffled.slice(0, controlGroupSize));

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.campaignAudienceSnapshot.createMany({
        data: limited.map((customerId) => ({
          campaignId: id,
          runNumber: 1,
          customerId,
          inControlGroup: controlGroupIds.has(customerId),
        })),
      });

      let rewardRuleId: string | undefined;
      if (campaign.incentiveType !== 'none') {
        const incentiveValue = (campaign.incentiveValue as Record<string, number>) ?? {};
        const rule = await tx.rewardRule.create({
          data: {
            organizationId: orgId,
            ruleType: 'campaign',
            bucket: campaign.incentiveType === 'multiplier' ? 'multiplier' : 'percentage',
            name: campaign.name,
            stackingMode: campaign.incentiveType === 'multiplier' ? 'highest_only' : 'additive',
            multiplierValue: incentiveValue.multiplier,
            percentageValue: incentiveValue.percentage,
            flatBonusAmount: incentiveValue.flatBonus,
            flatBonusThreshold: incentiveValue.minimumSpend,
            campaignId: id,
            isActive: true,
          },
        });
        rewardRuleId = rule.id;
      }

      const updated = await tx.campaign.update({
        where: { id },
        data: { status: 'active', rewardRuleId },
      });

      return updated;
    });

    // Sending happens AFTER the main transaction commits — Module 6's
    // MessagingService runs its own transactions per recipient, and
    // nesting interactive transactions is not supported by Prisma.
    const channels = (campaign.channels as string[]) ?? [];
    const treatmentGroup = limited.filter((cId) => !controlGroupIds.has(cId));
    const sendResultsByChannel: Record<string, unknown> = {};

    for (const channel of channels) {
      const sendResult = await this.messaging.send(orgId, {
        sourceType: 'campaign',
        sourceId: id,
        templateGroupKey: campaign.name.toLowerCase().replace(/\s+/g, '_'),
        customerIds: treatmentGroup,
        channel: channel as never,
      });
      sendResultsByChannel[channel] = sendResult;

      await this.prisma.campaignRecipient.createMany({
        data: (sendResult.results as Array<{ customerId: string; status: string; reason?: string }>).map((r) => ({
          campaignId: id,
          customerId: r.customerId,
          runNumber: 1,
          channel: channel as never,
          status: r.status === 'sent' ? 'queued' : 'failed',
          queuedAt: r.status === 'sent' ? new Date() : undefined,
          failureReason: r.status !== 'sent' ? (r.reason ?? r.status) : undefined,
        })),
      });
    }

    return {
      campaign: result,
      audienceSize: limited.length,
      controlGroupSize: controlGroupIds.size,
      sendResultsByChannel,
    };
  }

  async pause(orgId: string, id: string) {
    const campaign = await this.findOne(orgId, id);
    if (campaign.rewardRuleId) {
      await this.prisma.rewardRule.update({ where: { id: campaign.rewardRuleId }, data: { isActive: false } });
    }
    return this.prisma.campaign.update({ where: { id }, data: { status: 'paused' } });
  }

  async resume(orgId: string, id: string) {
    const campaign = await this.findOne(orgId, id);
    if (campaign.rewardRuleId) {
      await this.prisma.rewardRule.update({ where: { id: campaign.rewardRuleId }, data: { isActive: true } });
    }
    return this.prisma.campaign.update({ where: { id }, data: { status: 'active' } });
  }

  async cancel(orgId: string, id: string) {
    const campaign = await this.findOne(orgId, id);
    if (campaign.rewardRuleId) {
      await this.prisma.rewardRule.update({ where: { id: campaign.rewardRuleId }, data: { isActive: false } });
    }
    return this.prisma.campaign.update({ where: { id }, data: { status: 'cancelled' } });
  }

  async results(orgId: string, id: string) {
    await this.findOne(orgId, id);
    const [recipients, snapshots] = await Promise.all([
      this.prisma.campaignRecipient.groupBy({
        by: ['status'],
        where: { campaignId: id },
        _count: true,
      }),
      this.prisma.campaignMetricsSnapshot.findMany({
        where: { campaignId: id },
        orderBy: { snapshotAt: 'desc' },
        take: 1,
      }),
    ]);
    return { recipientsByStatus: recipients, latestSnapshot: snapshots[0] ?? null };
  }
}
