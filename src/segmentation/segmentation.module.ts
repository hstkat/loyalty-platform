import { Module } from '@nestjs/common';
import { SegmentsController } from './segments.controller';
import { SegmentsService } from './segments.service';
import { ChurnRiskService } from './churn-risk.service';
import { AudienceFilterService } from '../common/audience-filter.service';

@Module({
  controllers: [SegmentsController],
  providers: [SegmentsService, ChurnRiskService, AudienceFilterService],
})
export class SegmentationModule {}
