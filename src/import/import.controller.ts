import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ImportService } from './import.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Ctx, RequestContext } from '../common/decorators/current-context.decorator';
import { ParseImportDto, PreviewImportDto, CommitBatchDto, ResolveReviewDto } from './dto/import.dto';

@Controller('organizations/:orgId/imports')
@UseGuards(PermissionsGuard)
export class ImportController {
  constructor(private importService: ImportService) {}

  @Post('parse')
  @RequirePermissions('import.write')
  parseFile(@Param('orgId') orgId: string, @Ctx() ctx: RequestContext, @Body() dto: ParseImportDto) {
    return this.importService.parseFile(orgId, ctx.actorId ?? undefined, dto);
  }

  @Post(':jobId/preview')
  @RequirePermissions('import.write')
  preview(@Param('orgId') orgId: string, @Param('jobId') jobId: string, @Body() dto: PreviewImportDto) {
    return this.importService.preview(orgId, jobId, dto);
  }

  @Post(':jobId/records/:recordId/resolve')
  @RequirePermissions('import.write')
  resolveReview(
    @Param('orgId') orgId: string,
    @Param('jobId') jobId: string,
    @Param('recordId') recordId: string,
    @Body() dto: ResolveReviewDto,
  ) {
    return this.importService.resolveReview(orgId, jobId, recordId, dto);
  }

  @Post(':jobId/commit')
  @RequirePermissions('import.write')
  commitBatch(@Param('orgId') orgId: string, @Param('jobId') jobId: string, @Body() dto: CommitBatchDto) {
    return this.importService.commitBatch(orgId, jobId, dto);
  }

  @Get()
  @RequirePermissions('import.read')
  listJobs(@Param('orgId') orgId: string) {
    return this.importService.listJobs(orgId);
  }

  @Get(':jobId')
  @RequirePermissions('import.read')
  getJobDetail(@Param('orgId') orgId: string, @Param('jobId') jobId: string, @Query('page') page?: string) {
    return this.importService.getJobDetail(orgId, jobId, page ? parseInt(page, 10) : 1);
  }

  @Post(':jobId/rollback')
  @RequirePermissions('import.write')
  rollback(@Param('orgId') orgId: string, @Param('jobId') jobId: string) {
    return this.importService.rollback(orgId, jobId);
  }
}
