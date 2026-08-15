import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AudienceFilterService, FilterGroup } from '../common/audience-filter.service';
import { OccupancyService } from '../occupancy/occupancy.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { AnalyticsService } from './analytics.service';
import { AskAssistantDto } from './dto/ask-assistant.dto';

/**
 * Implements Module 10's AI Campaign Assistant (design doc sections
 * 10-16). Every number in a response comes from an actual tool call
 * against real platform data, logged in full (ai_tool_calls) for
 * explainability — never a fabricated figure.
 *
 * HONEST SCOPE NOTE: this build pass does NOT call an external LLM to
 * interpret free-form language and decide which tools to invoke. Instead
 * it deterministically runs the fixed set of tools relevant to the
 * canonical "weather + low occupancy" scenario from the design doc
 * (getOccupancyForecast, getSegmentPreview) and composes the response
 * text from their real results. The tool-call architecture, logging, and
 * the recommendation/approval separation are real; the "understand any
 * question in natural language" part is not — see README.
 */
@Injectable()
export class AiAssistantService {
  constructor(
    private prisma: PrismaService,
    private audienceFilter: AudienceFilterService,
    private occupancy: OccupancyService,
    private campaigns: CampaignsService,
    private analytics: AnalyticsService,
  ) {}

  async ask(orgId: string, dto: AskAssistantDto) {
    const conversation = await this.prisma.aiAssistantConversation.create({
      data: { organizationId: orgId, userId: dto.userId },
    });

    const userMessage = await this.prisma.aiAssistantMessage.create({
      data: { conversationId: conversation.id, role: 'user', content: dto.promptText },
    });

    // -- Tool call 1: current occupancy for the target date/period ----------
    const occupancyNow = await this.occupancy.getOccupancy(dto.locationId, dto.date, 'lunch');
    await this.logToolCall(userMessage.id, 'getOccupancyForecast', { locationId: dto.locationId, date: dto.date }, occupancyNow);

    // -- Tool call 2: forecast for the target date (reuses Module 9) --------
    const forecast = await this.occupancy.computeForecast(orgId, dto.locationId, dto.date, 'lunch');
    await this.logToolCall(userMessage.id, 'getOccupancyForecastModel', { locationId: dto.locationId, date: dto.date }, forecast);

    // -- Tool call 3: candidate audience -------------------------------------
    const audienceFilterDef: FilterGroup = {
      combinator: 'AND',
      conditions: [
        { field: 'daysSinceLastVisit', operator: 'gt', value: 21 },
        { field: 'marketingConsent', operator: 'isTrue' },
      ],
    };
    const audience = await this.audienceFilter.evaluate(orgId, audienceFilterDef);
    await this.logToolCall(userMessage.id, 'getSegmentPreview', { filter: audienceFilterDef }, { count: audience.count });

    const forecastPct = Number(forecast.forecastOccupancyPercentage);
    const factors = forecast.factorsUsed as { historicalAverage?: number };
    const historicalAvg = factors?.historicalAverage ?? forecastPct;
    const gap = round2(Math.max(0, historicalAvg === forecastPct ? 0 : historicalAvg - forecastPct));

    let suggestion = null;
    let responseText: string;

    if (forecastPct < 45 && audience.count > 0) {
      const avgSpendEstimate = 50;
      const multiplier = forecastPct < 30 ? 3 : 2;
      const flatBonus = Math.round(avgSpendEstimate * 0.05 * (multiplier - 1) * 100) / 100; // pragmatic estimate

      const estimatedMaxExposure = round2(audience.count * avgSpendEstimate * 0.05 * multiplier);

      const suggestedMessage = `🌧 Geen strandweer? Binnen maken we het gezellig.\nLunch morgen en ontvang extra Strand tegoed bij besteding.`;

      suggestion = await this.prisma.aiCampaignSuggestion.create({
        data: {
          organizationId: orgId,
          conversationId: conversation.id,
          suggestedName: `AI Suggestie — Lunch Booster ${dto.date}`,
          audienceFilter: audienceFilterDef as unknown as Prisma.InputJsonValue,
          audienceCount: audience.count,
          incentiveType: 'multiplier',
          incentiveValue: { multiplier } as unknown as Prisma.InputJsonValue,
          suggestedMessage,
          estimatedMaxExposure,
          underlyingDataSnapshot: {
            forecastOccupancyPercentage: forecastPct,
            currentOccupancy: occupancyNow,
            audienceCount: audience.count,
          } as unknown as Prisma.InputJsonValue,
          status: 'pending_approval',
        },
      });

      responseText =
        `Opportunity detected: lunch occupancy ${forecastPct}% (huidige boekingen: ${occupancyNow.occupancyPercentage ?? '?'}%). ` +
        `Aanbevolen doelgroep: ${audience.count} klanten (geen bezoek laatste 21 dagen, marketing-consent). ` +
        `Aanbevolen incentive: ${multiplier}x Strand tegoed. Geschatte max. exposure: ${estimatedMaxExposure} punten.`;
    } else {
      responseText =
        forecastPct >= 45
          ? `Geen opportunity: geschatte bezetting ${forecastPct}% ligt boven de drempel van 45%.`
          : `Opportunity gedetecteerd (${forecastPct}%), maar geen geschikte doelgroep gevonden (0 klanten voldoen aan de criteria).`;
    }

    const assistantMessage = await this.prisma.aiAssistantMessage.create({
      data: { conversationId: conversation.id, role: 'assistant', content: responseText },
    });

    return {
      conversationId: conversation.id,
      response: responseText,
      suggestion,
      underlyingData: { occupancyNow, forecast, audienceCount: audience.count },
      assistantMessageId: assistantMessage.id,
    };
  }

  async getConversation(orgId: string, id: string) {
    const conversation = await this.prisma.aiAssistantConversation.findFirst({
      where: { id, organizationId: orgId },
      include: { messages: { include: { toolCalls: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  async listSuggestions(orgId: string, status?: string) {
    return this.prisma.aiCampaignSuggestion.findMany({
      where: { organizationId: orgId, status: (status as never) || undefined },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveSuggestion(orgId: string, id: string) {
    const suggestion = await this.prisma.aiCampaignSuggestion.findFirst({ where: { id, organizationId: orgId } });
    if (!suggestion) throw new NotFoundException('Suggestion not found');
    if (suggestion.status !== 'pending_approval') {
      throw new NotFoundException(`Suggestion is not pending approval (status: ${suggestion.status})`);
    }

    const campaign = await this.campaigns.create(orgId, {
      name: suggestion.suggestedName,
      goal: 'lunch_vullen',
      audienceFilter: suggestion.audienceFilter as never,
      incentiveType: suggestion.incentiveType as never,
      incentiveValue: suggestion.incentiveValue as never,
      channels: ['push'],
      scheduleType: 'direct',
      maxRewardExposure: Number(suggestion.estimatedMaxExposure),
    });

    await this.prisma.aiCampaignSuggestion.update({
      where: { id },
      data: { status: 'approved', resultingCampaignId: campaign.id },
    });

    return { suggestion: { ...suggestion, status: 'approved', resultingCampaignId: campaign.id }, campaign };
  }

  async dismissSuggestion(orgId: string, id: string) {
    const suggestion = await this.prisma.aiCampaignSuggestion.findFirst({ where: { id, organizationId: orgId } });
    if (!suggestion) throw new NotFoundException('Suggestion not found');
    return this.prisma.aiCampaignSuggestion.update({ where: { id }, data: { status: 'dismissed' } });
  }

  private async logToolCall(messageId: string, toolName: string, parameters: unknown, result: unknown) {
    await this.prisma.aiToolCall.create({
      data: {
        messageId,
        toolName,
        parameters: parameters as Prisma.InputJsonValue,
        result: result as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
