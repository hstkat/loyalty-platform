import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { renderTemplate } from './template-renderer';
import { SendMessageDto } from './dto/messaging.dto';
import { MailgunService } from '../common/mailgun.service';
import { WhatsAppService } from '../common/whatsapp.service';
import { PushNotificationService } from '../common/push-notification.service';

const DEFAULT_FREQUENCY_CAP = { maxMessages: 2, periodDays: 7 }; // marketing default, section 7

/**
 * Implements Module 6's core Message Service (design doc section 1, 6, 7).
 *
 * SIMPLIFICATION vs. the design doc: there are no real provider adapters
 * (APNs/FCM/Postmark/Twilio) — a "send" is simulated by creating the
 * message_queue_items row with status 'sent' directly. Quiet hours
 * (section 8) and real retries (section 11) are NOT implemented in this
 * pass. Consent and frequency-cap enforcement (sections 6-7) ARE real,
 * checked against actual Module 1 data. See README for full scope notes.
 */
@Injectable()
export class MessagingService {
  constructor(
    private prisma: PrismaService,
    private mailgun: MailgunService,
    private whatsapp: WhatsAppService,
    private pushNotification: PushNotificationService,
  ) {}

  async send(orgId: string, dto: SendMessageDto) {
    const sendRequest = await this.prisma.messageSendRequest.create({
      data: {
        organizationId: orgId,
        sourceType: dto.sourceType,
        sourceId: dto.sourceId,
        templateGroupKey: dto.templateGroupKey,
      },
    });

    const results = [];
    for (const customerId of dto.customerIds) {
      const result = await this.sendToCustomer(orgId, sendRequest.id, customerId, dto.templateGroupKey, dto.channel);
      results.push(result);
    }

    return { sendRequestId: sendRequest.id, results };
  }

  private async sendToCustomer(
    orgId: string,
    sendRequestId: string,
    customerId: string,
    templateGroupKey: string,
    channel: string,
  ) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId: orgId },
      include: { wallet: true, consents: true, favoriteLocation: true },
    });
    if (!customer) return { customerId, status: 'skipped_no_channel', reason: 'customer not found' };

    const template = await this.prisma.messageTemplate.findFirst({
      where: {
        templateGroupKey,
        channel: channel as never,
        isActive: true,
        OR: [{ organizationId: orgId }, { organizationId: null }],
        locale: customer.language,
      },
      orderBy: { organizationId: 'desc' }, // prefer org-specific over platform default
    });
    const resolvedTemplate =
      template ??
      (await this.prisma.messageTemplate.findFirst({
        where: {
          templateGroupKey,
          channel: channel as never,
          isActive: true,
          OR: [{ organizationId: orgId }, { organizationId: null }],
        },
      }));

    if (!resolvedTemplate) {
      return this.recordSkipped(sendRequestId, orgId, customerId, channel, null, 'skipped_no_channel', 'no template found');
    }

    // -- Section 6: consent check --------------------------------------
    if (resolvedTemplate.category === 'marketing') {
      const consentType = channel === 'wallet' ? 'push' : (channel as never); // wallet updates ride on push-consent
      const consent = customer.consents.find((c) => c.consentType === consentType);
      const marketingConsent = customer.consents.find((c) => c.consentType === 'marketing');
      if (!consent?.granted || !marketingConsent?.granted) {
        return this.recordSkipped(
          sendRequestId,
          orgId,
          customerId,
          channel,
          resolvedTemplate.id,
          'skipped_no_consent',
          'missing marketing/channel consent',
        );
      }
    }
    // Transactional: still needs the channel itself to exist.
    if (channel === 'email' && !customer.email) {
      return this.recordSkipped(sendRequestId, orgId, customerId, channel, resolvedTemplate.id, 'skipped_no_channel', 'no email on file');
    }
    if (channel === 'sms' && !customer.phone) {
      return this.recordSkipped(sendRequestId, orgId, customerId, channel, resolvedTemplate.id, 'skipped_no_channel', 'no phone on file');
    }
    if (channel === 'whatsapp' && !customer.phone) {
      return this.recordSkipped(sendRequestId, orgId, customerId, channel, resolvedTemplate.id, 'skipped_no_channel', 'no phone on file');
    }

    // -- Section 7: frequency cap (marketing only) -----------------------
    if (resolvedTemplate.category === 'marketing') {
      const cap = await this.prisma.messageFrequencyCap.findFirst({
        where: { organizationId: orgId, channel: channel as never, category: 'marketing' },
      });
      const { maxMessages, periodDays } = cap ?? DEFAULT_FREQUENCY_CAP;
      const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
      const recentCount = await this.prisma.customerMessageSendLog.count({
        where: { customerId, channel: channel as never, category: 'marketing', sentAt: { gte: since } },
      });
      if (recentCount >= maxMessages) {
        return this.recordSkipped(
          sendRequestId,
          orgId,
          customerId,
          channel,
          resolvedTemplate.id,
          'skipped_frequency_cap',
          `${recentCount}/${maxMessages} in laatste ${periodDays} dagen`,
        );
      }
    }

    // -- Render + "send" (simulated, see class-level note) -----------------
    const variables = {
      first_name: customer.firstName ?? '',
      credit_balance: customer.wallet ? `€${Number(customer.wallet.availableBalance).toFixed(2)}` : '€0,00',
      favorite_location: customer.favoriteLocation?.name ?? '',
      tier: customer.tierId ?? '',
    };
    const renderedBody = renderTemplate(resolvedTemplate.body, {
      ...variables,
      credit_balance_raw: customer.wallet ? Number(customer.wallet.availableBalance) : 0,
    });
    const renderedSubject = resolvedTemplate.subject ? renderTemplate(resolvedTemplate.subject, variables) : undefined;

    const queueItem = await this.prisma.$transaction(async (tx) => {
      const item = await tx.messageQueueItem.create({
        data: {
          sendRequestId,
          organizationId: orgId,
          customerId,
          channel: channel as never,
          templateId: resolvedTemplate.id,
          renderedSubject,
          renderedBody,
          status: 'sent',
          scheduledFor: new Date(),
          sentAt: new Date(),
        },
      });

      await tx.customerMessageSendLog.create({
        data: { customerId, channel: channel as never, category: resolvedTemplate.category },
      });

      return item;
    });

    // Real delivery for the email channel (reuses the Mailgun account
    // already set up for the daily accounting report). Push/wallet/SMS
    // remain simulated — those need separate provider accounts (native
    // push infra, or an SMS provider like MessageBird/Twilio) that
    // aren't connected yet. If Mailgun isn't configured, or the send
    // fails, the queue item above still records the attempt — this
    // never blocks or breaks the campaign/journey flow that called it.
    if (channel === 'email' && customer.email && this.mailgun.isConfigured()) {
      const sendResult = await this.mailgun.sendEmail(
        customer.email,
        renderedSubject || resolvedTemplate.name,
        renderedBody,
      );
      if (!sendResult.sent) {
        await this.prisma.messageQueueItem.update({
          where: { id: queueItem.id },
          data: { status: 'failed', failureReason: sendResult.reason },
        });
      }
    }

    // Real delivery for WhatsApp — CONSTRAINT (see WhatsAppService):
    // Meta requires a pre-approved template for business-initiated
    // messages. This build pass uses `templateGroupKey` AS the Meta
    // template name (keep them identical when creating a template
    // intended for WhatsApp), with a fixed, common parameter order
    // (first name, then credit balance) — not a fully flexible mapping.
    // A more elaborate per-template parameter configuration would be
    // a reasonable next step once real templates are approved and the
    // team knows what parameter shapes they actually need.
    if (channel === 'whatsapp' && customer.phone && this.whatsapp.isConfigured()) {
      const sendResult = await this.whatsapp.sendTemplateMessage(customer.phone, resolvedTemplate.templateGroupKey, customer.language || 'nl', [
        variables.first_name,
        variables.credit_balance,
      ]);
      if (!sendResult.sent) {
        await this.prisma.messageQueueItem.update({
          where: { id: queueItem.id },
          data: { status: 'failed', failureReason: sendResult.reason },
        });
      }
    }

    // Real delivery for push — no provider account/API key needed at all
    // (Expo's push service is free), unlike the other channels. A
    // customer may have zero, one, or several registered devices; if
    // none, this simply has nothing to send to and the queue item stays
    // as a harmless no-op rather than an error.
    if (channel === 'push') {
      const tokens = await this.prisma.guestPushToken.findMany({
        where: { customerId },
        select: { expoPushToken: true },
      });
      if (tokens.length > 0) {
        const sendResult = await this.pushNotification.sendPush(
          tokens.map((t) => t.expoPushToken),
          resolvedTemplate.name,
          renderedBody,
          { templateId: resolvedTemplate.id },
        );
        if (!sendResult.sent) {
          await this.prisma.messageQueueItem.update({
            where: { id: queueItem.id },
            data: { status: 'failed', failureReason: sendResult.reason },
          });
        }
      }
    }

    return { customerId, status: 'sent', queueItemId: queueItem.id, renderedBody };
  }

  private async recordSkipped(
    sendRequestId: string,
    orgId: string,
    customerId: string,
    channel: string,
    templateId: string | null,
    status: 'skipped_no_consent' | 'skipped_frequency_cap' | 'skipped_no_channel',
    reason: string,
  ) {
    if (!templateId) return { customerId, status, reason };
    await this.prisma.messageQueueItem.create({
      data: {
        sendRequestId,
        organizationId: orgId,
        customerId,
        channel: channel as never,
        templateId,
        renderedBody: '',
        status,
        scheduledFor: new Date(),
        failureReason: reason,
      },
    });
    return { customerId, status, reason };
  }

  createTemplate(orgId: string, dto: Prisma.MessageTemplateCreateInput) {
    return this.prisma.messageTemplate.create({ data: { ...dto, organizationId: orgId } as never });
  }

  listTemplates(orgId: string) {
    return this.prisma.messageTemplate.findMany({
      where: { OR: [{ organizationId: orgId }, { organizationId: null }] },
    });
  }

  listQueue(orgId: string, status?: string) {
    return this.prisma.messageQueueItem.findMany({
      where: { organizationId: orgId, status: (status as never) || undefined },
      orderBy: { scheduledFor: 'desc' },
      take: 200,
    });
  }

  async getQueueItem(orgId: string, id: string) {
    return this.prisma.messageQueueItem.findFirst({
      where: { id, organizationId: orgId },
      include: { events: true, links: true },
    });
  }
}
