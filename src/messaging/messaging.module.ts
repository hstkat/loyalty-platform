import { Module } from '@nestjs/common';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { MailgunService } from '../common/mailgun.service';

@Module({
  controllers: [MessagingController],
  providers: [MessagingService, MailgunService],
  exports: [MessagingService],
})
export class MessagingModule {}
