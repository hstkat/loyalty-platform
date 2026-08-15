import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { ExchangeRateService } from './exchange-rate.service';
import { CreditRulesController } from './credit-rules.controller';

@Module({
  controllers: [WalletController, CreditRulesController],
  providers: [WalletService, ExchangeRateService],
  exports: [WalletService],
})
export class WalletModule {}
