import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { SegmentsService } from './segments.service';
import { ChurnRiskService } from './churn-risk.service';
import { CreateSegmentDto, PreviewSegmentDto } from './dto/segment.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId')
@UseGuards(PermissionsGuard)
export class SegmentsController {
  constructor(
    private segments: SegmentsService,
    private churnRisk: ChurnRiskService,
  ) {}

  @Post('segments')
  @RequirePermissions('segment.write')
  create(@Param('orgId') orgId: string, @Body() dto: CreateSegmentDto) {
    return this.segments.create(orgId, dto);
  }

  @Get('segments')
  @RequirePermissions('segment.read')
  findAll(@Param('orgId') orgId: string, @Query('segmentType') segmentType?: string) {
    return this.segments.findAll(orgId, segmentType);
  }

  @Post('segments/preview')
  @RequirePermissions('segment.read')
  preview(@Param('orgId') orgId: string, @Body() dto: PreviewSegmentDto) {
    return this.segments.preview(orgId, dto);
  }

  @Get('segments/:id')
  @RequirePermissions('segment.read')
  findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.segments.findOne(orgId, id);
  }

  @Patch('segments/:id')
  @RequirePermissions('segment.write')
  update(@Param('orgId') orgId: string, @Param('id') id: string, @Body() dto: Partial<CreateSegmentDto>) {
    return this.segments.update(orgId, id, dto);
  }

  @Delete('segments/:id')
  @RequirePermissions('segment.write')
  delete(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.segments.delete(orgId, id);
  }

  @Get('segments/:id/members')
  @RequirePermissions('segment.read')
  getMembers(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.segments.getMembers(orgId, id, page ? parseInt(page, 10) : undefined, pageSize ? parseInt(pageSize, 10) : undefined);
  }

  @Post('segments/:id/recompute')
  @RequirePermissions('segment.write')
  recompute(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.segments.recompute(orgId, id);
  }

  @Post('segments/:id/duplicate')
  @RequirePermissions('segment.write')
  duplicate(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.segments.duplicate(orgId, id);
  }

  @Post('churn-risk/recompute')
  @RequirePermissions('segment.write')
  recomputeChurnRisk(@Param('orgId') orgId: string) {
    return this.churnRisk.recomputeForOrganization(orgId);
  }

  @Get('customers/:customerId/churn-risk')
  @RequirePermissions('segment.read')
  getChurnRisk(@Param('orgId') orgId: string, @Param('customerId') customerId: string) {
    return this.churnRisk.getForCustomer(orgId, customerId);
  }
}
