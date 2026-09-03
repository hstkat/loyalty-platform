import { Global, Module } from '@nestjs/common';
import { StaffAuthService } from './staff-auth.service';
import { StaffAuthController } from './staff-auth.controller';
import { StaffUsersController } from './staff-users.controller';

@Global()
@Module({
  controllers: [StaffAuthController, StaffUsersController],
  providers: [StaffAuthService],
  exports: [StaffAuthService],
})
export class StaffAuthModule {}
