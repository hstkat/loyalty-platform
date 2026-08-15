import { Module } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { AudienceFilterService } from '../common/audience-filter.service';
import { MessagingModule } from '../messaging/messaging.module';

@Module({
  imports: [MessagingModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, AudienceFilterService],
  exports: [AudienceFilterService],
})
export class CampaignsModule {}
