import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AiAssistantService } from './ai-assistant.service';
import { AudienceFilterService } from '../common/audience-filter.service';
import { OccupancyModule } from '../occupancy/occupancy.module';
import { CampaignsModule } from '../campaigns/campaigns.module';

@Module({
  imports: [OccupancyModule, CampaignsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AiAssistantService, AudienceFilterService],
})
export class AnalyticsModule {}
