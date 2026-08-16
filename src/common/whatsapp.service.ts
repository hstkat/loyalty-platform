import { Injectable, Logger } from '@nestjs/common';

/**
 * Real WhatsApp delivery via Meta's WhatsApp Cloud API — same
 * architectural pattern as MailgunService: environment-variable
 * configured, a plain HTTP call, never blocks the calling flow if
 * unconfigured or if the send fails.
 *
 * IMPORTANT, unlike email: WhatsApp requires a pre-APPROVED message
 * template for any business-initiated message outside a 24-hour
 * customer-service window (which covers essentially all loyalty
 * marketing sends). This service can only send messages using a
 * template name that has ALREADY been approved in Meta Business
 * Manager — it cannot send arbitrary free-form text as a marketing
 * message. Approval is done entirely on Meta's side; nothing here can
 * bypass or automate that.
 *
 * Configured via environment variables (set in Vercel, never committed):
 *   WHATSAPP_ACCESS_TOKEN     — permanent access token from Meta Business Manager
 *   WHATSAPP_PHONE_NUMBER_ID  — the ID of your verified WhatsApp sender number
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  isConfigured(): boolean {
    return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
  }

  /**
   * Sends an approved template message. `templateName` must exactly
   * match a template already approved in Meta Business Manager for this
   * WhatsApp Business Account. `bodyParams` fills the template's
   * {{1}}, {{2}}... placeholders in order.
   */
  async sendTemplateMessage(
    toPhoneE164: string,
    templateName: string,
    languageCode: string,
    bodyParams: string[] = [],
  ): Promise<{ sent: boolean; reason?: string }> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!accessToken || !phoneNumberId) {
      this.logger.warn('WhatsApp not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing) — message not sent');
      return { sent: false, reason: 'WhatsApp is niet geconfigureerd (ontbrekende environment variables)' };
    }

    const body = {
      messaging_product: 'whatsapp',
      to: toPhoneE164.replace(/[^\d+]/g, ''),
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components:
          bodyParams.length > 0
            ? [{ type: 'body', parameters: bodyParams.map((p) => ({ type: 'text', text: p })) }]
            : undefined,
      },
    };

    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      this.logger.error(`WhatsApp send failed: ${res.status} ${errorBody}`);
      return { sent: false, reason: `WhatsApp-fout ${res.status}: ${errorBody}` };
    }

    return { sent: true };
  }
}
