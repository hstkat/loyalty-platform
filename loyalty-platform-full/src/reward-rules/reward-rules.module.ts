import { Module } from '@nestjs/common';
import { RewardRulesController } from './reward-rules.controller';

@Module({
  controllers: [RewardRulesController],
})
export class RewardRulesModule {}
