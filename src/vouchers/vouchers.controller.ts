import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { VouchersService } from './vouchers.service';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Ctx } from '../common/decorators/current-context.decorator';
import type { RequestContext } from '../common/decorators/current-context.decorator';

class VoucherTemplateBodyDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsString()
  benefit!: string;

  @IsOptional()
  @IsString()
  terms?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  validityDays?: number;

  @IsOptional()
  @IsString()
  validFrom?: string;

  @IsOptional()
  @IsString()
  validUntil?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  locationIds?: string[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  reminderDaysBeforeExpiry?: number[];
}

class IssueVoucherBodyDto {
  @IsString()
  customerId!: string;

  @IsString()
  voucherTemplateId!: string;

  @IsOptional()
  @IsString()
  issueReason?: string;
}

class CancelVoucherBodyDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

class RedeemVoucherBodyDto {
  @IsString()
  secureToken!: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsString()
  transactionId?: string;
}

@Controller('organizations/:orgId/vouchers')
@UseGuards(PermissionsGuard)
export class VouchersController {
  constructor(private vouchers: VouchersService) {}

  // -- Templates --------------------------------------------------------

  @Get('templates')
  @RequirePermissions('voucher.read')
  listTemplates(@Param('orgId') orgId: string, @Query('includeInactive') includeInactive?: string) {
    return this.vouchers.listTemplates(orgId, includeInactive === 'true');
  }

  @Post('templates')
  @RequirePermissions('voucher.write')
  createTemplate(@Param('orgId') orgId: string, @Body() dto: VoucherTemplateBodyDto) {
    return this.vouchers.createTemplate(orgId, dto);
  }

  @Get('locations')
  @RequirePermissions('voucher.write')
  listLocations(@Param('orgId') orgId: string) {
    return this.vouchers.listLocations(orgId);
  }

  @Patch('templates/:templateId')
  @RequirePermissions('voucher.write')
  updateTemplate(@Param('orgId') orgId: string, @Param('templateId') templateId: string, @Body() dto: Partial<VoucherTemplateBodyDto>) {
    return this.vouchers.updateTemplate(orgId, templateId, dto);
  }

  // -- Uitgifte & klantprofiel-acties -------------------------------------

  @Post('issue')
  @RequirePermissions('voucher.write')
  issue(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Body() dto: IssueVoucherBodyDto) {
    return this.vouchers.issueVoucher(
      orgId,
      { customerId: dto.customerId, voucherTemplateId: dto.voucherTemplateId, issueReason: dto.issueReason, issueSource: 'manual' },
      { actorType: 'staff', actorId: ctx.actorId, ipAddress: ctx.ipAddress },
    );
  }

  @Get('customer/:customerId')
  @RequirePermissions('voucher.read')
  listForCustomer(@Param('orgId') orgId: string, @Param('customerId') customerId: string) {
    return this.vouchers.listForCustomerAdmin(orgId, customerId);
  }

  @Post(':voucherId/cancel')
  @RequirePermissions('voucher.write')
  cancel(@Param('orgId') orgId: string, @Param('voucherId') voucherId: string, @Ctx() ctx: RequestContext, @Body() dto: CancelVoucherBodyDto) {
    return this.vouchers.cancelVoucher(orgId, ctx.actorId ?? '', voucherId, dto.reason);
  }

  // -- POS-inwisseling ----------------------------------------------------

  @Get('lookup')
  @RequirePermissions('voucher.redeem')
  lookup(@Param('orgId') orgId: string, @Query('token') token: string) {
    return this.vouchers.lookupForRedemption(orgId, token);
  }

  @Post('redeem')
  @RequirePermissions('voucher.redeem')
  redeem(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Body() dto: RedeemVoucherBodyDto) {
    return this.vouchers.redeemVoucher(orgId, ctx.actorId ?? '', dto);
  }
}
