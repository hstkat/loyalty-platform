import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AudienceFilterService, FilterGroup } from '../common/audience-filter.service';
import { CreateSegmentDto, PreviewSegmentDto } from './dto/segment.dto';

@Injectable()
export class SegmentsService {
  constructor(
    private prisma: PrismaService,
    private audienceFilter: AudienceFilterService,
  ) {}

  create(orgId: string, dto: CreateSegmentDto) {
    return this.prisma.segment.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        description: dto.description,
        segmentType: dto.segmentType ?? 'custom',
        definition: dto.definition as Prisma.InputJsonValue,
        evaluationMode: dto.evaluationMode ?? 'cached',
      },
    });
  }

  findAll(orgId: string, segmentType?: string) {
    return this.prisma.segment.findMany({
      where: { organizationId: orgId, segmentType: (segmentType as never) || undefined },
      orderBy: [{ isPinned: 'desc' }, { name: 'asc' }],
    });
  }

  async findOne(orgId: string, id: string) {
    const segment = await this.prisma.segment.findFirst({ where: { id, organizationId: orgId } });
    if (!segment) throw new NotFoundException('Segment not found');
    return segment;
  }

  async update(orgId: string, id: string, dto: Partial<CreateSegmentDto>) {
    await this.findOne(orgId, id);
    return this.prisma.segment.update({ where: { id }, data: dto as never });
  }

  async delete(orgId: string, id: string) {
    await this.findOne(orgId, id);
    await this.prisma.segment.delete({ where: { id } });
    return { deleted: true };
  }

  async preview(orgId: string, dto: PreviewSegmentDto) {
    const result = await this.audienceFilter.evaluate(orgId, dto.definition as unknown as FilterGroup);
    const sample = await this.prisma.customer.findMany({
      where: { id: { in: result.matchedCustomerIds.slice(0, 10) } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    return { count: result.count, sample };
  }

  async recompute(orgId: string, id: string) {
    const segment = await this.findOne(orgId, id);
    const result = await this.audienceFilter.evaluate(orgId, segment.definition as unknown as FilterGroup);

    await this.prisma.$transaction([
      this.prisma.segmentMembership.deleteMany({ where: { segmentId: id } }),
      this.prisma.segmentMembership.createMany({
        data: result.matchedCustomerIds.map((customerId) => ({ segmentId: id, customerId })),
      }),
      this.prisma.segment.update({
        where: { id },
        data: { lastComputedCount: result.count, lastComputedAt: new Date() },
      }),
    ]);

    return { count: result.count };
  }

  async getMembers(orgId: string, id: string, page = 1, pageSize = 50) {
    await this.findOne(orgId, id);
    const memberships = await this.prisma.segmentMembership.findMany({
      where: { segmentId: id },
      include: { customer: { select: { id: true, firstName: true, lastName: true, email: true } } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return memberships.map((m) => m.customer);
  }

  async duplicate(orgId: string, id: string) {
    const segment = await this.findOne(orgId, id);
    return this.prisma.segment.create({
      data: {
        organizationId: orgId,
        name: `${segment.name} (kopie)`,
        description: segment.description,
        segmentType: 'custom',
        definition: segment.definition as Prisma.InputJsonValue,
        evaluationMode: segment.evaluationMode,
      },
    });
  }
}
