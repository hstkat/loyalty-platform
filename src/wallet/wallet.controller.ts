import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { ReserveRedemptionDto, ManualAdjustmentDto } from './dto/wallet.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId/customers/:customerId/wallet')
@UseGuards(PermissionsGuard)
export class WalletController {
  constructor(private wallet: WalletService) {}

  @Get()
  @RequirePermissions('wallet.read')
  getWallet(@Param('orgId') orgId: string, @Param('customerId') customerId: string) {
    return this.wallet.getWallet(orgId, customerId);
  }

  @Get('ledger')
  @RequirePermissions('wallet.read')
  getLedger(
    @Param('orgId') orgId: string,
    @Param('customerId') customerId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.wallet.getLedger(
      orgId,
      customerId,
      page ? parseInt(page, 10) : undefined,
      pageSize ? parseInt(pageSize, 10) : undefined,
    );
  }

  @Get('ledger/:entryId')
  @RequirePermissions('wallet.read')
  getLedgerEntry(
    @Param('orgId') orgId: string,
    @Param('customerId') customerId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.wallet.getLedgerEntry(orgId, customerId, entryId);
  }

  @Post('redemptions/reserve')
  @RequirePermissions('wallet.redeem')
  reserve(@Param('orgId') orgId: string, @Param('customerId') customerId: string, @Body() dto: ReserveRedemptionDto) {
    return this.wallet.reserveRedemption(orgId, customerId, dto);
  }

  @Post('redemptions/:reservationId/confirm')
  @RequirePermissions('wallet.redeem')
  confirm(
    @Param('orgId') orgId: string,
    @Param('customerId') customerId: string,
    @Param('reservationId') reservationId: string,
  ) {
    return this.wallet.confirmRedemption(orgId, customerId, reservationId);
  }

  @Post('redemptions/:reservationId/cancel')
  @RequirePermissions('wallet.redeem')
  cancel(
    @Param('orgId') orgId: string,
    @Param('customerId') customerId: string,
    @Param('reservationId') reservationId: string,
  ) {
    return this.wallet.cancelRedemption(orgId, customerId, reservationId);
  }

  @Post('adjustments')
  @RequirePermissions('wallet.adjust')
  adjust(@Param('orgId') orgId: string, @Param('customerId') customerId: string, @Body() dto: ManualAdjustmentDto) {
    return this.wallet.manualAdjustment(orgId, customerId, dto);
  }
}
