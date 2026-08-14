import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { RewardEngineModule } from '../reward-engine/reward-engine.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [RewardEngineModule, WalletModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
