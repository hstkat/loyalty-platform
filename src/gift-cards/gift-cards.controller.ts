import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { GiftCardsService } from './gift-cards.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Ctx, RequestContext } from '../common/decorators/current-context.decorator';
import {
  IssueGiftCardDto,
  CreateBatchDto,
  ActivateGiftCardDto,
  RedeemGiftCardDto,
  TopUpGiftCardDto,
  BlockGiftCardDto,
  ReplaceGiftCardDto,
  AdjustGiftCardDto,
  RefundGiftCardDto,
} from './dto/gift-cards.dto';

@Controller('organizations/:orgId/gift-cards')
@UseGuards(PermissionsGuard)
export class GiftCardsController {
  constructor(private giftCards: GiftCardsService) {}

  @Post('issue')
  @RequirePermissions('gift_card.write')
  issue(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Body() dto: IssueGiftCardDto) {
    return this.giftCards.issue(orgId, ctx, dto);
  }

  @Post(':id/send')
  @RequirePermissions('gift_card.write')
  send(@Param('orgId') orgId: string, @Param('id') id: string, @Body() dto: { token: string }) {
    return this.giftCards.sendDigitalCard(orgId, id, dto.token);
  }

  @Post('batches')
  @RequirePermissions('gift_card.write')
  createBatch(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Body() dto: CreateBatchDto) {
    return this.giftCards.createBatch(orgId, ctx, dto);
  }

  @Get('batches')
  @RequirePermissions('gift_card.read')
  listBatches(@Param('orgId') orgId: string) {
    return this.giftCards.listBatches(orgId);
  }

  @Post('activate')
  @RequirePermissions('gift_card.write')
  activate(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Body() dto: ActivateGiftCardDto) {
    return this.giftCards.activate(orgId, ctx, dto);
  }

  @Post('redeem')
  @RequirePermissions('gift_card.redeem')
  redeem(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Body() dto: RedeemGiftCardDto) {
    return this.giftCards.redeem(orgId, ctx, dto);
  }

  @Get('lookup/:token')
  @RequirePermissions('gift_card.read')
  lookup(@Param('orgId') orgId: string, @Param('token') token: string) {
    return this.giftCards.lookupByToken(orgId, token);
  }

  @Get('report')
  @RequirePermissions('gift_card.read')
  getReport(@Param('orgId') orgId: string) {
    return this.giftCards.getReport(orgId);
  }

  @Get()
  @RequirePermissions('gift_card.read')
  listCards(@Param('orgId') orgId: string, @Query('status') status?: string, @Query('search') search?: string) {
    return this.giftCards.listCards(orgId, { status, search });
  }

  @Get(':id')
  @RequirePermissions('gift_card.read')
  getCardDetail(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.giftCards.getCardDetail(orgId, id);
  }

  @Post(':id/top-up')
  @RequirePermissions('gift_card.write')
  topUp(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: TopUpGiftCardDto) {
    return this.giftCards.topUp(orgId, ctx, id, dto);
  }

  @Post(':id/block')
  @RequirePermissions('gift_card.write')
  block(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: BlockGiftCardDto) {
    return this.giftCards.block(orgId, ctx, id, dto);
  }

  @Post(':id/replace')
  @RequirePermissions('gift_card.write')
  replace(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: ReplaceGiftCardDto) {
    return this.giftCards.replace(orgId, ctx, id, dto);
  }

  @Post(':id/adjust')
  @RequirePermissions('gift_card.write')
  adjust(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: AdjustGiftCardDto) {
    return this.giftCards.manualAdjustment(orgId, ctx, id, dto);
  }

  @Post(':id/refund')
  @RequirePermissions('gift_card.write')
  refund(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: RefundGiftCardDto) {
    return this.giftCards.refundLedgerEntry(orgId, ctx, id, dto);
  }
}
