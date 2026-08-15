import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeRateService } from './exchange-rate.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId')
@UseGuards(PermissionsGuard)
export class CreditRulesController {
  constructor(
    private prisma: PrismaService,
    private exchangeRate: ExchangeRateService,
  ) {}

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

  // Aggregate, customer-independent "what's today's rate" — used by the
  // backoffice dashboard to show an approximate euro-equivalent for a
  // points-based outstanding-credit total, without needing a specific
  // customer's wallet.
  @Get('redemption-rate/today')
  @RequirePermissions('credit_rules.read')
  async getTodayRate(@Param('orgId') orgId: string) {
    const pointsPerEuro = await this.exchangeRate.getPointsPerEuro(orgId);
    return { pointsPerEuro, isPointsMode: pointsPerEuro !== 1 };
  }
}
