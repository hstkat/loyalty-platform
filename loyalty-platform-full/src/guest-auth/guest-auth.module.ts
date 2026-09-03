import { forwardRef, Module } from '@nestjs/common';
import { GuestAppController } from './guest-app.controller';
import { GuestAuthService } from './guest-auth.service';
import { GuestSessionGuard } from './guest-session.guard';
import { MailgunService } from '../common/mailgun.service';
import { WalletModule } from '../wallet/wallet.module';
import { LoyaltyCardsModule } from '../loyalty-cards/loyalty-cards.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { VouchersModule } from '../vouchers/vouchers.module';

@Module({
  imports: [WalletModule, forwardRef(() => LoyaltyCardsModule), GiftCardsModule, VouchersModule],
  controllers: [GuestAppController],
  providers: [GuestAuthService, GuestSessionGuard, MailgunService],
  exports: [GuestAuthService],
})
export class GuestAuthModule {}
