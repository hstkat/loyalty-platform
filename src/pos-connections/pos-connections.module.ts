import { Module } from '@nestjs/common';
import { PosConnectionsController } from './pos-connections.controller';

@Module({
  controllers: [PosConnectionsController],
})
export class PosConnectionsModule {}
