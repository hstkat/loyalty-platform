import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { CustomersModule } from './customers/customers.module';
import { OrgResourcesModule } from './org-resources/org-resources.module';
import { TransactionsModule } from './transactions/transactions.module';
import { PosConnectionsModule } from './pos-connections/pos-connections.module';
import { RewardRulesModule } from './reward-rules/reward-rules.module';
import { RewardEngineModule } from './reward-engine/reward-engine.module';
import { WalletModule } from './wallet/wallet.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { MessagingModule } from './messaging/messaging.module';
import { SegmentationModule } from './segmentation/segmentation.module';
import { JourneysModule } from './journeys/journeys.module';
import { OccupancyModule } from './occupancy/occupancy.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { PassModule } from './pass/pass.module';
import { GuestAuthModule } from './guest-auth/guest-auth.module';
import { ImportModule } from './import/import.module';
import { LoyaltyCardsModule } from './loyalty-cards/loyalty-cards.module';
import { AdminModule } from './admin/admin.module';
import { GiftCardsModule } from './gift-cards/gift-cards.module';
import { CustomerPortalModule } from './customer-portal/customer-portal.module';
import { StaffAuthModule } from './staff-auth/staff-auth.module';
import { VouchersModule } from './vouchers/vouchers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Algemene bescherming tegen misbruik/spam op ALLE endpoints — 100
    // aanroepen per minuut per IP-adres is ruim voldoende voor normaal
    // gebruik (portal, backoffice, widgets), maar remt geautomatiseerd
    // aftasten/spammen flink af. Gevoelige endpoints (staff-login,
    // e-mailcode aanvragen) hebben daarbovenop een eigen, veel strengere
    // @Throttle-limiet — zie guest-auth en staff-auth controllers.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    PrismaModule,
    StaffAuthModule,
    AuditModule,
    CustomersModule,
    OrgResourcesModule,
    TransactionsModule,
    PosConnectionsModule,
    RewardRulesModule,
    RewardEngineModule,
    WalletModule,
    CampaignsModule,
    MessagingModule,
    SegmentationModule,
    JourneysModule,
    OccupancyModule,
    AnalyticsModule,
    PassModule,
    GuestAuthModule,
    ImportModule,
    LoyaltyCardsModule,
    AdminModule,
    GiftCardsModule,
    CustomerPortalModule,
    VouchersModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
