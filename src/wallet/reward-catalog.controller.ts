import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RewardCatalogService } from './reward-catalog.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId')
@UseGuards(PermissionsGuard)
export class RewardCatalogController {
  constructor(private catalog: RewardCatalogService) {}

  @Get('reward-catalog')
  @RequirePermissions('credit_rules.read')
  listItems(@Param('orgId') orgId: string, @Query('activeOnly') activeOnly?: string) {
    return this.catalog.listItems(orgId, activeOnly === 'true');
  }

  @Post('reward-catalog')
  @RequirePermissions('credit_rules.write')
  createItem(@Param('orgId') orgId: string, @Body() dto: { name: string; description?: string; pointsCost: number; locationId?: string }) {
    return this.catalog.createItem(orgId, dto);
  }

  @Patch('reward-catalog/:id')
  @RequirePermissions('credit_rules.write')
  updateItem(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Body() dto: Partial<{ name: string; description: string; pointsCost: number; isActive: boolean }>,
  ) {
    return this.catalog.updateItem(orgId, id, dto);
  }

  @Delete('reward-catalog/:id')
  @RequirePermissions('credit_rules.write')
  deleteItem(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.catalog.deleteItem(orgId, id);
  }

  @Get('redemption-block-size')
  @RequirePermissions('credit_rules.read')
  async getBlockSize(@Param('orgId') orgId: string) {
    const blockSize = await this.catalog.getRedemptionBlockSize(orgId);
    return { blockSize };
  }

  @Post('customers/:customerId/wallet/redeem-blocks')
  @RequirePermissions('wallet.redeem')
  redeemBlocks(
    @Param('orgId') orgId: string,
    @Param('customerId') customerId: string,
    @Body() dto: { blockCount: number; transactionId: string; idempotencyKey: string },
  ) {
    return this.catalog.redeemBlocks(orgId, customerId, dto.blockCount, dto.transactionId, dto.idempotencyKey);
  }

  @Post('customers/:customerId/wallet/redeem-catalog-item')
  @RequirePermissions('wallet.redeem')
  redeemCatalogItem(
    @Param('orgId') orgId: string,
    @Param('customerId') customerId: string,
    @Body() dto: { catalogItemId: string; transactionId: string; idempotencyKey: string },
  ) {
    return this.catalog.redeemCatalogItem(orgId, customerId, dto.catalogItemId, dto.transactionId, dto.idempotencyKey);
  }
}
