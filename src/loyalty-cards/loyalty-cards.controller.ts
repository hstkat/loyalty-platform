import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { LoyaltyCardsService } from './loyalty-cards.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Ctx, RequestContext } from '../common/decorators/current-context.decorator';
import { CreateBatchDto, AdminLinkCardDto, BlockCardDto, ReplaceCardDto } from './dto/loyalty-cards.dto';

@Controller('organizations/:orgId/loyalty-cards')
@UseGuards(PermissionsGuard)
export class LoyaltyCardsController {
  constructor(private cards: LoyaltyCardsService) {}

  @Post('batches')
  @RequirePermissions('loyalty_card.write')
  createBatch(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Body() dto: CreateBatchDto) {
    return this.cards.createBatch(orgId, ctx, dto);
  }

  @Get('batches')
  @RequirePermissions('loyalty_card.read')
  listBatches(@Param('orgId') orgId: string) {
    return this.cards.listBatches(orgId);
  }

  @Get()
  @RequirePermissions('loyalty_card.read')
  listCards(
    @Param('orgId') orgId: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('search') search?: string,
  ) {
    return this.cards.listCards(orgId, { status, customerId, search });
  }

  @Get(':cardId')
  @RequirePermissions('loyalty_card.read')
  getCardDetail(@Param('orgId') orgId: string, @Param('cardId') cardId: string) {
    return this.cards.getCardDetail(orgId, cardId);
  }

  @Post('link')
  @RequirePermissions('loyalty_card.write')
  adminLinkCard(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Body() dto: AdminLinkCardDto) {
    return this.cards.adminLinkCard(orgId, ctx, dto);
  }

  @Get('pos/lookup/:token')
  @RequirePermissions('loyalty_card.read')
  posLookup(@Param('orgId') orgId: string, @Param('token') token: string, @Query('amount') amount?: string) {
    return this.cards.posLookup(orgId, token, amount ? parseFloat(amount) : undefined);
  }

  @Post(':cardId/block')
  @RequirePermissions('loyalty_card.write')
  blockCard(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Param('cardId') cardId: string, @Body() dto: BlockCardDto) {
    return this.cards.blockCard(orgId, ctx, cardId, dto);
  }

  @Post(':cardId/mark-lost')
  @RequirePermissions('loyalty_card.write')
  markLost(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Param('cardId') cardId: string, @Body() dto: BlockCardDto) {
    return this.cards.markLost(orgId, ctx, cardId, dto);
  }

  @Post(':cardId/reactivate')
  @RequirePermissions('loyalty_card.write')
  reactivate(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Param('cardId') cardId: string) {
    return this.cards.reactivate(orgId, ctx, cardId);
  }

  @Post(':cardId/replace')
  @RequirePermissions('loyalty_card.write')
  replaceCard(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Param('cardId') cardId: string, @Body() dto: ReplaceCardDto) {
    return this.cards.replaceCard(orgId, ctx, cardId, dto);
  }

  @Post(':cardId/pending-earn')
  @RequirePermissions('loyalty_card.write')
  addPendingEarn(
    @Param('orgId') orgId: string,
    @Param('cardId') cardId: string,
    @Body() dto: { amount: number; reason?: string },
  ) {
    return this.cards.addPendingEarn(orgId, cardId, dto.amount, dto.reason);
  }
}
