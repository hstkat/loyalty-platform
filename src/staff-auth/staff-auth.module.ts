import { Global, Module } from '@nestjs/common';
import { StaffAuthService } from './staff-auth.service';
import { StaffAuthController } from './staff-auth.controller';

@Global()
@Module({
  controllers: [StaffAuthController],
  providers: [StaffAuthService],
  exports: [StaffAuthService],
})
export class StaffAuthModule {}
