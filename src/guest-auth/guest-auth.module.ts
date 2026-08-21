import { forwardRef, Module } from '@nestjs/common';
import { GuestAppController } from './guest-app.controller';
import { GuestAuthService } from './guest-auth.service';
import { GuestSessionGuard } from './guest-session.guard';
import { MailgunService } from '../common/mailgun.service';
import { WalletModule } from '../wallet/wallet.module';
import { LoyaltyCardsModule } from '../loyalty-cards/loyalty-cards.module';

@Module({
  imports: [WalletModule, forwardRef(() => LoyaltyCardsModule)],
  controllers: [GuestAppController],
  providers: [GuestAuthService, GuestSessionGuard, MailgunService],
  exports: [GuestAuthService],
})
export class GuestAuthModule {}
