import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from '../messaging/messaging.service';
import { WalletService } from '../wallet/wallet.service';
import { VouchersService } from '../vouchers/vouchers.service';

/**
 * Implements Module 8's flow execution engine (design doc sections 1, 5,
 * 6, 7). Nodes are executed synchronously in-process, one after another,
 * until a `wait` node pauses the enrollment (status -> 'waiting',
 * resumeAt set) or an `end` node completes it.
 *
 * SIMPLIFICATION vs. the design doc: `webhook` nodes are not implemented
 * (logged as a no-op success). `give_reward` now issues a voucher when
 * configured with `voucherTemplateId` (see VouchersService) — other
 * reward types remain a no-op. There's no real cron — `runScheduler()`
 * must be triggered externally (e.g. an actual scheduled job in
 * production, or manually via the API for this build pass). See README.
 */
@Injectable()
export class JourneyEngineService {
  private readonly logger = new Logger(JourneyEngineService.name);

  constructor(
    private prisma: PrismaService,
    private messaging: MessagingService,
    private wallet: WalletService,
    private vouchers: VouchersService,
  ) {}

  /**
   * Called whenever a platform event occurs (e.g. transaction.completed).
   * Finds all published journeys listening for this event, and enrolls
   * the customer — subject to duplicate-enrollment prevention (section 7).
   */
  async handleEvent(orgId: string, eventName: string, customerId: string, transactionId?: string) {
    const journeys = await this.prisma.journey.findMany({
      where: {
        organizationId: orgId,
        status: 'published',
        versions: { some: { publishedAt: { not: null }, triggerType: 'event', eventName } },
      },
      include: { versions: { where: { publishedAt: { not: null } }, orderBy: { versionNumber: 'desc' }, take: 1 } },
    });

    const enrollments = [];
    for (const journey of journeys) {
      const version = journey.versions[0];
      if (!version) continue;
      const enrollment = await this.enroll(orgId, journey.id, version.id, customerId, journey.reEnrollmentPolicy);
      if (enrollment) enrollments.push(enrollment);
    }
    return enrollments;
  }

  async enroll(
    orgId: string,
    journeyId: string,
    journeyVersionId: string,
    customerId: string,
    reEnrollmentPolicy: string,
  ) {
    // Duplicate-enrollment prevention (design doc section 7).
    const activeEnrollment = await this.prisma.journeyEnrollment.findFirst({
      where: { journeyId, customerId, status: { in: ['enrolled', 'executing', 'waiting'] } },
    });
    if (activeEnrollment) return null;

    if (reEnrollmentPolicy === 'once_ever') {
      const everCompleted = await this.prisma.journeyEnrollment.findFirst({
        where: { journeyId, customerId, status: { in: ['completed', 'goal_reached'] } },
      });
      if (everCompleted) return null;
    }

    const triggerNode = await this.prisma.journeyNode.findFirst({
      where: { journeyVersionId, nodeType: 'trigger' },
    });
    if (!triggerNode) return null;

    const enrollment = await this.prisma.journeyEnrollment.create({
      data: {
        journeyId,
        journeyVersionId,
        customerId,
        status: 'executing',
        currentNodeId: triggerNode.id,
      },
    });

    await this.runFrom(enrollment.id, triggerNode.id);
    return enrollment;
  }

  /** Executes nodes one after another until a wait/end/error interrupts the loop. */
  private async runFrom(enrollmentId: string, startNodeId: string) {
    let currentNodeId: string | null = startNodeId;

    while (currentNodeId) {
      const node = (await this.prisma.journeyNode.findUniqueOrThrow({
        where: { id: currentNodeId },
      })) as { id: string; nodeType: string; config: unknown };
      const enrollment = await this.prisma.journeyEnrollment.findUniqueOrThrow({ where: { id: enrollmentId } });

      let branchLabel: string | undefined;
      let stop = false;

      try {
        switch (node.nodeType) {
          case 'trigger':
            break;

          case 'send_push':
          case 'send_email':
          case 'send_sms': {
            const channel = node.nodeType.replace('send_', '');
            const config = node.config as { templateGroupKey?: string };
            const orgId = await this.getOrgId(enrollment.customerId);
            const result = await this.messaging.send(orgId, {
              sourceType: 'journey',
              sourceId: enrollment.journeyId,
              templateGroupKey: config.templateGroupKey ?? 'journey_message',
              customerIds: [enrollment.customerId],
              channel: channel as never,
            });
            await this.logExecution(enrollmentId, node.id, 'success', result as never);
            break;
          }

          case 'add_credit': {
            const config = node.config as { amount?: number };
            const wallet = await this.wallet.getWallet(await this.getOrgId(enrollment.customerId), enrollment.customerId);
            const result = await this.wallet.manualAdjustment(wallet.organizationId, enrollment.customerId, {
              amount: config.amount ?? 0,
              reason: `Journey bonus (enrollment ${enrollmentId})`,
            });
            await this.logExecution(enrollmentId, node.id, 'success', result as never);
            break;
          }

          case 'add_tag': {
            const config = node.config as { tagId?: string };
            if (config.tagId) {
              await this.prisma.customerTagMap.upsert({
                where: { customerId_tagId: { customerId: enrollment.customerId, tagId: config.tagId } },
                create: { customerId: enrollment.customerId, tagId: config.tagId },
                update: {},
              });
            }
            await this.logExecution(enrollmentId, node.id, 'success', {});
            break;
          }

          case 'change_tier': {
            const config = node.config as { tierId?: string };
            await this.prisma.customer.update({
              where: { id: enrollment.customerId },
              data: { tierId: config.tierId },
            });
            await this.logExecution(enrollmentId, node.id, 'success', {});
            break;
          }

          case 'condition': {
            const matched = await this.evaluateCondition(enrollment.customerId, node.config as never);
            branchLabel = matched ? 'yes' : 'no';
            await this.logExecution(enrollmentId, node.id, 'success', { matched });
            break;
          }

          case 'wait': {
            const config = node.config as { waitDurationDays?: number };
            const resumeAt = new Date(Date.now() + (config.waitDurationDays ?? 1) * 24 * 60 * 60 * 1000);
            await this.prisma.journeyEnrollment.update({
              where: { id: enrollmentId },
              data: { status: 'waiting', currentNodeId: node.id, resumeAt },
            });
            await this.logExecution(enrollmentId, node.id, 'success', { resumeAt });
            stop = true;
            break;
          }

          case 'split_test': {
            const config = node.config as { branches?: { label: string; percentage: number }[] };
            const branches = config.branches ?? [];
            const roll = Math.random() * 100;
            let cumulative = 0;
            let chosen = branches[0]?.label;
            for (const b of branches) {
              cumulative += b.percentage;
              if (roll <= cumulative) {
                chosen = b.label;
                break;
              }
            }
            await this.prisma.journeyEnrollment.update({
              where: { id: enrollmentId },
              data: { splitTestBranch: chosen },
            });
            branchLabel = chosen;
            await this.logExecution(enrollmentId, node.id, 'success', { chosen });
            break;
          }

          case 'give_reward': {
            // Nu geïmplementeerd voor vouchers (was voorheen een no-op —
            // zie klasse-comment): geeft een voucher-template uit aan de
            // gast in deze enrollment. Andere reward-types (bijv. iets
            // uit de puntenwinkel) blijven een no-op tot dat apart
            // gebouwd wordt.
            const config = node.config as { voucherTemplateId?: string };
            if (config.voucherTemplateId) {
              const orgId = await this.getOrgId(enrollment.customerId);
              const voucher = await this.vouchers.issueVoucher(
                orgId,
                { customerId: enrollment.customerId, voucherTemplateId: config.voucherTemplateId, journeyId: enrollment.journeyId, issueSource: 'journey', issueReason: `Journey (enrollment ${enrollmentId})` },
                { actorType: 'journey', actorId: enrollment.journeyId },
              );
              await this.logExecution(enrollmentId, node.id, 'success', { voucherId: voucher.id });
            } else {
              await this.logExecution(enrollmentId, node.id, 'success', { note: 'geen voucherTemplateId geconfigureerd, overgeslagen' });
            }
            break;
          }

          case 'webhook':
            // Not implemented in this build pass — see class-level note.
            await this.logExecution(enrollmentId, node.id, 'success', { note: 'not implemented, skipped' });
            break;

          case 'end':
            await this.prisma.journeyEnrollment.update({
              where: { id: enrollmentId },
              data: { status: 'completed', completedAt: new Date(), currentNodeId: node.id },
            });
            await this.logExecution(enrollmentId, node.id, 'success', {});
            stop = true;
            break;
        }
      } catch (err) {
        await this.logExecution(enrollmentId, node.id, 'failed', { error: (err as Error).message });
        await this.prisma.journeyEnrollment.update({
          where: { id: enrollmentId },
          data: { status: 'error', exitReason: (err as Error).message },
        });
        return;
      }

      if (stop) return;

      const nextEdge = (await this.prisma.journeyEdge.findFirst({
        where: { fromNodeId: node.id, branchLabel: branchLabel ?? undefined },
      })) as { toNodeId: string } | null;
      currentNodeId = nextEdge?.toNodeId ?? null;

      if (!currentNodeId) {
        await this.prisma.journeyEnrollment.update({
          where: { id: enrollmentId },
          data: { status: 'completed', completedAt: new Date() },
        });
      } else {
        await this.prisma.journeyEnrollment.update({ where: { id: enrollmentId }, data: { currentNodeId } });
      }
    }
  }

  /** Resumes all enrollments whose wait period has elapsed. Call periodically (design doc section 5). */
  async runScheduler() {
    const due = await this.prisma.journeyEnrollment.findMany({
      where: { status: 'waiting', resumeAt: { lte: new Date() } },
    });

    // Node- en edge-opzoekingen gebundeld i.p.v. per inschrijving apart —
    // veel inschrijvingen wachten vaak bij dezelfde journey-stap, dus dit
    // scheelt geregeld tientallen losse databaseaanroepen per cronrun.
    const uniqueNodeIds = Array.from(new Set(due.map((e) => e.currentNodeId).filter((id): id is string => !!id)));
    const nodes = uniqueNodeIds.length > 0 ? await this.prisma.journeyNode.findMany({ where: { id: { in: uniqueNodeIds } } }) : [];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const edges = uniqueNodeIds.length > 0 ? await this.prisma.journeyEdge.findMany({ where: { fromNodeId: { in: uniqueNodeIds } } }) : [];
    const edgeByFromNode = new Map(edges.map((e) => [e.fromNodeId, e]));

    for (const enrollment of due) {
      const waitNode = nodeMap.get(enrollment.currentNodeId!);
      if (!waitNode) continue; // zou niet moeten gebeuren (verwijzing naar niet-bestaande node), maar nooit de hele run laten crashen op één kapotte inschrijving
      const nextEdge = edgeByFromNode.get(waitNode.id);
      await this.prisma.journeyEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'executing' },
      });
      if (nextEdge) await this.runFrom(enrollment.id, nextEdge.toNodeId);
    }

    return { resumed: due.length };
  }

  private async evaluateCondition(customerId: string, config: { field?: string; operator?: string; value?: number }) {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    if (config.field === 'daysSinceLastVisit') {
      const days = customer.lastVisitAt ? Math.floor((Date.now() - customer.lastVisitAt.getTime()) / 86400000) : 9999;
      switch (config.operator) {
        case 'gt':
          return days > (config.value ?? 0);
        case 'lte':
          return days <= (config.value ?? 0);
        default:
          return false;
      }
    }
    return false;
  }

  private async logExecution(enrollmentId: string, nodeId: string, status: 'success' | 'failed', result: unknown) {
    await this.prisma.journeyNodeExecution.create({
      data: { enrollmentId, nodeId, status: status as never, result: result as never },
    });
  }

  private async getOrgId(customerId: string): Promise<string> {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    return customer.organizationId;
  }
}
