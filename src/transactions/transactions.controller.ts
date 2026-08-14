import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { RefundTransactionDto, VoidTransactionDto } from './dto/refund-transaction.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId/transactions')
@UseGuards(PermissionsGuard)
export class TransactionsController {
  constructor(private transactions: TransactionsService) {}

  @Post()
  @RequirePermissions('transaction.write')
  create(@Param('orgId') orgId: string, @Body() dto: CreateTransactionDto) {
    return this.transactions.create(orgId, dto);
  }

  @Get()
  @RequirePermissions('transaction.read')
  findAll(@Param('orgId') orgId: string, @Query('customerId') customerId?: string, @Query('status') status?: string) {
    return this.transactions.findAll(orgId, customerId, status);
  }

  @Get(':id')
  @RequirePermissions('transaction.read')
  findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.transactions.findOne(orgId, id);
  }

  @Post(':id/refund')
  @RequirePermissions('transaction.correct')
  refund(@Param('orgId') orgId: string, @Param('id') id: string, @Body() dto: RefundTransactionDto) {
    return this.transactions.refund(orgId, id, dto);
  }

  @Post(':id/void')
  @RequirePermissions('transaction.void')
  void(@Param('orgId') orgId: string, @Param('id') id: string, @Body() dto: VoidTransactionDto) {
    return this.transactions.void(orgId, id, dto);
  }
}
