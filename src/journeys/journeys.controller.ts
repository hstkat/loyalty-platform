import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JourneysService } from './journeys.service';
import { JourneyEngineService } from './journey-engine.service';
import { CreateJourneyDto, TestJourneyDto } from './dto/journey.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId/journeys')
@UseGuards(PermissionsGuard)
export class JourneysController {
  constructor(
    private journeys: JourneysService,
    private engine: JourneyEngineService,
  ) {}

  @Post()
  @RequirePermissions('journey.write')
  create(@Param('orgId') orgId: string, @Body() dto: CreateJourneyDto) {
    return this.journeys.create(orgId, dto);
  }

  @Get()
  @RequirePermissions('journey.read')
  findAll(@Param('orgId') orgId: string, @Query('status') status?: string) {
    return this.journeys.findAll(orgId, status);
  }

  @Get(':id')
  @RequirePermissions('journey.read')
  findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.journeys.findOne(orgId, id);
  }

  @Post(':id/publish')
  @RequirePermissions('journey.publish')
  publish(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.journeys.publish(orgId, id);
  }

  @Post(':id/pause')
  @RequirePermissions('journey.pause')
  pause(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.journeys.pause(orgId, id);
  }

  @Post(':id/resume')
  @RequirePermissions('journey.pause')
  resume(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.journeys.resume(orgId, id);
  }

  @Post(':id/stop')
  @RequirePermissions('journey.stop')
  stop(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.journeys.stop(orgId, id);
  }

  @Get(':id/enrollments')
  @RequirePermissions('journey.read')
  getEnrollments(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.journeys.getEnrollments(orgId, id);
  }

  @Post(':id/test')
  @RequirePermissions('journey.write')
  test(@Param('orgId') orgId: string, @Param('id') id: string, @Body() dto: TestJourneyDto) {
    return this.journeys.test(orgId, id, dto.customerId);
  }

  @Post('scheduler/run')
  @RequirePermissions('journey.write')
  runScheduler() {
    return this.engine.runScheduler();
  }
}
