import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { ExchangeRateService } from './exchange-rate.service';
import { CreditRulesController } from './credit-rules.controller';
import { RewardCatalogController } from './reward-catalog.controller';
import { RewardCatalogService } from './reward-catalog.service';

@Module({
  controllers: [WalletController, CreditRulesController, RewardCatalogController],
  providers: [WalletService, ExchangeRateService, RewardCatalogService],
  exports: [WalletService],
})
export class WalletModule {}
