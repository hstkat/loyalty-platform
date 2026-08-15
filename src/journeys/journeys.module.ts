import { Module } from '@nestjs/common';
import { JourneysController } from './journeys.controller';
import { JourneysService } from './journeys.service';
import { JourneyEngineService } from './journey-engine.service';
import { MessagingModule } from '../messaging/messaging.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [MessagingModule, WalletModule],
  controllers: [JourneysController],
  providers: [JourneysService, JourneyEngineService],
  exports: [JourneyEngineService],
})
export class JourneysModule {}
