import { Module } from '@nestjs/common';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { MailgunService } from '../common/mailgun.service';
import { WhatsAppService } from '../common/whatsapp.service';

@Module({
  controllers: [MessagingController],
  providers: [MessagingService, MailgunService, WhatsAppService],
  exports: [MessagingService],
})
export class MessagingModule {}
