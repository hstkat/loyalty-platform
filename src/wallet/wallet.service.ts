import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReserveRedemptionDto, ManualAdjustmentDto } from './dto/wallet.dto';

interface PendingReservation {
  organizationId: string;
  walletId: string;
  amount: number;
  lockedEntryIds: string[];
  transactionId: string;
  idempotencyKey: string;
  createdAt: number;
}

const RESERVATION_TTL_MS = 5 * 60 * 1000; // 5 minutes, per Module 3 design doc section 6
const DEFAULT_VALIDITY_DAYS = 60;

/**
 * Implements Module 3 (Wallet & Credit): the lot-based ledger, the earn
 * trigger from Module 4's reward calculations, and the two-phase
 * redemption flow (reserve -> confirm/cancel).
 *
 * SIMPLIFICATION vs. the design doc: reservations are held in an
 * in-process Map rather than a persisted table/distributed lock. This
 * works correctly for a single server instance but will NOT survive a
 * restart or work across multiple instances — a production deployment
 * needs a real store (Redis, or a `wallet_redemption_reservations`
 * table) for this. Documented here and in the README.
 */
@Injectable()
export class WalletService {
  private reservations = new Map<string, PendingReservation>();
  private idempotencyIndex = new Map<string, string>(); // idempotencyKey -> reservationId

  constructor(private prisma: PrismaService) {}

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

  async reserveRedemption(orgId: string, customerId: string, dto: ReserveRedemptionDto) {
    const existingReservationId = this.idempotencyIndex.get(dto.idempotencyKey);
    if (existingReservationId && this.reservations.has(existingReservationId)) {
      return { reservationId: existingReservationId, amount: dto.amount, replayed: true };
    }

    const wallet = await this.getOrCreateWallet(orgId, customerId);

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

    await this.prisma.walletLedgerEntry.updateMany({
      where: { id: { in: lockedEntryIds } },
      data: { status: 'reserved' },
    });

    await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        availableBalance: { decrement: dto.amount },
        reservedBalance: { increment: dto.amount },
      },
    });

    const reservationId = crypto.randomUUID();
    this.reservations.set(reservationId, {
      organizationId: orgId,
      walletId: wallet.id,
      amount: dto.amount,
      lockedEntryIds,
      transactionId: dto.transactionId,
      idempotencyKey: dto.idempotencyKey,
      createdAt: Date.now(),
    });
    this.idempotencyIndex.set(dto.idempotencyKey, reservationId);

    return { reservationId, amount: dto.amount, expiresInSeconds: RESERVATION_TTL_MS / 1000, replayed: false };
  }

  async confirmRedemption(orgId: string, customerId: string, reservationId: string) {
    const reservation = this.getActiveReservation(reservationId);

    const wallet = await this.getOrCreateWallet(orgId, customerId);

    const debitEntry = await this.prisma.$transaction(async (tx) => {
      const debit = await tx.walletLedgerEntry.create({
        data: {
          walletId: wallet.id,
          organizationId: orgId,
          entryType: 'redeem',
          amount: reservation.amount,
          source: 'pos',
          transactionId: reservation.transactionId,
          performedByType: 'staff',
          occurredAt: new Date(),
        },
      });

      let remainingToAllocate = reservation.amount;
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
          reservedBalance: { decrement: reservation.amount },
          lifetimeRedeemed: { increment: reservation.amount },
        },
      });

      return debit;
    });

    this.releaseReservation(reservationId);
    return { redeemed: reservation.amount, ledgerEntryId: debitEntry.id };
  }

  async cancelRedemption(orgId: string, customerId: string, reservationId: string) {
    const reservation = this.getActiveReservation(reservationId);
    const wallet = await this.getOrCreateWallet(orgId, customerId);

    await this.prisma.walletLedgerEntry.updateMany({
      where: { id: { in: reservation.lockedEntryIds } },
      data: { status: 'available' },
    });

    await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        availableBalance: { increment: reservation.amount },
        reservedBalance: { decrement: reservation.amount },
      },
    });

    this.releaseReservation(reservationId);
    return { cancelled: true };
  }

  private getActiveReservation(reservationId: string): PendingReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new NotFoundException('Reservation not found or already expired');
    if (Date.now() - reservation.createdAt > RESERVATION_TTL_MS) {
      this.reservations.delete(reservationId);
      throw new BadRequestException('Reservation has expired');
    }
    return reservation;
  }

  private releaseReservation(reservationId: string) {
    const reservation = this.reservations.get(reservationId);
    if (reservation) this.idempotencyIndex.delete(reservation.idempotencyKey);
    this.reservations.delete(reservationId);
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
