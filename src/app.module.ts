import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { CustomersModule } from './customers/customers.module';
import { OrgResourcesModule } from './org-resources/org-resources.module';
import { TransactionsModule } from './transactions/transactions.module';
import { PosConnectionsModule } from './pos-connections/pos-connections.module';
import { RewardRulesModule } from './reward-rules/reward-rules.module';
import { RewardEngineModule } from './reward-engine/reward-engine.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuditModule,
    CustomersModule,
    OrgResourcesModule,
    TransactionsModule,
    PosConnectionsModule,
    RewardRulesModule,
    RewardEngineModule,
    WalletModule,
  ],
})
export class AppModule {}
