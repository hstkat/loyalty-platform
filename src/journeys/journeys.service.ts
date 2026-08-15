import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JourneyEngineService } from './journey-engine.service';
import { CreateJourneyDto } from './dto/journey.dto';

@Injectable()
export class JourneysService {
  constructor(
    private prisma: PrismaService,
    private engine: JourneyEngineService,
  ) {}

  async create(orgId: string, dto: CreateJourneyDto) {
    return this.prisma.$transaction(async (tx) => {
      const journey = await tx.journey.create({
        data: {
          organizationId: orgId,
          name: dto.name,
          status: 'draft',
          reEnrollmentPolicy: dto.reEnrollmentPolicy ?? 'once_ever',
        },
      });

      const version = await tx.journeyVersion.create({
        data: {
          journeyId: journey.id,
          versionNumber: 1,
          triggerType: dto.triggerType,
          eventName: dto.eventName,
        },
      });

      const tempIdToNodeId = new Map<string, string>();
      for (const nodeDto of dto.nodes) {
        const node = await tx.journeyNode.create({
          data: {
            journeyVersionId: version.id,
            nodeType: nodeDto.nodeType,
            config: (nodeDto.config ?? {}) as never,
          },
        });
        tempIdToNodeId.set(nodeDto.tempId, node.id);
      }

      for (const edgeDto of dto.edges) {
        const fromNodeId = tempIdToNodeId.get(edgeDto.fromTempId);
        const toNodeId = tempIdToNodeId.get(edgeDto.toTempId);
        if (!fromNodeId || !toNodeId) continue;
        await tx.journeyEdge.create({
          data: { journeyVersionId: version.id, fromNodeId, toNodeId, branchLabel: edgeDto.branchLabel },
        });
      }

      return tx.journey.update({ where: { id: journey.id }, data: { currentVersionId: version.id } });
    });
  }

  findAll(orgId: string, status?: string) {
    return this.prisma.journey.findMany({ where: { organizationId: orgId, status: (status as never) || undefined } });
  }

  async findOne(orgId: string, id: string) {
    const journey = await this.prisma.journey.findFirst({
      where: { id, organizationId: orgId },
      include: { versions: { include: { nodes: true, edges: true } } },
    });
    if (!journey) throw new NotFoundException('Journey not found');
    return journey;
  }

  async publish(orgId: string, id: string) {
    const journey = await this.findOne(orgId, id);
    const draftVersion = journey.versions.find((v) => !v.publishedAt);
    if (!draftVersion) throw new NotFoundException('No draft version to publish');

    await this.prisma.journeyVersion.update({ where: { id: draftVersion.id }, data: { publishedAt: new Date() } });
    return this.prisma.journey.update({
      where: { id },
      data: { status: 'published', currentVersionId: draftVersion.id },
    });
  }

  async pause(orgId: string, id: string) {
    await this.findOne(orgId, id);
    return this.prisma.journey.update({ where: { id }, data: { status: 'paused' } });
  }

  async resume(orgId: string, id: string) {
    await this.findOne(orgId, id);
    return this.prisma.journey.update({ where: { id }, data: { status: 'published' } });
  }

  async stop(orgId: string, id: string) {
    await this.findOne(orgId, id);
    await this.prisma.journeyEnrollment.updateMany({
      where: { journeyId: id, status: { in: ['enrolled', 'executing', 'waiting'] } },
      data: { status: 'exited', exitReason: 'journey_stopped' },
    });
    return this.prisma.journey.update({ where: { id }, data: { status: 'stopped' } });
  }

  async getEnrollments(orgId: string, id: string) {
    await this.findOne(orgId, id);
    return this.prisma.journeyEnrollment.findMany({
      where: { journeyId: id },
      include: { customer: { select: { firstName: true, lastName: true } } },
      orderBy: { enrolledAt: 'desc' },
      take: 100,
    });
  }

  async test(orgId: string, id: string, customerId: string) {
    const journey = await this.findOne(orgId, id);
    const version = journey.versions.find((v) => v.id === journey.currentVersionId) ?? journey.versions[0];
    if (!version) throw new NotFoundException('Journey has no version to test');
    return this.engine.enroll(orgId, id, version.id, customerId, 'always');
  }
}
