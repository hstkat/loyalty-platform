import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RewardEngineService } from '../reward-engine/reward-engine.service';
import { WalletService } from '../wallet/wallet.service';
import { JourneyEngineService } from '../journeys/journey-engine.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { RefundTransactionDto, VoidTransactionDto } from './dto/refund-transaction.dto';

/**
 * Implements the core of Module 2 (Transactions & POS) for manual/generic
 * ingestion — i.e. the POST /transactions path described in the design
 * doc, section 5. Webhook adapters, polling, bulk/CSV import, and
 * reconciliation (sections 6, 12) are NOT implemented in this pass; see
 * the README for what's built vs. designed-only.
 *
 * The reward trigger (section 7) is implemented here as a direct,
 * synchronous call into RewardEngineService rather than a real event bus
 * — functionally equivalent for a single-process deployment, but a
 * production system should replace this with actual event publishing
 * once Module 3 (Wallet & Credit) and other consumers exist.
 */
@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private prisma: PrismaService,
    private rewardEngine: RewardEngineService,
    private wallet: WalletService,
    private journeyEngine: JourneyEngineService,
  ) {}

  async create(orgId: string, dto: CreateTransactionDto) {
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();

    // Als er een customerId is opgegeven, moet die daadwerkelijk bij
    // deze organisatie horen — anders meteen stoppen (fail fast), in
    // plaats van straks stilzwijgend door te gaan met een ongeldige
    // customerId totdat een diepere laag (wallet/reward-engine) het pas
    // toevallig tegenkomt.
    const customer = dto.customerId
      ? await this.prisma.customer.findFirst({ where: { id: dto.customerId, organizationId: orgId } })
      : null;
    if (dto.customerId && !customer) {
      throw new NotFoundException('Gast niet gevonden');
    }

    // De actieve spaarregels hangen alleen af van organizationId/
    // locationId/occurredAt — die zijn nu al bekend, dus deze opzoeking
    // kan gewoon parallel lopen met het wegschrijven van de transactie
    // hieronder, in plaats van er sequentieel op te wachten.
    const activeRulesPromise = customer
      ? this.rewardEngine.fetchActiveRules(orgId, dto.locationId, occurredAt)
      : null;

    const transaction = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          organizationId: orgId,
          locationId: dto.locationId,
          source: 'manual',
          externalTransactionId: dto.externalTransactionId,
          customerId: dto.customerId,
          tableReference: dto.tableReference,
          status: 'completed',
          grossAmount: dto.grossAmount,
          discountAmount: dto.discountAmount ?? 0,
          serviceAmount: dto.serviceAmount ?? 0,
          vatAmount: dto.vatAmount ?? 0,
          netAmount: dto.netAmount,
          totalAmount: dto.totalAmount,
          paymentMethod: dto.paymentMethod,
          occurredAt,
        },
      });

      if (dto.lineItems && dto.lineItems.length > 0) {
        await tx.transactionLineItem.createMany({
          data: dto.lineItems.map((item) => ({
            transactionId: created.id,
            description: item.description,
            category: item.category,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineGrossAmount: item.lineNetAmount,
            lineNetAmount: item.lineNetAmount,
            rewardEligible: item.rewardEligible ?? true,
          })),
        });
      }

      // Module 1 cache-field update (Module 2 design doc, section 9):
      // visitCount/lifetimeSpend/lastVisitAt etc. are denormalized on
      // Customer, updated here as the direct equivalent of consuming a
      // transaction.completed event.
      if (customer) {
        const newVisitCount = customer.visitCount + 1;
        const newLifetimeSpend = Number(customer.lifetimeSpend) + Number(dto.totalAmount);
        const newAverageSpend = newLifetimeSpend / newVisitCount;

        let newAverageVisitFrequencyDays = customer.averageVisitFrequencyDays;
        if (customer.lastVisitAt) {
          const daysSincePrevious = Math.max(
            1,
            Math.round((occurredAt.getTime() - customer.lastVisitAt.getTime()) / 86400000),
          );
          newAverageVisitFrequencyDays = customer.averageVisitFrequencyDays
            ? Math.round(
                (customer.averageVisitFrequencyDays * (newVisitCount - 2) + daysSincePrevious) / (newVisitCount - 1),
              )
            : daysSincePrevious;
        }

        await tx.customer.update({
          where: { id: customer.id },
          data: {
            visitCount: newVisitCount,
            lifetimeSpend: newLifetimeSpend,
            averageSpend: newAverageSpend,
            firstVisitAt: customer.firstVisitAt ?? occurredAt,
            lastVisitAt: occurredAt,
            averageVisitFrequencyDays: newAverageVisitFrequencyDays,
            favoriteLocationId: customer.favoriteLocationId ?? dto.locationId,
          },
        });
      }

      return created;
    });

    // Stage 0 (Module 4): eligible amount = sum of reward-eligible line
    // items, or the full net amount if no line items were provided.
    let eligibleAmount = Number(dto.netAmount);
    if (dto.lineItems && dto.lineItems.length > 0) {
      eligibleAmount = dto.lineItems
        .filter((item) => item.rewardEligible !== false)
        .reduce((sum, item) => sum + item.lineNetAmount, 0);
    }

    let rewardResult = null;
    if (customer && eligibleAmount > 0) {
      const activeRules = await activeRulesPromise!;
      rewardResult = await this.rewardEngine.calculate(
        {
          organizationId: orgId,
          transactionId: transaction.id,
          customerId: dto.customerId!,
          tierId: customer?.tierId ?? undefined,
          locationId: dto.locationId,
          eligibleAmount,
          occurredAt,
          isSimulation: false,
        },
        activeRules,
      );

      // Module 3 (Wallet & Credit): a positive reward becomes an `earn`
      // ledger entry — the direct in-process equivalent of Wallet & Credit
      // consuming a `reward.calculated` event (see Module 3 design doc,
      // section 2/11).
      if (rewardResult.finalRewardAmount > 0) {
        await this.wallet.recordEarn({
          organizationId: orgId,
          customerId: dto.customerId!,
          transactionId: transaction.id,
          amount: rewardResult.finalRewardAmount,
          occurredAt,
          rewardCalculationId: rewardResult.id,
        });
      }
    }

    // Module 8 (Automated Journeys): trigger any published journeys
    // listening for transaction.completed. Bewust NIET afgewacht (geen
    // `await`) — de punten zijn op dit moment al volledig bijgeschreven
    // (recordEarn hierboven is al klaar), dus de kassa hoeft nergens
    // meer op te wachten. Journey-verwerking kan een pushbericht
    // versturen (een externe netwerkaanroep, vaak de traagste stap in
    // deze hele keten) — dat mocht eerder de kassa laten wachten op iets
    // wat met de transactie zelf niets te maken heeft. Een eventuele
    // fout hier mag de transactie/puntenboeking nooit terugdraaien —
    // die is al veiliggesteld — dus alleen loggen, niet gooien.
    if (customer) {
      this.journeyEngine.handleEvent(orgId, 'transaction.completed', customer.id, transaction.id).catch((err) => {
        this.logger.error(
          `Journey-verwerking na transactie ${transaction.id} mislukt (transactie/punten zijn al veiliggesteld): ${err instanceof Error ? err.message : err}`,
        );
      });
    }

    return { transaction, reward: rewardResult };
  }

  async findAll(orgId: string, customerId?: string, status?: string) {
    return this.prisma.transaction.findMany({
      where: {
        organizationId: orgId,
        customerId: customerId || undefined,
        status: (status as never) || undefined,
      },
      orderBy: { occurredAt: 'desc' },
      take: 100,
    });
  }

  async findOne(orgId: string, id: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id, organizationId: orgId },
      include: { lineItems: true, refunds: true, voids: true, chargebacks: true, rewardCalculations: true },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');
    return transaction;
  }

  // Refund/void reward reversal (Module 2 section 8 / Module 4's
  // "reward reversal is proportional to the refunded amount"). This is a
  // simplified implementation: it records a reversal reward_calculation
  // with a negative finalRewardAmount, rather than replaying the full
  // multi-stage calculation on the reduced eligible amount. A production
  // build should recompute proportionally through all stages.
  async refund(orgId: string, transactionId: string, dto: RefundTransactionDto) {
    const transaction = await this.findOne(orgId, transactionId);

    const refund = await this.prisma.transactionRefund.create({
      data: {
        transactionId,
        refundType: dto.refundType,
        refundedAmount: dto.refundedAmount,
        reason: dto.reason,
        initiatedBy: 'manual_staff',
        occurredAt: new Date(),
      },
    });

    await this.prisma.transaction.update({
      where: { id: transactionId },
      data: { status: dto.refundType === 'full' ? 'refunded' : 'partially_refunded' },
    });

    const originalReward = transaction.rewardCalculations.find((r) => !r.isSimulation);
    let reversal = null;
    if (originalReward) {
      const proportion = dto.refundedAmount / Number(transaction.totalAmount);
      const reversalAmount = -Math.round(Number(originalReward.finalRewardAmount) * proportion * 100) / 100;

      reversal = await this.prisma.rewardCalculation.create({
        data: {
          organizationId: orgId,
          transactionId,
          customerId: transaction.customerId,
          eligibleAmount: 0,
          flatBonusTotal: 0,
          preCapTotal: reversalAmount,
          finalRewardAmount: reversalAmount,
          calculationTrace: [
            {
              stage: 'reversal',
              message: `Refund reversal: ${(proportion * 100).toFixed(1)}% van transactie -> €${reversalAmount.toFixed(2)}`,
            },
          ] as unknown as Prisma.InputJsonValue,
          appliedRuleIds: [] as unknown as Prisma.InputJsonValue,
          isSimulation: false,
        },
      });

      await this.prisma.rewardCalculation.update({
        where: { id: originalReward.id },
        data: { supersededByCorrectionId: reversal.id },
      });
    }

    return { refund, reversal };
  }

  async void(orgId: string, transactionId: string, dto: VoidTransactionDto) {
    const transaction = await this.findOne(orgId, transactionId);

    const voidRecord = await this.prisma.transactionVoid.create({
      data: { transactionId, reason: dto.reason, occurredAt: new Date() },
    });

    await this.prisma.transaction.update({ where: { id: transactionId }, data: { status: 'voided' } });

    // Full reversal, same mechanism as a 100% refund.
    return this.refund(orgId, transactionId, {
      refundType: 'full',
      refundedAmount: Number(transaction.totalAmount),
      reason: `Void: ${dto.reason}`,
    }).then((result) => ({ void: voidRecord, ...result }));
  }
}
