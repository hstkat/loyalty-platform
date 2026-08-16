import { Module } from '@nestjs/common';
import { GuestAppController } from './guest-app.controller';
import { GuestAuthService } from './guest-auth.service';
import { GuestSessionGuard } from './guest-session.guard';
import { MailgunService } from '../common/mailgun.service';

@Module({
  controllers: [GuestAppController],
  providers: [GuestAuthService, GuestSessionGuard, MailgunService],
})
export class GuestAuthModule {}
