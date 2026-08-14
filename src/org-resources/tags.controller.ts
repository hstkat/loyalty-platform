import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

@Controller('organizations/:orgId/tags')
@UseGuards(PermissionsGuard)
export class TagsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermissions('customer.read')
  list(@Param('orgId') orgId: string) {
    return this.prisma.customerTag.findMany({ where: { organizationId: orgId } });
  }

  @Post()
  @RequirePermissions('customer.write')
  create(@Param('orgId') orgId: string, @Body() dto: CreateTagDto) {
    return this.prisma.customerTag.create({
      data: {
        organizationId: orgId,
        label: dto.label,
        color: dto.color ?? '#64748B',
        createdBy: dto.createdBy,
      },
    });
  }

  @Delete(':tagId')
  @RequirePermissions('customer.write')
  remove(@Param('orgId') orgId: string, @Param('tagId') tagId: string) {
    return this.prisma.customerTag.delete({ where: { id: tagId } });
  }
}
