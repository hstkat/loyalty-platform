import { Module } from '@nestjs/common';
import { LoyaltyCardsController } from './loyalty-cards.controller';
import { PublicCardClaimController } from './public-card-claim.controller';
import { LoyaltyCardsService } from './loyalty-cards.service';
import { GuestAuthModule } from '../guest-auth/guest-auth.module';

@Module({
  imports: [GuestAuthModule],
  controllers: [LoyaltyCardsController, PublicCardClaimController],
  providers: [LoyaltyCardsService],
})
export class LoyaltyCardsModule {}
