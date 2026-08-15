import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId')
@UseGuards(PermissionsGuard)
export class CreditRulesController {
  constructor(private prisma: PrismaService) {}

  @Get('credit-rules')
  @RequirePermissions('credit_rules.read')
  listCreditRules(@Param('orgId') orgId: string) {
    return this.prisma.creditRule.findMany({ where: { organizationId: orgId } });
  }

  @Post('credit-rules')
  @RequirePermissions('credit_rules.write')
  createCreditRule(@Param('orgId') orgId: string, @Body() dto: Record<string, unknown>) {
    return this.prisma.creditRule.create({ data: { organizationId: orgId, ...dto } as never });
  }

  @Get('redemption-rate-rules')
  @RequirePermissions('credit_rules.read')
  listRateRules(@Param('orgId') orgId: string) {
    return this.prisma.redemptionRateRule.findMany({ where: { organizationId: orgId } });
  }

  // Voorbeeld body voor het oude puntensysteem, exact gereproduceerd:
  // { "name": "Weekdagen", "appliesOnDays": ["monday","tuesday","wednesday","thursday"], "pointsPerEuro": 25 }
  // { "name": "Weekend",   "appliesOnDays": ["friday","saturday","sunday"],               "pointsPerEuro": 50 }
  @Post('redemption-rate-rules')
  @RequirePermissions('credit_rules.write')
  createRateRule(@Param('orgId') orgId: string, @Body() dto: Record<string, unknown>) {
    return this.prisma.redemptionRateRule.create({ data: { organizationId: orgId, ...dto } as never });
  }
}
