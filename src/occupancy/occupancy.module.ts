import { Module } from '@nestjs/common';
import { OccupancyController } from './occupancy.controller';
import { OccupancyService } from './occupancy.service';
import { AudienceFilterService } from '../common/audience-filter.service';
import { CampaignsModule } from '../campaigns/campaigns.module';

@Module({
  imports: [CampaignsModule],
  controllers: [OccupancyController],
  providers: [OccupancyService, AudienceFilterService],
})
export class OccupancyModule {}
