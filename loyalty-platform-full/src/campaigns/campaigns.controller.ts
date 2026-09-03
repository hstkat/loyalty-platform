import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto, PreviewCampaignDto } from './dto/campaign.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId/campaigns')
@UseGuards(PermissionsGuard)
export class CampaignsController {
  constructor(private campaigns: CampaignsService) {}

  @Post()
  @RequirePermissions('campaign.write')
  create(@Param('orgId') orgId: string, @Body() dto: CreateCampaignDto) {
    return this.campaigns.create(orgId, dto);
  }

  @Get()
  @RequirePermissions('campaign.read')
  findAll(@Param('orgId') orgId: string, @Query('status') status?: string) {
    return this.campaigns.findAll(orgId, status);
  }

  @Post('preview')
  @RequirePermissions('campaign.read')
  preview(@Param('orgId') orgId: string, @Body() dto: PreviewCampaignDto) {
    return this.campaigns.preview(orgId, dto);
  }

  @Get(':id')
  @RequirePermissions('campaign.read')
  findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.campaigns.findOne(orgId, id);
  }

  @Patch(':id')
  @RequirePermissions('campaign.write')
  update(@Param('orgId') orgId: string, @Param('id') id: string, @Body() dto: Partial<CreateCampaignDto>) {
    return this.campaigns.update(orgId, id, dto);
  }

  @Post(':id/launch')
  @RequirePermissions('campaign.launch')
  launch(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.campaigns.launch(orgId, id);
  }

  @Post(':id/pause')
  @RequirePermissions('campaign.write')
  pause(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.campaigns.pause(orgId, id);
  }

  @Post(':id/resume')
  @RequirePermissions('campaign.write')
  resume(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.campaigns.resume(orgId, id);
  }

  @Post(':id/cancel')
  @RequirePermissions('campaign.write')
  cancel(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.campaigns.cancel(orgId, id);
  }

  @Get(':id/results')
  @RequirePermissions('campaign.read')
  results(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.campaigns.results(orgId, id);
  }
}
