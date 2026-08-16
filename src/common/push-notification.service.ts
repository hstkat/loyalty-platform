import { Injectable, Logger } from '@nestjs/common';

/**
 * Real push delivery via Expo's Push Notification service — unlike
 * Mailgun/WhatsApp, this needs NO account signup or API key at all:
 * Expo's push service is free and abstracts away both Apple's APNs and
 * Google's FCM behind one shared HTTP endpoint. The only real
 * requirement is that the RECEIVING app must be a genuine "development
 * build" or a production build — Expo Go itself no longer supports
 * receiving remote push on Android as of SDK 53, so this can be sent
 * correctly by the backend while still not arriving during Expo-Go-based
 * testing. That's a client-side testing limitation, not a server
 * configuration problem.
 */
@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);

  async sendPush(
    expoPushTokens: string[],
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<{ sent: boolean; reason?: string }> {
    if (expoPushTokens.length === 0) {
      return { sent: false, reason: 'Geen pushtokens om naar te versturen' };
    }

    // Expo's push API accepts up to 100 messages per request.
    const chunks: string[][] = [];
    for (let i = 0; i < expoPushTokens.length; i += 100) {
      chunks.push(expoPushTokens.slice(i, i + 100));
    }

    for (const chunk of chunks) {
      const messages = chunk.map((token) => ({
        to: token,
        title,
        body,
        data,
        sound: 'default',
      }));

      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        this.logger.error(`Expo push send failed: ${res.status} ${errorText}`);
        return { sent: false, reason: `Push-fout ${res.status}: ${errorText}` };
      }
    }

    return { sent: true };
  }
}
