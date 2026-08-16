import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

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
 *
 * Catalog items optionally support day-of-week and/or date-range
 * availability (e.g. "only Mon/Tue for 4 weeks", or "only Aug 31st").
 * The same isCurrentlyAvailable() check runs BOTH when listing items for
 * the kassa AND at actual redemption time — never trust a possibly-stale
 * client-side list as the source of truth for something that spends
 * real points.
 */
@Injectable()
export class RewardCatalogService {
  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
  ) {}

  // -- Catalog management ---------------------------------------------------

  async listItems(orgId: string, activeOnly = false, currentlyAvailableOnly = false) {
    const items = await this.prisma.rewardCatalogItem.findMany({
      where: { organizationId: orgId, isActive: activeOnly ? true : undefined },
      orderBy: { pointsCost: 'asc' },
    });

    const withAvailability = items.map((item) => ({
      ...item,
      isCurrentlyAvailable: this.isCurrentlyAvailable(item),
    }));

    return currentlyAvailableOnly ? withAvailability.filter((i) => i.isCurrentlyAvailable) : withAvailability;
  }

  async createItem(
    orgId: string,
    dto: {
      name: string;
      description?: string;
      pointsCost: number;
      locationId?: string;
      availableDays?: string[];
      validFrom?: string;
      validUntil?: string;
    },
  ) {
    return this.prisma.rewardCatalogItem.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        description: dto.description,
        pointsCost: dto.pointsCost,
        locationId: dto.locationId,
        availableDays: dto.availableDays as never,
        validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
      },
    });
  }

  async updateItem(
    orgId: string,
    id: string,
    dto: Partial<{
      name: string;
      description: string;
      pointsCost: number;
      isActive: boolean;
      availableDays: string[] | null;
      validFrom: string | null;
      validUntil: string | null;
    }>,
  ) {
    const item = await this.prisma.rewardCatalogItem.findFirst({ where: { id, organizationId: orgId } });
    if (!item) throw new NotFoundException('Reward catalog item not found');

    const data: Record<string, unknown> = { ...dto };
    if ('validFrom' in dto) data.validFrom = dto.validFrom ? new Date(dto.validFrom) : null;
    if ('validUntil' in dto) data.validUntil = dto.validUntil ? new Date(dto.validUntil) : null;

    return this.prisma.rewardCatalogItem.update({ where: { id }, data: data as never });
  }

  async deleteItem(orgId: string, id: string) {
    const item = await this.prisma.rewardCatalogItem.findFirst({ where: { id, organizationId: orgId } });
    if (!item) throw new NotFoundException('Reward catalog item not found');
    await this.prisma.rewardCatalogItem.delete({ where: { id } });
    return { deleted: true };
  }

  // -- Availability check (day-of-week + date range), shared by list & redeem --

  private isCurrentlyAvailable(item: { availableDays: unknown; validFrom: Date | null; validUntil: Date | null }, now: Date = new Date()): boolean {
    if (item.validFrom && now < item.validFrom) return false;
    if (item.validUntil) {
      const endOfDay = new Date(item.validUntil);
      endOfDay.setUTCHours(23, 59, 59, 999);
      if (now > endOfDay) return false;
    }
    if (item.availableDays) {
      const days = item.availableDays as string[];
      if (days.length > 0 && !days.includes(WEEKDAYS[now.getUTCDay()])) return false;
    }
    return true;
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
    if (!this.isCurrentlyAvailable(item)) {
      throw new BadRequestException('Dit cadeau is vandaag niet beschikbaar (dag- of periodebeperking)');
    }

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
