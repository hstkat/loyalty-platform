import { Module } from '@nestjs/common';
import { RewardEngineController } from './reward-engine.controller';
import { RewardEngineService } from './reward-engine.service';

@Module({
  controllers: [RewardEngineController],
  providers: [RewardEngineService],
  exports: [RewardEngineService],
})
export class RewardEngineModule {}
