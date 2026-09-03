import { Module } from '@nestjs/common';
import { CustomerPortalController } from './customer-portal.controller';

@Module({
  controllers: [CustomerPortalController],
})
export class CustomerPortalModule {}
