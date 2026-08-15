import { Module } from '@nestjs/common';
import { PassController } from './pass.controller';

@Module({
  controllers: [PassController],
})
export class PassModule {}
