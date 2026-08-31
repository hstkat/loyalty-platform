import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReserveRedemptionDto, ManualAdjustmentDto } from './dto/wallet.dto';
import { ExchangeRateService } from './exchange-rate.service';

const RESERVATION_TTL_MS = 5 * 60 * 1000; // 5 minutes, per Module 3 design doc section 6
const DEFAULT_VALIDITY_DAYS = 60;

/**
 * Implements Module 3 (Wallet & Credit): the lot-based ledger, the earn
 * trigger from Module 4's reward calculations, and the two-phase
 * redemption flow (reserve -> confirm/cancel).
 *
 * Reservations live in the `wallet_redemption_reservations` table (not
 * an in-process Map) specifically because Vercel's serverless functions
 * don't share memory between invocations/instances — a Map-based
 * reservation could "disappear" between reserve and confirm, or fail to
 * recognize a retried idempotencyKey, if the two calls land on
 * different instances. The DB is the one thing every instance shares.
 */
@Injectable()
export class WalletService {

  constructor(
    private prisma: PrismaService,
    private exchangeRate: ExchangeRateService,
  ) {}

  private async getOrCreateWallet(orgId: string, customerId: string) {
    let wallet = await this.prisma.wallet.findUnique({ where: { customerId } });
    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: { organizationId: orgId, customerId },
      });
    }
    return wallet;
  }

  async getWallet(orgId: string, customerId: string) {
    const wallet = await this.getOrCreateWallet(orgId, customerId);
    return wallet;
  }

  async getLedger(orgId: string, customerId: string, page = 1, pageSize = 50) {
    const wallet = await this.getOrCreateWallet(orgId, customerId);
    return this.prisma.walletLedgerEntry.findMany({
      where: { walletId: wallet.id },
      orderBy: { occurredAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
  }

  async getLedgerEntry(orgId: string, customerId: string, entryId: string) {
    const wallet = await this.getOrCreateWallet(orgId, customerId);
    const entry = await this.prisma.walletLedgerEntry.findFirst({
      where: { id: entryId, walletId: wallet.id },
      include: {
        allocationsAsDebit: { include: { creditEntry: true } },
        allocationsAsCredit: { include: { debitEntry: true } },
      },
    });
    if (!entry) throw new NotFoundException('Ledger entry not found');
    return entry;
  }

  /**
   * Called after Module 4's Reward Engine produces a positive, non-
   * simulated reward for a completed transaction (Module 3 design doc,
   * section 2 & 11 — consumes what would be a `reward.calculated` event
   * on a real event bus; here it's a direct in-process call, same
   * simplification as Transactions -> RewardEngine).
   */
  async recordEarn(params: {
    organizationId: string;
    customerId: string;
    transactionId: string;
    amount: number;
    occurredAt: Date;
    rewardCalculationId?: string;
  }) {
    const wallet = await this.getOrCreateWallet(params.organizationId, params.customerId);

    const creditRule = await this.prisma.creditRule.findFirst({
      where: { organizationId: params.organizationId, isActive: true },
      orderBy: { locationId: 'asc' }, // location-specific (non-null) sorts after null alphabetically is not guaranteed; acceptable simplification for MVP
    });
    const validityDays = creditRule?.validityDays ?? DEFAULT_VALIDITY_DAYS;
    const expiresAt = new Date(params.occurredAt.getTime() + validityDays * 24 * 60 * 60 * 1000);

    const entry = await this.prisma.$transaction(async (tx) => {
      const created = await tx.walletLedgerEntry.create({
        data: {
          walletId: wallet.id,
          organizationId: params.organizationId,
          entryType: 'earn',
          amount: params.amount,
          remainingAmount: params.amount,
          status: 'available',
          source: 'system',
          transactionId: params.transactionId,
          rewardCalculationId: params.rewardCalculationId,
          performedByType: 'system',
          expiresAt,
          occurredAt: params.occurredAt,
        },
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalance: { increment: params.amount },
          lifetimeEarned: { increment: params.amount },
        },
      });

      return created;
    });

    return entry;
  }

  // -- Redemption: reserve / confirm / cancel (design doc section 6) -----

  /**
   * Points-mode helper: tells a checkout/POS how many wallet units
   * ("points") are needed to cover a given euro amount TODAY, using the
   * active RedemptionRateRule for the current day of week. Also reports
   * whether the customer's balance even meets the minimum-redemption
   * threshold. Purely informational — does not reserve anything.
   */
  async getRedemptionQuote(orgId: string, customerId: string, euroAmount: number, locationId?: string) {
    const wallet = await this.getOrCreateWallet(orgId, customerId);
    const pointsPerEuro = await this.exchangeRate.getPointsPerEuro(orgId, locationId);
    const pointsNeeded = Math.ceil(euroAmount * pointsPerEuro);

    const creditRule = await this.prisma.creditRule.findFirst({ where: { organizationId: orgId, isActive: true } });
    const minimumRedemptionBalance = creditRule?.minimumRedemptionBalance ? Number(creditRule.minimumRedemptionBalance) : null;
    const meetsMinimum = minimumRedemptionBalance === null || Number(wallet.availableBalance) >= minimumRedemptionBalance;

    return {
      euroAmount,
      pointsPerEuro,
      pointsNeeded,
      availablePoints: Number(wallet.availableBalance),
      minimumRedemptionBalance,
      meetsMinimum,
      canAfford: meetsMinimum && Number(wallet.availableBalance) >= pointsNeeded,
    };
  }

  async reserveRedemption(orgId: string, customerId: string, dto: ReserveRedemptionDto) {
    const existing = await this.prisma.walletRedemptionReservation.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: orgId, idempotencyKey: dto.idempotencyKey } },
    });
    if (existing && existing.status === 'active' && existing.expiresAt > new Date()) {
      return { reservationId: existing.id, amount: Number(existing.amount), replayed: true };
    }

    const wallet = await this.getOrCreateWallet(orgId, customerId);

    // Minimum redemption balance ("250 punten"-drempel): if configured,
    // the customer's TOTAL available balance must meet the threshold
    // before ANY redemption is allowed — even a partial one.
    const creditRule = await this.prisma.creditRule.findFirst({
      where: { organizationId: orgId, isActive: true },
    });
    if (creditRule?.minimumRedemptionBalance && Number(wallet.availableBalance) < Number(creditRule.minimumRedemptionBalance)) {
      throw new BadRequestException(
        `Minimum redemption balance not met: ${wallet.availableBalance} available, ${creditRule.minimumRedemptionBalance} required`,
      );
    }

    // Eligible lots: available, not expired, and NOT earned on the same
    // transaction the customer is currently paying (section 2: "pas
    // bruikbaar vanaf volgende bezoek").
    const eligibleLots = await this.prisma.walletLedgerEntry.findMany({
      where: {
        walletId: wallet.id,
        status: 'available',
        remainingAmount: { gt: 0 },
        expiresAt: { gt: new Date() },
        transactionId: { not: dto.transactionId },
      },
      orderBy: { expiresAt: 'asc' }, // FIFO: soonest-expiring lot first
    });

    const totalAvailable = eligibleLots.reduce((sum, lot) => sum + Number(lot.remainingAmount), 0);
    if (totalAvailable < dto.amount) {
      throw new BadRequestException(
        `Insufficient redeemable balance: available €${totalAvailable.toFixed(2)}, requested €${dto.amount.toFixed(2)}`,
      );
    }

    const lockedEntryIds: string[] = [];
    let remainingToCover = dto.amount;
    for (const lot of eligibleLots) {
      if (remainingToCover <= 0) break;
      lockedEntryIds.push(lot.id);
      remainingToCover -= Number(lot.remainingAmount);
    }

    // Lot-locking, balansmutatie én het aanmaken van de reservering
    // gebeuren in ÉÉN transactie: als twee gelijktijdige requests met
    // dezelfde idempotencyKey allebei hier voorbij de check hierboven
    // komen, botst de tweede op de unique-constraint op
    // (organizationId, idempotencyKey) en rolt Prisma de HELE transactie
    // terug — inclusief de lot-locks en balansmutatie van die tweede
    // poging. Zo kan een dubbele reservering nooit per ongeluk dubbel
    // saldo vasthouden.
    try {
      const reservation = await this.prisma.$transaction(async (tx) => {
        await tx.walletLedgerEntry.updateMany({
          where: { id: { in: lockedEntryIds } },
          data: { status: 'reserved' },
        });

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            availableBalance: { decrement: dto.amount },
            reservedBalance: { increment: dto.amount },
          },
        });

        return tx.walletRedemptionReservation.create({
          data: {
            organizationId: orgId,
            walletId: wallet.id,
            customerId,
            amount: dto.amount,
            lockedEntryIds,
            transactionId: dto.transactionId,
            idempotencyKey: dto.idempotencyKey,
            status: 'active',
            expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
          },
        });
      });

      return { reservationId: reservation.id, amount: dto.amount, expiresInSeconds: RESERVATION_TTL_MS / 1000, replayed: false };
    } catch (err) {
      // P2002 = unique constraint verbroken — een gelijktijdige request
      // met dezelfde idempotencyKey won de race. Geef diens reservering
      // terug in plaats van een verwarrende databasefout.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.walletRedemptionReservation.findUnique({
          where: { organizationId_idempotencyKey: { organizationId: orgId, idempotencyKey: dto.idempotencyKey } },
        });
        if (winner) return { reservationId: winner.id, amount: Number(winner.amount), replayed: true };
      }
      throw err;
    }
  }

  async confirmRedemption(
    orgId: string,
    customerId: string,
    reservationId: string,
    options?: { reason?: string; metadata?: Record<string, unknown> },
  ) {
    const reservation = await this.getActiveReservation(orgId, reservationId);
    const reservedAmount = Number(reservation.amount);

    const wallet = await this.getOrCreateWallet(orgId, customerId);

    const debitEntry = await this.prisma.$transaction(async (tx) => {
      const debit = await tx.walletLedgerEntry.create({
        data: {
          walletId: wallet.id,
          organizationId: orgId,
          entryType: 'redeem',
          amount: reservedAmount,
          source: 'pos',
          transactionId: reservation.transactionId,
          performedByType: 'staff',
          occurredAt: new Date(),
          reason: options?.reason,
          metadata: options?.metadata as never,
        },
      });

      let remainingToAllocate = reservedAmount;
      for (const lotId of reservation.lockedEntryIds) {
        if (remainingToAllocate <= 0) break;
        const lot = await tx.walletLedgerEntry.findUniqueOrThrow({ where: { id: lotId } });
        const lotRemaining = Number(lot.remainingAmount);
        const allocateAmount = Math.min(lotRemaining, remainingToAllocate);

        await tx.walletLedgerAllocation.create({
          data: { debitEntryId: debit.id, creditEntryId: lot.id, amount: allocateAmount },
        });

        const newLotRemaining = round2(lotRemaining - allocateAmount);
        await tx.walletLedgerEntry.update({
          where: { id: lot.id },
          data: {
            remainingAmount: newLotRemaining,
            status: newLotRemaining > 0 ? 'available' : 'redeemed',
          },
        });

        remainingToAllocate = round2(remainingToAllocate - allocateAmount);
      }

      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          reservedBalance: { decrement: reservedAmount },
          lifetimeRedeemed: { increment: reservedAmount },
        },
      });

      await tx.walletRedemptionReservation.update({
        where: { id: reservation.id },
        data: { status: 'confirmed' },
      });

      return debit;
    });

    return { redeemed: reservedAmount, ledgerEntryId: debitEntry.id };
  }

  async cancelRedemption(orgId: string, customerId: string, reservationId: string) {
    const reservation = await this.getActiveReservation(orgId, reservationId);
    const reservedAmount = Number(reservation.amount);
    const wallet = await this.getOrCreateWallet(orgId, customerId);

    await this.prisma.$transaction(async (tx) => {
      await tx.walletLedgerEntry.updateMany({
        where: { id: { in: reservation.lockedEntryIds } },
        data: { status: 'available' },
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalance: { increment: reservedAmount },
          reservedBalance: { decrement: reservedAmount },
        },
      });

      await tx.walletRedemptionReservation.update({
        where: { id: reservation.id },
        data: { status: 'cancelled' },
      });
    });

    return { cancelled: true };
  }

  /**
   * Haalt een actieve, nog niet verlopen reservering op uit de database
   * (niet uit geheugen — zie klasse-comment). Een verlopen reservering
   * wordt meteen als 'cancelled' gemarkeerd en de vastgehouden lots/
   * saldo teruggegeven, zodat een vergeten/nooit-bevestigde reservering
   * niet voor altijd saldo blokkeert.
   */
  private async getActiveReservation(orgId: string, reservationId: string) {
    const reservation = await this.prisma.walletRedemptionReservation.findFirst({ where: { id: reservationId, organizationId: orgId } });
    if (!reservation || reservation.status !== 'active') {
      throw new NotFoundException('Reservation not found or already expired');
    }
    if (reservation.expiresAt <= new Date()) {
      await this.prisma.$transaction(async (tx) => {
        await tx.walletLedgerEntry.updateMany({
          where: { id: { in: reservation.lockedEntryIds } },
          data: { status: 'available' },
        });
        await tx.wallet.update({
          where: { id: reservation.walletId },
          data: {
            availableBalance: { increment: Number(reservation.amount) },
            reservedBalance: { decrement: Number(reservation.amount) },
          },
        });
        await tx.walletRedemptionReservation.update({
          where: { id: reservation.id },
          data: { status: 'cancelled' },
        });
      });
      throw new BadRequestException('Reservation has expired');
    }
    return reservation;
  }

  // -- Manual adjustment (admin, section 12) ------------------------------

  async manualAdjustment(orgId: string, customerId: string, dto: ManualAdjustmentDto) {
    const wallet = await this.getOrCreateWallet(orgId, customerId);

    if (dto.amount > 0) {
      const entry = await this.prisma.$transaction(async (tx) => {
        const created = await tx.walletLedgerEntry.create({
          data: {
            walletId: wallet.id,
            organizationId: orgId,
            entryType: 'manual_adjustment',
            amount: dto.amount,
            remainingAmount: dto.amount,
            status: 'available',
            source: 'manual',
            performedByUserId: dto.performedByUserId,
            performedByType: 'staff',
            reason: dto.reason,
            expiresAt: new Date(Date.now() + DEFAULT_VALIDITY_DAYS * 24 * 60 * 60 * 1000),
            occurredAt: new Date(),
          },
        });
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { availableBalance: { increment: dto.amount }, lifetimeEarned: { increment: dto.amount } },
        });
        return created;
      });
      return entry;
    }

    // Negative adjustment: draw down existing lots FIFO, same mechanism
    // as a redemption, but booked as 'manual_adjustment' rather than
    // 'redeem', and with a mandatory reason.
    const absAmount = Math.abs(dto.amount);
    const eligibleLots = await this.prisma.walletLedgerEntry.findMany({
      where: { walletId: wallet.id, status: 'available', remainingAmount: { gt: 0 } },
      orderBy: { expiresAt: 'asc' },
    });
    const totalAvailable = eligibleLots.reduce((sum, lot) => sum + Number(lot.remainingAmount), 0);
    const amountToDeduct = Math.min(absAmount, totalAvailable);

    const debit = await this.prisma.$transaction(async (tx) => {
      const created = await tx.walletLedgerEntry.create({
        data: {
          walletId: wallet.id,
          organizationId: orgId,
          entryType: 'manual_adjustment',
          amount: amountToDeduct,
          source: 'manual',
          performedByUserId: dto.performedByUserId,
          performedByType: 'staff',
          reason: dto.reason,
          occurredAt: new Date(),
        },
      });

      let remaining = amountToDeduct;
      for (const lot of eligibleLots) {
        if (remaining <= 0) break;
        const lotRemaining = Number(lot.remainingAmount);
        const allocate = Math.min(lotRemaining, remaining);
        await tx.walletLedgerAllocation.create({
          data: { debitEntryId: created.id, creditEntryId: lot.id, amount: allocate },
        });
        const newRemaining = round2(lotRemaining - allocate);
        await tx.walletLedgerEntry.update({
          where: { id: lot.id },
          data: { remainingAmount: newRemaining, status: newRemaining > 0 ? 'available' : 'redeemed' },
        });
        remaining = round2(remaining - allocate);
      }

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { availableBalance: { decrement: amountToDeduct } },
      });

      return created;
    });

    return { ledgerEntryId: debit.id, deducted: amountToDeduct, requested: absAmount };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
