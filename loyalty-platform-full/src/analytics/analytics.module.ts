import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AiAssistantService } from './ai-assistant.service';
import { MailgunService } from '../common/mailgun.service';
import { DailyClosingService } from './daily-closing.service';
import { CronController } from './cron.controller';
import { AudienceFilterService } from '../common/audience-filter.service';
import { OccupancyModule } from '../occupancy/occupancy.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [OccupancyModule, CampaignsModule, WalletModule],
  controllers: [AnalyticsController, CronController],
  providers: [AnalyticsService, AiAssistantService, AudienceFilterService, MailgunService, DailyClosingService],
})
export class AnalyticsModule {}
