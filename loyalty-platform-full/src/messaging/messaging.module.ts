import { Module } from '@nestjs/common';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { MailgunService } from '../common/mailgun.service';
import { WhatsAppService } from '../common/whatsapp.service';
import { PushNotificationService } from '../common/push-notification.service';

@Module({
  controllers: [MessagingController],
  providers: [MessagingService, MailgunService, WhatsAppService, PushNotificationService],
  exports: [MessagingService],
})
export class MessagingModule {}
