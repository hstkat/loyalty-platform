import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { RewardEngineModule } from '../reward-engine/reward-engine.module';
import { WalletModule } from '../wallet/wallet.module';
import { JourneysModule } from '../journeys/journeys.module';

@Module({
  imports: [RewardEngineModule, WalletModule, JourneysModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
