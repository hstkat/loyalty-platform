import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { OccupancyService } from './occupancy.service';
import { CreateReservationDto, CreateCapacitySettingDto, CreateWeatherForecastDto } from './dto/occupancy.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId')
@UseGuards(PermissionsGuard)
export class OccupancyController {
  constructor(private occupancy: OccupancyService) {}

  @Post('reservations')
  @RequirePermissions('reservation.write')
  createReservation(@Param('orgId') orgId: string, @Body() dto: CreateReservationDto) {
    return this.occupancy.createReservation(orgId, dto);
  }

  @Get('reservations')
  @RequirePermissions('reservation.read')
  listReservations(@Param('orgId') orgId: string, @Query('locationId') locationId?: string) {
    return this.occupancy.listReservations(orgId, locationId);
  }

  @Patch('reservations/:id/status')
  @RequirePermissions('reservation.write')
  updateStatus(@Param('orgId') orgId: string, @Param('id') id: string, @Body('status') status: string) {
    return this.occupancy.updateReservationStatus(orgId, id, status);
  }

  @Post('location-capacity-settings')
  @RequirePermissions('reservation.write')
  createCapacitySetting(@Param('orgId') orgId: string, @Body() dto: CreateCapacitySettingDto) {
    return this.occupancy.createCapacitySetting(orgId, dto);
  }

  @Get('locations/:locationId/capacity-settings')
  @RequirePermissions('reservation.read')
  listCapacitySettings(@Param('orgId') orgId: string, @Param('locationId') locationId: string) {
    return this.occupancy.listCapacitySettings(orgId, locationId);
  }

  @Post('weather-forecasts')
  @RequirePermissions('reservation.write')
  createWeatherForecast(@Param('orgId') orgId: string, @Body() dto: CreateWeatherForecastDto) {
    return this.occupancy.createWeatherForecast(orgId, dto);
  }

  @Get('locations/:locationId/occupancy')
  @RequirePermissions('reservation.read')
  getOccupancy(
    @Param('locationId') locationId: string,
    @Query('date') date: string,
    @Query('servicePeriod') servicePeriod: string,
    @Query('area') area?: string,
  ) {
    return this.occupancy.getOccupancy(locationId, date, servicePeriod, area);
  }

  @Post('locations/:locationId/occupancy/forecast')
  @RequirePermissions('reservation.write')
  computeForecast(
    @Param('orgId') orgId: string,
    @Param('locationId') locationId: string,
    @Body() body: { date: string; servicePeriod: string; area?: string },
  ) {
    return this.occupancy.computeForecast(orgId, locationId, body.date, body.servicePeriod, body.area);
  }

  @Post('occupancy-opportunities/detect')
  @RequirePermissions('reservation.write')
  detectOpportunity(
    @Param('orgId') orgId: string,
    @Body() body: { locationId: string; forecastRunId: string },
  ) {
    return this.occupancy.detectOpportunity(orgId, body.locationId, body.forecastRunId);
  }

  @Get('occupancy-recommendations')
  @RequirePermissions('reservation.read')
  listRecommendations(@Param('orgId') orgId: string, @Query('status') status?: string) {
    return this.occupancy.listRecommendations(orgId, status);
  }

  @Get('occupancy-recommendations/:id')
  @RequirePermissions('reservation.read')
  getRecommendation(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.occupancy.getRecommendation(orgId, id);
  }

  @Post('occupancy-recommendations/:id/approve')
  @RequirePermissions('campaign.launch')
  approveRecommendation(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.occupancy.approveRecommendation(orgId, id);
  }

  @Post('occupancy-recommendations/:id/dismiss')
  @RequirePermissions('reservation.write')
  dismissRecommendation(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.occupancy.dismissRecommendation(orgId, id);
  }
}
