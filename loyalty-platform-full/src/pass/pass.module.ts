import { Module } from '@nestjs/common';
import { PassController } from './pass.controller';
import { WalletPassService } from '../wallet/wallet-pass.service';
import { GoogleWalletService } from '../common/google-wallet.service';

@Module({
  controllers: [PassController],
  providers: [WalletPassService, GoogleWalletService],
})
export class PassModule {}
