import { Module } from '@nestjs/common';
import { GiftCardsController } from './gift-cards.controller';
import { PublicGiftCardController, GiftCardCheckoutController } from './public-gift-card.controller';
import { GiftCardsService } from './gift-cards.service';
import { MailgunService } from '../common/mailgun.service';
import { MollieService } from '../common/mollie.service';

@Module({
  controllers: [GiftCardsController, PublicGiftCardController, GiftCardCheckoutController],
  providers: [GiftCardsService, MailgunService, MollieService],
  exports: [GiftCardsService],
})
export class GiftCardsModule {}
