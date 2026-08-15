import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';

/**
 * On request: replaces the "enter any euro amount" redemption UX with
 * two more constrained, more accurate-to-the-original-program models:
 *
 * 1. Fixed-block redemption: points are redeemed in configurable
 *    increments (design doc example: 250, 500, 750...), never an
 *    arbitrary amount — matching the old points program's "250 punten
 *    per keer" mechanic exactly.
 * 2. Reward catalog: fixed items redeemable for a fixed point cost
 *    (e.g. "Gebakje bij de koffie — 100 punten"), independent of the
 *    day's exchange rate — a gift has one price, not a fluctuating one.
 */
@Injectable()
export class RewardCatalogService {
  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
  ) {}

  // -- Catalog management ---------------------------------------------------

  async listItems(orgId: string, activeOnly = false) {
    return this.prisma.rewardCatalogItem.findMany({
      where: { organizationId: orgId, isActive: activeOnly ? true : undefined },
      orderBy: { pointsCost: 'asc' },
    });
  }

  async createItem(orgId: string, dto: { name: string; description?: string; pointsCost: number; locationId?: string }) {
    return this.prisma.rewardCatalogItem.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        description: dto.description,
        pointsCost: dto.pointsCost,
        locationId: dto.locationId,
      },
    });
  }

  async updateItem(orgId: string, id: string, dto: Partial<{ name: string; description: string; pointsCost: number; isActive: boolean }>) {
    const item = await this.prisma.rewardCatalogItem.findFirst({ where: { id, organizationId: orgId } });
    if (!item) throw new NotFoundException('Reward catalog item not found');
    return this.prisma.rewardCatalogItem.update({ where: { id }, data: dto });
  }

  async deleteItem(orgId: string, id: string) {
    const item = await this.prisma.rewardCatalogItem.findFirst({ where: { id, organizationId: orgId } });
    if (!item) throw new NotFoundException('Reward catalog item not found');
    await this.prisma.rewardCatalogItem.delete({ where: { id } });
    return { deleted: true };
  }

  // -- Fixed-block redemption size (credit_rules.redemptionBlockSize) -------

  async getRedemptionBlockSize(orgId: string): Promise<number | null> {
    const rule = await this.prisma.creditRule.findFirst({ where: { organizationId: orgId, isActive: true } });
    return rule?.redemptionBlockSize ?? null;
  }

  // -- Redeem N fixed blocks (design doc: 250, 500, 750...) -----------------

  async redeemBlocks(
    orgId: string,
    customerId: string,
    blockCount: number,
    transactionId: string,
    idempotencyKey: string,
  ) {
    if (blockCount < 1 || !Number.isInteger(blockCount)) {
      throw new BadRequestException('blockCount must be a positive whole number');
    }
    const blockSize = await this.getRedemptionBlockSize(orgId);
    if (!blockSize) {
      throw new BadRequestException('Geen vaste inwissel-blokgrootte ingesteld voor deze organisatie');
    }

    const amount = blockCount * blockSize;
    const reservation = await this.wallet.reserveRedemption(orgId, customerId, { amount, transactionId, idempotencyKey });
    return this.wallet.confirmRedemption(orgId, customerId, reservation.reservationId, {
      reason: `${blockCount}x ${blockSize} punten-blok`,
    });
  }

  // -- Redeem a specific catalog item ----------------------------------------

  async redeemCatalogItem(
    orgId: string,
    customerId: string,
    catalogItemId: string,
    transactionId: string,
    idempotencyKey: string,
  ) {
    const item = await this.prisma.rewardCatalogItem.findFirst({
      where: { id: catalogItemId, organizationId: orgId, isActive: true },
    });
    if (!item) throw new NotFoundException('Cadeau niet gevonden of niet actief');

    const reservation = await this.wallet.reserveRedemption(orgId, customerId, {
      amount: item.pointsCost,
      transactionId,
      idempotencyKey,
    });
    const confirmation = await this.wallet.confirmRedemption(orgId, customerId, reservation.reservationId, {
      reason: `Cadeau: ${item.name}`,
    });
    return { ...confirmation, catalogItem: item };
  }
}
