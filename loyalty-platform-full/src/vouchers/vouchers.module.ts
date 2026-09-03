import { Module } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { VouchersController } from './vouchers.controller';
import { VoucherReminderCronController } from './voucher-reminder-cron.controller';
import { MessagingModule } from '../messaging/messaging.module';

@Module({
  imports: [MessagingModule],
  controllers: [VouchersController, VoucherReminderCronController],
  providers: [VouchersService],
  exports: [VouchersService],
})
export class VouchersModule {}
