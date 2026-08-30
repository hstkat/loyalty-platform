import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { FinancialReportsService } from './financial-reports.service';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { ReportPeriodType } from './dto/financial-reports.dto';

@Controller('organizations/:orgId/financial-reports')
@UseGuards(PermissionsGuard)
@RequirePermissions('finance.read')
export class FinancialReportsController {
  constructor(private reports: FinancialReportsService) {}

  @Get('summary')
  getSummary(
    @Param('orgId') orgId: string,
    @Query('periodType') periodType: ReportPeriodType,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('locationId') locationId: string | undefined,
    @Req() req: { staffContext?: { actorId: string | null } },
  ) {
    return this.reports.getSummary(orgId, { periodType, from, to, locationId }, req.staffContext?.actorId ?? undefined);
  }

  @Get('gift-card-details')
  getGiftCardDetails(
    @Param('orgId') orgId: string,
    @Query('periodType') periodType: ReportPeriodType,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('locationId') locationId: string | undefined,
    @Query('page') page: string | undefined,
  ) {
    return this.reports.getGiftCardDetails(orgId, { periodType, from, to, locationId }, page ? parseInt(page, 10) : 1);
  }

  @Get('loyalty-details')
  getLoyaltyDetails(
    @Param('orgId') orgId: string,
    @Query('periodType') periodType: ReportPeriodType,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('locationId') locationId: string | undefined,
    @Query('page') page: string | undefined,
  ) {
    return this.reports.getLoyaltyDetails(orgId, { periodType, from, to, locationId }, page ? parseInt(page, 10) : 1);
  }

  @Get('history')
  getHistory(@Param('orgId') orgId: string) {
    return this.reports.getHistory(orgId);
  }

  @Get('export/excel')
  async exportExcel(
    @Param('orgId') orgId: string,
    @Query('periodType') periodType: ReportPeriodType,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('locationId') locationId: string | undefined,
    @Req() req: { staffContext?: { actorId: string | null } },
    @Res() res: Response,
  ) {
    const buffer = await this.reports.generateExcelBuffer(orgId, { periodType, from, to, locationId }, req.staffContext?.actorId ?? undefined);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="financieel-rapport-${periodType}.xlsx"`);
    res.send(buffer);
  }

  @Get('export/pdf')
  async exportPdf(
    @Param('orgId') orgId: string,
    @Query('periodType') periodType: ReportPeriodType,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('locationId') locationId: string | undefined,
    @Req() req: { staffContext?: { actorId: string | null } },
    @Res() res: Response,
  ) {
    const buffer = await this.reports.generatePdfBuffer(orgId, { periodType, from, to, locationId }, req.staffContext?.actorId ?? undefined);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="financieel-rapport-${periodType}.pdf"`);
    res.send(buffer);
  }
}
