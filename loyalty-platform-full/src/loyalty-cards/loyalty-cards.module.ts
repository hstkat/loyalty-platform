import { forwardRef, Module } from '@nestjs/common';
import { LoyaltyCardsController } from './loyalty-cards.controller';
import { PublicCardClaimController } from './public-card-claim.controller';
import { LoyaltyCardsService } from './loyalty-cards.service';
import { GuestAuthModule } from '../guest-auth/guest-auth.module';

@Module({
  imports: [forwardRef(() => GuestAuthModule)],
  controllers: [LoyaltyCardsController, PublicCardClaimController],
  providers: [LoyaltyCardsService],
  exports: [LoyaltyCardsService],
})
export class LoyaltyCardsModule {}
