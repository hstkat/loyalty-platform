import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AiAssistantService } from './ai-assistant.service';
import { DailyClosingService } from './daily-closing.service';
import { AskAssistantDto } from './dto/ask-assistant.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId')
@UseGuards(PermissionsGuard)
export class AnalyticsController {
  constructor(
    private analytics: AnalyticsService,
    private aiAssistant: AiAssistantService,
    private dailyClosing: DailyClosingService,
  ) {}

  @Get('dashboard')
  @RequirePermissions('analytics.read')
  getDashboard(@Param('orgId') orgId: string) {
    return this.analytics.getDashboard(orgId);
  }

  @Get('analytics/credit')
  @RequirePermissions('analytics.read')
  getCreditAnalytics(@Param('orgId') orgId: string) {
    return this.analytics.getCreditAnalytics(orgId);
  }

  @Get('analytics/campaigns')
  @RequirePermissions('analytics.read')
  getCampaignRoiRanking(@Param('orgId') orgId: string) {
    return this.analytics.getCampaignRoiRanking(orgId);
  }

  @Get('analytics/daily-closing')
  @RequirePermissions('analytics.read')
  getDailyClosing(@Param('orgId') orgId: string, @Query('date') date: string) {
    return this.analytics.getDailyClosing(orgId, date);
  }

  @Post('analytics/daily-closing/send')
  @RequirePermissions('analytics.read')
  sendDailyClosingManual(
    @Param('orgId') orgId: string,
    @Body() body: { date: string; recipient?: string },
  ) {
    return this.dailyClosing.sendDailyClosingEmail(orgId, body.date, body.recipient);
  }

  @Post('ai-assistant/ask')
  @RequirePermissions('ai_assistant.use')
  ask(@Param('orgId') orgId: string, @Body() dto: AskAssistantDto) {
    return this.aiAssistant.ask(orgId, dto);
  }

  @Get('ai-assistant/conversations/:id')
  @RequirePermissions('ai_assistant.use')
  getConversation(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.aiAssistant.getConversation(orgId, id);
  }

  @Get('ai-campaign-suggestions')
  @RequirePermissions('ai_assistant.use')
  listSuggestions(@Param('orgId') orgId: string, @Query('status') status?: string) {
    return this.aiAssistant.listSuggestions(orgId, status);
  }

  @Post('ai-campaign-suggestions/:id/approve')
  @RequirePermissions('ai_campaign_suggestion.approve')
  approveSuggestion(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.aiAssistant.approveSuggestion(orgId, id);
  }

  @Post('ai-campaign-suggestions/:id/dismiss')
  @RequirePermissions('ai_assistant.use')
  dismissSuggestion(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.aiAssistant.dismissSuggestion(orgId, id);
  }
}
