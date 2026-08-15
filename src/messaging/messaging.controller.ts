import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { CreateMessageTemplateDto, SendMessageDto } from './dto/messaging.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId/messaging')
@UseGuards(PermissionsGuard)
export class MessagingController {
  constructor(private messaging: MessagingService) {}

  @Post('send')
  @RequirePermissions('message.send')
  send(@Param('orgId') orgId: string, @Body() dto: SendMessageDto) {
    return this.messaging.send(orgId, dto);
  }

  @Get('templates')
  @RequirePermissions('message.template.read')
  listTemplates(@Param('orgId') orgId: string) {
    return this.messaging.listTemplates(orgId);
  }

  @Post('templates')
  @RequirePermissions('message.template.write')
  createTemplate(@Param('orgId') orgId: string, @Body() dto: CreateMessageTemplateDto) {
    return this.messaging.createTemplate(orgId, dto as never);
  }

  @Get('queue')
  @RequirePermissions('message.read')
  listQueue(@Param('orgId') orgId: string, @Query('status') status?: string) {
    return this.messaging.listQueue(orgId, status);
  }

  @Get('queue/:id')
  @RequirePermissions('message.read')
  getQueueItem(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.messaging.getQueueItem(orgId, id);
  }
}
