import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../common/decorators/current-context.decorator';

interface AuditParams {
  organizationId: string;
  entityType: string;
  entityId: string;
  action: 'create' | 'update' | 'delete' | 'merge' | 'anonymize' | 'export';
  actor: Pick<RequestContext, 'actorId' | 'actorType' | 'ipAddress'>;
  beforeState?: unknown;
  afterState?: unknown;
  reason?: string;
}

/**
 * Shared infrastructure used by every module (see Module 1 design doc,
 * section 13 — Audit logging). Any handler that mutates a customer-owned
 * entity should call `record()` after the mutation succeeds.
 */
@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async record(params: AuditParams): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId: params.organizationId,
        entityType: params.entityType,
        entityId: params.entityId,
        action: params.action,
        actorType: params.actor.actorType,
        actorId: params.actor.actorId ?? undefined,
        beforeState: (params.beforeState as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        afterState: (params.afterState as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        reason: params.reason,
        ipAddress: params.actor.ipAddress ?? undefined,
      },
    });
  }
}
