import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ResolveIdentityDto } from './dto/resolve-identity.dto';
import { AddIdentityDto } from './dto/add-identity.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpsertConsentDto } from './dto/upsert-consent.dto';
import { MergeCustomerDto } from './dto/merge-customer.dto';
import { Ctx, RequestContext } from '../common/decorators/current-context.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';

// Base path: /organizations/:orgId/customers — organization scope comes
// from the URL, matching the design doc's API convention (section 9).
@Controller('organizations/:orgId/customers')
@UseGuards(PermissionsGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  @RequirePermissions('customer.write')
  create(@Param('orgId') orgId: string, @Body() dto: CreateCustomerDto, @Ctx() ctx: RequestContext) {
    return this.customers.create(orgId, dto, ctx);
  }

  @Get()
  @RequirePermissions('customer.read')
  findAll(@Param('orgId') orgId: string, @Query() query: ListCustomersQueryDto) {
    return this.customers.findAll(orgId, query);
  }

  @Get('duplicates')
  @RequirePermissions('customer.read', 'customer.merge')
  findDuplicates(@Param('orgId') orgId: string) {
    return this.customers.findPotentialDuplicates(orgId);
  }

  @Post('resolve-identity')
  @RequirePermissions('customer.read')
  resolveIdentity(@Param('orgId') orgId: string, @Body() dto: ResolveIdentityDto) {
    return this.customers.resolveIdentity(orgId, dto);
  }

  @Get(':id')
  @RequirePermissions('customer.read')
  findOne(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.customers.findOne(orgId, id);
  }

  @Patch(':id')
  @RequirePermissions('customer.write')
  update(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.customers.update(orgId, id, dto, ctx);
  }

  @Delete(':id')
  @RequirePermissions('customer.write')
  remove(@Param('orgId') orgId: string, @Param('id') id: string, @Ctx() ctx: RequestContext) {
    return this.customers.softDelete(orgId, id, ctx);
  }

  // -- Identities ---------------------------------------------------

  @Post(':id/identities')
  @RequirePermissions('customer.write')
  addIdentity(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Body() dto: AddIdentityDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.customers.addIdentity(orgId, id, dto, ctx);
  }

  @Delete(':id/identities/:identityId')
  @RequirePermissions('customer.write')
  removeIdentity(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Param('identityId') identityId: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.customers.removeIdentity(orgId, id, identityId, ctx);
  }

  // -- Timeline -------------------------------------------------------

  @Get(':id/timeline')
  @RequirePermissions('customer.read')
  getTimeline(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Query('eventType') eventType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.customers.getTimeline(
      orgId,
      id,
      eventType,
      page ? parseInt(page, 10) : undefined,
      pageSize ? parseInt(pageSize, 10) : undefined,
    );
  }

  // -- Notes ------------------------------------------------------------

  @Post(':id/notes')
  @RequirePermissions('customer.notes.write')
  addNote(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Body() dto: CreateNoteDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.customers.addNote(orgId, id, dto, ctx);
  }

  @Get(':id/notes')
  @RequirePermissions('customer.notes.read')
  listNotes(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.customers.listNotes(orgId, id);
  }

  // -- Tags ------------------------------------------------------------

  @Post(':id/tags/:tagId')
  @RequirePermissions('customer.write')
  addTag(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Param('tagId') tagId: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.customers.addTag(orgId, id, tagId, ctx);
  }

  @Delete(':id/tags/:tagId')
  @RequirePermissions('customer.write')
  removeTag(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Param('tagId') tagId: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.customers.removeTag(orgId, id, tagId, ctx);
  }

  // -- Consent / AVG ---------------------------------------------------

  @Get(':id/consents')
  @RequirePermissions('customer.read')
  getConsents(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.customers.getConsents(orgId, id);
  }

  @Post(':id/consents')
  @RequirePermissions('consent.write')
  upsertConsent(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Body() dto: UpsertConsentDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.customers.upsertConsent(orgId, id, dto, ctx);
  }

  @Get(':id/consents/history')
  @RequirePermissions('customer.read')
  getConsentHistory(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.customers.getConsentHistory(orgId, id);
  }

  // -- Merge -------------------------------------------------------------

  @Post(':id/merge')
  @RequirePermissions('customer.merge')
  merge(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @Body() dto: MergeCustomerDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.customers.merge(orgId, id, dto, ctx);
  }

  // -- AVG: export & anonymize -------------------------------------------

  @Post(':id/export')
  @RequirePermissions('customer.export')
  exportData(@Param('orgId') orgId: string, @Param('id') id: string, @Ctx() ctx: RequestContext) {
    return this.customers.exportData(orgId, id, ctx);
  }

  @Post(':id/anonymize')
  @RequirePermissions('customer.anonymize')
  anonymize(@Param('orgId') orgId: string, @Param('id') id: string, @Ctx() ctx: RequestContext) {
    return this.customers.anonymize(orgId, id, ctx);
  }

  // -- Multi-location -----------------------------------------------------

  @Get(':id/locations')
  @RequirePermissions('customer.read')
  getLocationBreakdown(@Param('orgId') orgId: string, @Param('id') id: string) {
    return this.customers.getLocationBreakdown(orgId, id);
  }

  // -- Portal-QR opzoeken (personeel/kassa) --------------------------------

  @Get('qr-lookup/:token')
  @RequirePermissions('customer.read')
  lookupByQrToken(@Param('orgId') orgId: string, @Param('token') token: string) {
    return this.customers.lookupByQrToken(orgId, token);
  }
}
