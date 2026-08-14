import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomFieldDto } from './dto/create-custom-field.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId/custom-fields')
@UseGuards(PermissionsGuard)
export class CustomFieldsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermissions('customer.read')
  list(@Param('orgId') orgId: string) {
    return this.prisma.customerCustomField.findMany({
      where: { organizationId: orgId, deletedAt: null },
    });
  }

  @Post()
  @RequirePermissions('customer.write')
  create(@Param('orgId') orgId: string, @Body() dto: CreateCustomFieldDto) {
    return this.prisma.customerCustomField.create({
      data: {
        organizationId: orgId,
        fieldKey: dto.fieldKey,
        fieldLabel: dto.fieldLabel,
        fieldType: dto.fieldType,
        options: dto.options,
      },
    });
  }
}
