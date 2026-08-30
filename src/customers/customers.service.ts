import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/decorators/current-context.decorator';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ResolveIdentityDto } from './dto/resolve-identity.dto';
import { AddIdentityDto } from './dto/add-identity.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpsertConsentDto } from './dto/upsert-consent.dto';
import { MergeCustomerDto } from './dto/merge-customer.dto';

/** Normalizes identity values the same way regardless of entry point. */
function normalizeIdentityValue(type: string, value: string): string {
  if (type === 'email') return value.trim().toLowerCase();
  if (type === 'phone') return value.trim().replace(/[^\d+]/g, '');
  return value.trim();
}

@Injectable()
export class CustomersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // --------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------

  async create(orgId: string, dto: CreateCustomerDto, ctx: RequestContext) {
    const customer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.customer.create({
        data: {
          organizationId: orgId,
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email?.toLowerCase(),
          phone: dto.phone,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
          language: dto.language ?? 'nl',
          sourceChannel: dto.sourceChannel ?? 'manual',
          interests: dto.interests ?? [],
          preferences: (dto.preferences ?? {}) as Prisma.InputJsonValue,
          favoriteLocationId: dto.favoriteLocationId,
        },
      });

      // Auto-register identities for any contact info provided, so the
      // anti-duplicate constraint (org + type + value) is enforced from
      // the very first insert — see business rule #1.
      const identities: Prisma.CustomerIdentityCreateManyInput[] = [];
      if (dto.email) {
        identities.push({
          organizationId: orgId,
          customerId: created.id,
          identityType: 'email',
          identityValue: normalizeIdentityValue('email', dto.email),
          isPrimary: true,
          verified: false,
          source: dto.sourceChannel ?? 'manual',
        });
      }
      if (dto.phone) {
        identities.push({
          organizationId: orgId,
          customerId: created.id,
          identityType: 'phone',
          identityValue: normalizeIdentityValue('phone', dto.phone),
          isPrimary: !dto.email,
          verified: false,
          source: dto.sourceChannel ?? 'manual',
        });
      }
      if (identities.length > 0) {
        await tx.customerIdentity.createMany({ data: identities });
      }

      await tx.customerTimelineEvent.create({
        data: {
          customerId: created.id,
          organizationId: orgId,
          eventType: 'account_created',
          eventSourceModule: 'crm',
          payload: { sourceChannel: created.sourceChannel },
          occurredAt: new Date(),
        },
      });

      return created;
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer',
      entityId: customer.id,
      action: 'create',
      actor: ctx,
      afterState: customer,
    });

    return customer;
  }

  async findAll(orgId: string, query: ListCustomersQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = query.pageSize && query.pageSize > 0 ? Math.min(query.pageSize, 100) : 25;

    // Kaartnummer-matching: als de zoekterm (deels) overeenkomt met een
    // loyaltykaart-nummer, tellen we de gekoppelde gast ook mee. Dit
    // maakt "zoek een gast om een kaart aan te koppelen" (backoffice)
    // mogelijk zonder een los, tweede zoek-endpoint te introduceren.
    let cardMatchCustomerIds: string[] = [];
    if (query.search) {
      const cardMatches = await this.prisma.loyaltyCard.findMany({
        where: { organizationId: orgId, cardNumber: { contains: query.search, mode: 'insensitive' }, customerId: { not: null } },
        select: { customerId: true },
        take: 25,
      });
      cardMatchCustomerIds = cardMatches.map((c) => c.customerId).filter((id): id is string => !!id);
    }

    // Volledige-naam-matching: "Henny Schaap" matcht firstName="Henny" +
    // lastName="Schaap" ook als geen los veld de volledige zoekterm bevat.
    const searchWords = query.search ? query.search.trim().split(/\s+/).filter(Boolean) : [];
    const fullNameCondition: Prisma.CustomerWhereInput[] =
      searchWords.length >= 2
        ? [
            {
              AND: [
                { firstName: { contains: searchWords[0], mode: 'insensitive' } },
                { lastName: { contains: searchWords.slice(1).join(' '), mode: 'insensitive' } },
              ],
            },
          ]
        : [];

    const where: Prisma.CustomerWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      ...(query.loyaltyStatus ? { loyaltyStatus: query.loyaltyStatus as never } : {}),
      ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
      ...(query.locationId ? { locationsBreakdown: { some: { locationId: query.locationId } } } : {}),
      ...(query.search
        ? {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search } },
              ...(cardMatchCustomerIds.length > 0 ? [{ id: { in: cardMatchCustomerIds } }] : []),
              ...fullNameCondition,
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { wallet: true },
      }),
      this.prisma.customer.count({ where }),
    ]);

    // NOTE: Customer.currentBalance is a legacy Module 1 field that
    // Module 3's WalletService never writes to — the real, authoritative
    // balance lives on Wallet.availableBalance. Surface it explicitly
    // here so API consumers (like the backoffice) don't accidentally use
    // the always-zero stub field.
    const itemsWithBalance = items.map((customer) => ({
      ...customer,
      availableBalance: customer.wallet ? customer.wallet.availableBalance : 0,
    }));

    return { items: itemsWithBalance, total, page, pageSize };
  }

  async findOne(orgId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: {
        identities: true,
        tags: { include: { tag: true } },
        consents: true,
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async update(orgId: string, id: string, dto: UpdateCustomerDto, ctx: RequestContext) {
    const existing = await this.findOne(orgId, id);

    const updated = await this.prisma.customer.update({
      where: { id },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email?.toLowerCase(),
        phone: dto.phone,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        language: dto.language,
        interests: dto.interests,
        preferences: dto.preferences as Prisma.InputJsonValue | undefined,
        favoriteLocationId: dto.favoriteLocationId,
      },
    });

    await this.prisma.customerTimelineEvent.create({
      data: {
        customerId: id,
        organizationId: orgId,
        eventType: 'profile_updated',
        eventSourceModule: 'crm',
        payload: { fields: Object.keys(dto) },
        occurredAt: new Date(),
      },
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer',
      entityId: id,
      action: 'update',
      actor: ctx,
      beforeState: existing,
      afterState: updated,
    });

    return updated;
  }

  async softDelete(orgId: string, id: string, ctx: RequestContext) {
    await this.findOne(orgId, id);
    const updated = await this.prisma.customer.update({
      where: { id },
      data: { deletedAt: new Date(), loyaltyStatus: 'inactive' },
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer',
      entityId: id,
      action: 'delete',
      actor: ctx,
    });

    return updated;
  }

  // --------------------------------------------------------------------
  // Identity resolution — the core POS/QR-flow endpoint
  // --------------------------------------------------------------------

  async resolveIdentity(orgId: string, dto: ResolveIdentityDto) {
    const normalized = normalizeIdentityValue(dto.identityType, dto.identityValue);

    const identity = await this.prisma.customerIdentity.findUnique({
      where: {
        organizationId_identityType_identityValue: {
          organizationId: orgId,
          identityType: dto.identityType,
          identityValue: normalized,
        },
      },
      include: { customer: true },
    });

    if (!identity || identity.customer.deletedAt) {
      return { matched: false, customerId: null };
    }

    return { matched: true, customerId: identity.customerId, customer: identity.customer };
  }

  async addIdentity(orgId: string, customerId: string, dto: AddIdentityDto, ctx: RequestContext) {
    await this.findOne(orgId, customerId);
    const normalized = normalizeIdentityValue(dto.identityType, dto.identityValue);

    const identity = await this.prisma.customerIdentity.create({
      data: {
        organizationId: orgId,
        customerId,
        identityType: dto.identityType,
        identityValue: normalized,
        source: dto.source,
        isPrimary: dto.isPrimary ?? false,
        verified: dto.verified ?? false,
      },
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer_identity',
      entityId: identity.id,
      action: 'create',
      actor: ctx,
      afterState: identity,
    });

    return identity;
  }

  async removeIdentity(orgId: string, customerId: string, identityId: string, ctx: RequestContext) {
    await this.findOne(orgId, customerId);
    const identity = await this.prisma.customerIdentity.findFirst({
      where: { id: identityId, customerId },
    });
    if (!identity) throw new NotFoundException('Identity not found');

    await this.prisma.customerIdentity.delete({ where: { id: identityId } });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer_identity',
      entityId: identityId,
      action: 'delete',
      actor: ctx,
      beforeState: identity,
    });

    return { deleted: true };
  }

  // --------------------------------------------------------------------
  // Timeline
  // --------------------------------------------------------------------

  async getTimeline(orgId: string, customerId: string, eventType?: string, page = 1, pageSize = 50) {
    await this.findOne(orgId, customerId);

    const where: Prisma.CustomerTimelineEventWhereInput = {
      customerId,
      organizationId: orgId,
      ...(eventType ? { eventType: eventType as never } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customerTimelineEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.customerTimelineEvent.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  // --------------------------------------------------------------------
  // Notes
  // --------------------------------------------------------------------

  async addNote(orgId: string, customerId: string, dto: CreateNoteDto, ctx: RequestContext) {
    await this.findOne(orgId, customerId);

    const note = await this.prisma.customerNote.create({
      data: {
        customerId,
        authorUserId: dto.authorUserId,
        content: dto.content,
        noteType: dto.noteType ?? 'general',
        visibility: dto.visibility ?? 'organization',
      },
    });

    await this.prisma.customerTimelineEvent.create({
      data: {
        customerId,
        organizationId: orgId,
        eventType: 'cs_note_added',
        eventSourceModule: 'crm',
        eventSourceId: note.id,
        payload: { noteType: note.noteType },
        occurredAt: new Date(),
      },
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer_note',
      entityId: note.id,
      action: 'create',
      actor: ctx,
      afterState: note,
    });

    return note;
  }

  async listNotes(orgId: string, customerId: string) {
    await this.findOne(orgId, customerId);
    return this.prisma.customerNote.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // --------------------------------------------------------------------
  // Tags
  // --------------------------------------------------------------------

  async addTag(orgId: string, customerId: string, tagId: string, ctx: RequestContext) {
    await this.findOne(orgId, customerId);
    const tag = await this.prisma.customerTag.findFirst({ where: { id: tagId, organizationId: orgId } });
    if (!tag) throw new NotFoundException('Tag not found');

    await this.prisma.customerTagMap.upsert({
      where: { customerId_tagId: { customerId, tagId } },
      create: { customerId, tagId },
      update: {},
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer_tag_map',
      entityId: `${customerId}:${tagId}`,
      action: 'create',
      actor: ctx,
    });

    return { customerId, tagId };
  }

  async removeTag(orgId: string, customerId: string, tagId: string, ctx: RequestContext) {
    await this.findOne(orgId, customerId);
    await this.prisma.customerTagMap.delete({ where: { customerId_tagId: { customerId, tagId } } });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer_tag_map',
      entityId: `${customerId}:${tagId}`,
      action: 'delete',
      actor: ctx,
    });

    return { deleted: true };
  }

  // --------------------------------------------------------------------
  // Consent / AVG
  // --------------------------------------------------------------------

  async getConsents(orgId: string, customerId: string) {
    await this.findOne(orgId, customerId);
    return this.prisma.customerConsent.findMany({ where: { customerId } });
  }

  async upsertConsent(orgId: string, customerId: string, dto: UpsertConsentDto, ctx: RequestContext) {
    await this.findOne(orgId, customerId);
    const now = new Date();

    const consent = await this.prisma.customerConsent.upsert({
      where: { customerId_consentType: { customerId, consentType: dto.consentType } },
      create: {
        customerId,
        consentType: dto.consentType,
        granted: dto.granted,
        grantedAt: dto.granted ? now : undefined,
        revokedAt: dto.granted ? undefined : now,
        source: dto.source,
        privacyPolicyVersion: dto.privacyPolicyVersion,
        ipAddress: dto.ipAddress,
      },
      update: {
        granted: dto.granted,
        grantedAt: dto.granted ? now : undefined,
        revokedAt: dto.granted ? null : now,
        source: dto.source,
        privacyPolicyVersion: dto.privacyPolicyVersion,
        ipAddress: dto.ipAddress,
      },
    });

    // Append-only legal record — never overwritten, see business rule #6.
    await this.prisma.customerConsentHistory.create({
      data: {
        customerId,
        consentType: dto.consentType,
        action: dto.granted ? 'granted' : 'revoked',
        source: dto.source,
        privacyPolicyVersion: dto.privacyPolicyVersion,
        actor: ctx.actorId ?? ctx.actorType,
      },
    });

    await this.prisma.customerTimelineEvent.create({
      data: {
        customerId,
        organizationId: orgId,
        eventType: 'consent_changed',
        eventSourceModule: 'crm',
        payload: { consentType: dto.consentType, granted: dto.granted },
        occurredAt: new Date(),
      },
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer_consent',
      entityId: consent.id,
      action: 'update',
      actor: ctx,
      afterState: consent,
      reason: `consent ${dto.consentType} -> ${dto.granted}`,
    });

    return consent;
  }

  async getConsentHistory(orgId: string, customerId: string) {
    await this.findOne(orgId, customerId);
    return this.prisma.customerConsentHistory.findMany({
      where: { customerId },
      orderBy: { timestamp: 'desc' },
    });
  }

  // --------------------------------------------------------------------
  // Duplicate detection & merge
  // --------------------------------------------------------------------

  /**
   * Lightweight duplicate finder: groups customers by shared phone or
   * shared last name + overlapping first name. This is intentionally
   * simple — see design doc edge case #2 (shared household phone) for
   * why this stays a review queue rather than auto-merging on this
   * signal alone.
   */
  async findPotentialDuplicates(orgId: string) {
    const duplicatePhones = await this.prisma.customer.groupBy({
      by: ['phone'],
      where: { organizationId: orgId, deletedAt: null, phone: { not: null } },
      having: { phone: { _count: { gt: 1 } } },
      _count: { phone: true },
    });

    const results = [];
    for (const group of duplicatePhones) {
      const customers = await this.prisma.customer.findMany({
        where: { organizationId: orgId, phone: group.phone, deletedAt: null },
      });
      results.push({ matchedOn: 'phone', value: group.phone, customers });
    }
    return results;
  }

  async merge(orgId: string, survivingId: string, dto: MergeCustomerDto, ctx: RequestContext) {
    if (survivingId === dto.mergeWithCustomerId) {
      throw new BadRequestException('Cannot merge a customer into itself');
    }

    const [surviving, merged] = await Promise.all([
      this.findOne(orgId, survivingId),
      this.findOne(orgId, dto.mergeWithCustomerId),
    ]);

    // Simple confidence score: 1.0 if phone or email matches exactly, else 0.5.
    const matchScore =
      (surviving.phone && surviving.phone === merged.phone) ||
      (surviving.email && surviving.email === merged.email)
        ? 1.0
        : 0.5;

    const result = await this.prisma.$transaction(async (tx) => {
      // Re-parent everything from the merged customer onto the survivor.
      await tx.customerIdentity.updateMany({ where: { customerId: merged.id }, data: { customerId: surviving.id } });
      await tx.customerNote.updateMany({ where: { customerId: merged.id }, data: { customerId: surviving.id } });
      await tx.customerTimelineEvent.updateMany({ where: { customerId: merged.id }, data: { customerId: surviving.id } });
      await tx.customerLocation.updateMany({ where: { customerId: merged.id }, data: { customerId: surviving.id } });

      // Tags: re-point, ignore duplicates (survivor might already have the tag).
      const mergedTags = await tx.customerTagMap.findMany({ where: { customerId: merged.id } });
      for (const tagMap of mergedTags) {
        await tx.customerTagMap.upsert({
          where: { customerId_tagId: { customerId: surviving.id, tagId: tagMap.tagId } },
          create: { customerId: surviving.id, tagId: tagMap.tagId },
          update: {},
        });
      }
      await tx.customerTagMap.deleteMany({ where: { customerId: merged.id } });

      // Denormalized aggregates: best-effort sum here; authoritative
      // recompute happens when Module 2/3 replay their ledgers.
      const updatedSurvivor = await tx.customer.update({
        where: { id: surviving.id },
        data: {
          visitCount: surviving.visitCount + merged.visitCount,
          lifetimeSpend: surviving.lifetimeSpend.add(merged.lifetimeSpend),
          currentBalance: surviving.currentBalance.add(merged.currentBalance),
          lifetimeEarned: surviving.lifetimeEarned.add(merged.lifetimeEarned),
          lifetimeRedeemed: surviving.lifetimeRedeemed.add(merged.lifetimeRedeemed),
          firstVisitAt:
            surviving.firstVisitAt && merged.firstVisitAt
              ? surviving.firstVisitAt < merged.firstVisitAt
                ? surviving.firstVisitAt
                : merged.firstVisitAt
              : (surviving.firstVisitAt ?? merged.firstVisitAt),
        },
      });

      const mergedCustomer = await tx.customer.update({
        where: { id: merged.id },
        data: { loyaltyStatus: 'merged' },
      });

      const log = await tx.customerMergeLog.create({
        data: {
          survivingCustomerId: surviving.id,
          mergedCustomerId: merged.id,
          mergedFieldsSnapshot: merged as unknown as Prisma.InputJsonValue,
          matchScore,
          mergeType: 'manual',
          performedBy: ctx.actorId ?? undefined,
        },
      });

      await tx.customerTimelineEvent.create({
        data: {
          customerId: surviving.id,
          organizationId: orgId,
          eventType: 'merge_performed',
          eventSourceModule: 'crm',
          eventSourceId: log.id,
          payload: { mergedCustomerId: merged.id, matchScore },
          occurredAt: new Date(),
        },
      });

      return { survivor: updatedSurvivor, merged: mergedCustomer, log };
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer',
      entityId: surviving.id,
      action: 'merge',
      actor: ctx,
      beforeState: { surviving, merged },
      afterState: result,
      reason: dto.reason,
    });

    return result;
  }

  // --------------------------------------------------------------------
  // AVG / GDPR — export & anonymize
  // --------------------------------------------------------------------

  async exportData(orgId: string, customerId: string, ctx: RequestContext) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId: orgId },
      include: {
        identities: true,
        consents: true,
        consentHistory: true,
        notes: true,
        timelineEvents: true,
        locationsBreakdown: true,
        customFieldValues: true,
        tags: { include: { tag: true } },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer',
      entityId: customerId,
      action: 'export',
      actor: ctx,
    });

    // MVP note: this returns the export synchronously. In production this
    // should be an async job that produces a downloadable JSON/PDF with a
    // short-lived link (see design doc, section 11).
    return customer;
  }

  async anonymize(orgId: string, customerId: string, ctx: RequestContext) {
    const customer = await this.findOne(orgId, customerId);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.customerIdentity.deleteMany({ where: { customerId } });

      const anonymized = await tx.customer.update({
        where: { id: customerId },
        data: {
          firstName: 'Anonymized',
          lastName: 'Guest',
          email: null,
          phone: null,
          dateOfBirth: null,
          interests: [],
          preferences: {},
          loyaltyStatus: 'inactive',
          deletedAt: new Date(),
        },
      });

      return anonymized;
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer',
      entityId: customerId,
      action: 'anonymize',
      actor: ctx,
      beforeState: { hadEmail: !!customer.email, hadPhone: !!customer.phone },
    });

    return result;
  }

  // --------------------------------------------------------------------
  // Multi-location
  // --------------------------------------------------------------------

  async getLocationBreakdown(orgId: string, customerId: string) {
    await this.findOne(orgId, customerId);
    return this.prisma.customerLocation.findMany({
      where: { customerId },
      include: { location: true },
    });
  }

  // -- Portal-QR opzoeken (personeel/kassa) -----------------------------
  // Zelfde beveiligingsgedachte als de fysieke-loyaltykaart-lookup:
  // server-side opzoeken via een gehasht, kortlevend token — nooit
  // vertrouwen op wat er in de QR zelf lijkt te staan.

  async lookupByQrToken(orgId: string, rawToken: string) {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const qrToken = await this.prisma.customerQrToken.findFirst({
      where: { tokenHash, expiresAt: { gte: new Date() } },
      include: { customer: { include: { wallet: true, tier: true } } },
    });
    if (!qrToken || qrToken.customer.organizationId !== orgId || qrToken.customer.deletedAt) {
      throw new NotFoundException('Onbekende of verlopen QR-code');
    }
    const customer = qrToken.customer;
    return {
      customerId: customer.id,
      customerName: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
      tier: customer.tier?.name ?? null,
      availableBalance: customer.wallet ? Number(customer.wallet.availableBalance) : 0,
    };
  }
}
