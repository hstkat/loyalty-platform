import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MessagingService } from '../messaging/messaging.service';
import { VoucherTemplateDto, IssueVoucherDto, RedeemVoucherDto } from './dto/vouchers.dto';

export interface ActorContext {
  actorType: 'staff' | 'system' | 'journey' | 'campaign' | 'reward_engine';
  actorId: string | null;
  ipAddress?: string | null;
}

/**
 * Voucher-module — bewust een VOLLEDIG APARTE reward, nooit samengevoegd
 * met Beach Credit/punten (WalletService) of cadeaukaartsaldo
 * (GiftCardsService). Zie het schema-commentaar bij VoucherTemplate/
 * CustomerVoucher voor de architecturale onderbouwing; dezelfde scheiding
 * die al bestond tussen GiftCard en Wallet is hier bewust herhaald.
 */
@Injectable()
export class VouchersService {
  private readonly logger = new Logger(VouchersService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private messaging: MessagingService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private generateToken(): string {
    return randomBytes(24).toString('base64url');
  }

  // -- Templates (admin) ----------------------------------------------------

  async createTemplate(orgId: string, dto: VoucherTemplateDto) {
    this.validateValidityRule(dto);
    return this.prisma.voucherTemplate.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        description: dto.description,
        imageUrl: dto.imageUrl,
        benefit: dto.benefit,
        terms: dto.terms,
        isActive: dto.isActive ?? true,
        validityDays: dto.validityDays,
        validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
        locationIds: dto.locationIds ?? [],
        reminderDaysBeforeExpiry: dto.reminderDaysBeforeExpiry ?? [],
      },
    });
  }

  async updateTemplate(orgId: string, templateId: string, dto: Partial<VoucherTemplateDto>) {
    const existing = await this.prisma.voucherTemplate.findFirst({ where: { id: templateId, organizationId: orgId } });
    if (!existing) throw new NotFoundException('Voucher-template niet gevonden');
    if (dto.validityDays !== undefined || dto.validFrom !== undefined || dto.validUntil !== undefined) {
      this.validateValidityRule({
        ...dto,
        validityDays: dto.validityDays ?? (existing.validFrom ? undefined : (existing.validityDays ?? undefined)),
      } as VoucherTemplateDto);
    }
    return this.prisma.voucherTemplate.update({
      where: { id: templateId },
      data: {
        name: dto.name,
        description: dto.description,
        imageUrl: dto.imageUrl,
        benefit: dto.benefit,
        terms: dto.terms,
        isActive: dto.isActive,
        validityDays: dto.validityDays,
        validFrom: dto.validFrom ? new Date(dto.validFrom) : dto.validFrom === null ? null : undefined,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : dto.validUntil === null ? null : undefined,
        locationIds: dto.locationIds,
        reminderDaysBeforeExpiry: dto.reminderDaysBeforeExpiry,
      },
    });
  }

  async listTemplates(orgId: string, includeInactive = false) {
    return this.prisma.voucherTemplate.findMany({
      where: { organizationId: orgId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Voor de "geldig bij"-locatiekeuze in het template-formulier — geen
   * aparte 'locations.read'-permissie nodig, dit hangt aan 'voucher.write'
   * omdat het uitsluitend hiervoor gebruikt wordt. */
  async listLocations(orgId: string) {
    return this.prisma.location.findMany({ where: { organizationId: orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }

  private validateValidityRule(dto: Pick<VoucherTemplateDto, 'validityDays' | 'validFrom' | 'validUntil'>) {
    const hasRelative = dto.validityDays !== undefined && dto.validityDays !== null;
    const hasFixed = !!dto.validFrom || !!dto.validUntil;
    if (hasRelative && hasFixed) {
      throw new BadRequestException('Kies óf een aantal dagen geldig, óf vaste data — niet allebei');
    }
    if (!hasRelative && !hasFixed) {
      throw new BadRequestException('Geef een geldigheidsregel op: aantal dagen, of een vaste periode');
    }
    if (hasRelative && (dto.validityDays as number) <= 0) {
      throw new BadRequestException('Aantal dagen geldig moet groter dan 0 zijn');
    }
    if (dto.validFrom && dto.validUntil && new Date(dto.validFrom) >= new Date(dto.validUntil)) {
      throw new BadRequestException('"Geldig vanaf" moet vóór "geldig tot" liggen');
    }
  }

  // -- Uitgifte ---------------------------------------------------------------

  /**
   * Berekent valid_from/valid_until voor een concrete uitgifte, op basis
   * van de template-regel — en slaat het resultaat expliciet op de
   * CustomerVoucher-rij op, zodat achteraf altijd duidelijk is wanneer
   * DEZE specifieke voucher geldig was, ook als de template later
   * wijzigt.
   */
  private computeValidity(
    template: { validityDays: number | null; validFrom: Date | null; validUntil: Date | null },
    issuedAt: Date,
    overrideFrom?: string,
    overrideUntil?: string,
  ): { validFrom: Date; validUntil: Date } {
    if (overrideFrom || overrideUntil) {
      return {
        validFrom: overrideFrom ? new Date(overrideFrom) : issuedAt,
        validUntil: overrideUntil ? new Date(overrideUntil) : new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
      };
    }
    if (template.validityDays) {
      return { validFrom: issuedAt, validUntil: new Date(issuedAt.getTime() + template.validityDays * 24 * 60 * 60 * 1000) };
    }
    return {
      validFrom: template.validFrom ?? issuedAt,
      validUntil: template.validUntil ?? new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
    };
  }

  async issueVoucher(orgId: string, dto: IssueVoucherDto, actor: ActorContext) {
    const template = await this.prisma.voucherTemplate.findFirst({ where: { id: dto.voucherTemplateId, organizationId: orgId } });
    if (!template) throw new NotFoundException('Voucher-template niet gevonden');
    if (!template.isActive) throw new BadRequestException('Deze voucher-template is niet actief');

    const customer = await this.prisma.customer.findFirst({ where: { id: dto.customerId, organizationId: orgId, deletedAt: null } });
    if (!customer) throw new NotFoundException('Klant niet gevonden');

    const issuedAt = new Date();
    const { validFrom, validUntil } = this.computeValidity(template, issuedAt, dto.validFromOverride, dto.validUntilOverride);
    const status = validFrom > issuedAt ? 'scheduled' : 'active';

    const token = this.generateToken();
    const voucher = await this.prisma.customerVoucher.create({
      data: {
        organizationId: orgId,
        customerId: dto.customerId,
        voucherTemplateId: dto.voucherTemplateId,
        campaignId: dto.campaignId,
        journeyId: dto.journeyId,
        status,
        validFrom,
        validUntil,
        issuedAt,
        issueReason: dto.issueReason,
        issueSource: dto.issueSource ?? 'manual',
        secureTokenHash: this.hashToken(token),
      },
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer_voucher',
      entityId: voucher.id,
      action: 'create',
      actor: { actorType: actor.actorType === 'staff' ? 'staff' : 'system', actorId: actor.actorId, ipAddress: actor.ipAddress ?? null },
      afterState: { templateId: template.id, templateName: template.name, customerId: dto.customerId, validFrom, validUntil, issueSource: dto.issueSource ?? 'manual' },
      reason: dto.issueReason ?? `Voucher "${template.name}" uitgegeven`,
    });

    // Bestaande Messaging-module, respecteert automatisch de bestaande
    // consent- en frequency-cap-regels van dat systeem — geen aparte
    // logica hier nodig. MessageSendRequest.sourceType is een strikte
    // enum ('campaign' | 'journey' | 'system'), dus issueSource (dat
    // meer waarden kent, zoals 'manual'/'reward_engine'/'api') wordt
    // hier expliciet afgebeeld op de dichtstbijzijnde geldige waarde.
    await this.messaging
      .send(orgId, {
        sourceType: this.toMessagingSourceType(dto.issueSource ?? 'manual'),
        sourceId: voucher.id,
        templateGroupKey: 'voucher_issued',
        customerIds: [dto.customerId],
        channel: 'push' as never,
        extraVariables: { voucher_name: template.name, voucher_benefit: template.benefit },
      })
      .catch((err) => {
        this.logger.error(`Voucher ${voucher.id} uitgegeven, maar melding versturen mislukt: ${err instanceof Error ? err.message : err}`);
      });

    return voucher;
  }

  private toMessagingSourceType(issueSource: string): 'campaign' | 'journey' | 'system' {
    if (issueSource === 'campaign') return 'campaign';
    if (issueSource === 'journey') return 'journey';
    return 'system'; // manual, reward_engine, api — geen eigen enum-waarde in MessageSendRequest
  }

  // -- Klantweergave (Mijn Tegoed) ---------------------------------------------

  /** Puur afgeleid, wijzigt nooit de database — de rij zelf verandert pas
   * echt van status bij redemption/cancellation of via de reminder-cron. */
  private deriveEffectiveStatus(voucher: { status: string; validFrom: Date; validUntil: Date }): string {
    if (voucher.status === 'redeemed' || voucher.status === 'cancelled') return voucher.status;
    const now = new Date();
    if (now < voucher.validFrom) return 'scheduled';
    if (now > voucher.validUntil) return 'expired';
    return 'active';
  }

  async listForCustomer(orgId: string, customerId: string) {
    const vouchers = await this.prisma.customerVoucher.findMany({
      where: { organizationId: orgId, customerId },
      include: { voucherTemplate: true },
      orderBy: { issuedAt: 'desc' },
    });

    const categorized = { available: [] as unknown[], upcoming: [] as unknown[], used: [] as unknown[], expired: [] as unknown[] };
    for (const v of vouchers) {
      const effectiveStatus = this.deriveEffectiveStatus(v);
      const daysLeft = Math.ceil((v.validUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      const shaped = {
        id: v.id,
        name: v.voucherTemplate.name,
        description: v.voucherTemplate.description,
        imageUrl: v.voucherTemplate.imageUrl,
        benefit: v.voucherTemplate.benefit,
        terms: v.voucherTemplate.terms,
        validFrom: v.validFrom,
        validUntil: v.validUntil,
        status: effectiveStatus,
        daysLeft: effectiveStatus === 'active' ? Math.max(daysLeft, 0) : undefined,
        locationIds: v.voucherTemplate.locationIds,
      };
      if (effectiveStatus === 'active') categorized.available.push(shaped);
      else if (effectiveStatus === 'scheduled') categorized.upcoming.push(shaped);
      else if (effectiveStatus === 'redeemed') categorized.used.push(shaped);
      else categorized.expired.push(shaped);
    }
    return categorized;
  }

  /** Detailweergave bij het openen van één voucher — inclusief token voor
   * de QR-code. Geen persoonsgegevens in de payload die de QR encodeert. */
  async getVoucherDetail(orgId: string, customerId: string, voucherId: string) {
    const voucher = await this.prisma.customerVoucher.findFirst({
      where: { id: voucherId, organizationId: orgId, customerId },
      include: { voucherTemplate: true },
    });
    if (!voucher) throw new NotFoundException('Voucher niet gevonden');

    // Token wordt hier NIET opnieuw gegenereerd (in tegenstelling tot bij
    // cadeaukaarten, die eenmalig per e-mail verstuurd worden) — een
    // voucher wordt telkens opnieuw vanuit de portal geopend, dus het
    // token moet stabiel blijven zolang de voucher niet is ingewisseld.
    // We geven daarom nooit het RUWE token terug (dat kennen we zelf ook
    // niet meer, we bewaren alleen de hash) — in plaats daarvan genereert
    // de klant-portal de weergave-QR op basis van een kortlevend,
    // apart display-token (zelfde patroon als de cadeaukaart "bekijk"-
    // flow), aangevraagd via requestDisplayToken hieronder.
    return {
      id: voucher.id,
      name: voucher.voucherTemplate.name,
      description: voucher.voucherTemplate.description,
      benefit: voucher.voucherTemplate.benefit,
      terms: voucher.voucherTemplate.terms,
      validFrom: voucher.validFrom,
      validUntil: voucher.validUntil,
      status: this.deriveEffectiveStatus(voucher),
      locationIds: voucher.voucherTemplate.locationIds,
    };
  }

  /**
   * Genereert een VERS, kortlevend weergave-token en overschrijft de
   * opgeslagen hash daarmee — zelfde aanpak als de cadeaukaart-QR-
   * weergave: elke keer dat de klant de voucher opent, wordt het
   * geldende token vervangen. Dat betekent dat een eerder gescande/
   * gedeelde QR-afbeelding vanzelf verloopt zodra de klant de voucher
   * opnieuw opent, en de QR zelf blijft zo altijd kortlevend en niet
   * herbruikbaar buiten de app om.
   */
  async requestDisplayToken(orgId: string, customerId: string, voucherId: string) {
    const voucher = await this.prisma.customerVoucher.findFirst({ where: { id: voucherId, organizationId: orgId, customerId } });
    if (!voucher) throw new NotFoundException('Voucher niet gevonden');
    const effectiveStatus = this.deriveEffectiveStatus(voucher);
    if (effectiveStatus !== 'active') {
      throw new BadRequestException('Deze voucher is niet (meer) actief inwisselbaar');
    }
    const token = this.generateToken();
    await this.prisma.customerVoucher.update({ where: { id: voucher.id }, data: { secureTokenHash: this.hashToken(token) } });
    return { token };
  }

  // -- POS-inwisseling ----------------------------------------------------

  /** Server-side eligibility-lookup — vertrouwt NOOIT informatie uit de
   * QR-code zelf buiten het token; alle overige gegevens (klant, geldigheid,
   * locatie) komen vers uit de database op het moment van scannen. */
  async lookupForRedemption(orgId: string, secureToken: string) {
    const voucher = await this.prisma.customerVoucher.findFirst({
      where: { organizationId: orgId, secureTokenHash: this.hashToken(secureToken) },
      include: { voucherTemplate: true, customer: { select: { firstName: true, lastName: true, email: true } } },
    });
    if (!voucher) throw new NotFoundException('Voucher niet gevonden of ongeldige code');

    return {
      voucherId: voucher.id,
      templateName: voucher.voucherTemplate.name,
      benefit: voucher.voucherTemplate.benefit,
      terms: voucher.voucherTemplate.terms,
      customerName: [voucher.customer.firstName, voucher.customer.lastName].filter(Boolean).join(' '),
      status: this.deriveEffectiveStatus(voucher),
      validFrom: voucher.validFrom,
      validUntil: voucher.validUntil,
      locationIds: voucher.voucherTemplate.locationIds,
    };
  }

  async redeemVoucher(orgId: string, staffId: string, dto: RedeemVoucherDto) {
    const voucher = await this.prisma.customerVoucher.findFirst({
      where: { organizationId: orgId, secureTokenHash: this.hashToken(dto.secureToken) },
      include: { voucherTemplate: true },
    });
    if (!voucher) throw new NotFoundException('Voucher niet gevonden of ongeldige code');

    const effectiveStatus = this.deriveEffectiveStatus(voucher);
    if (effectiveStatus === 'redeemed') throw new BadRequestException('Deze voucher is al eerder ingewisseld');
    if (effectiveStatus === 'cancelled') throw new BadRequestException('Deze voucher is ingetrokken');
    if (effectiveStatus === 'expired') throw new BadRequestException('Deze voucher is verlopen');
    if (effectiveStatus === 'scheduled') throw new BadRequestException('Deze voucher is nog niet geldig');

    const locationScope = voucher.voucherTemplate.locationIds;
    if (locationScope.length > 0 && dto.locationId && !locationScope.includes(dto.locationId)) {
      throw new ForbiddenException('Deze voucher is niet geldig op deze locatie');
    }

    // Atomair CLAIMEN — zelfde patroon als bij cadeaukaarten/wallet-
    // reserveringen: de where-clause herhaalt de statuscheck in de
    // UPDATE zelf, zodat twee (bijna-)gelijktijdige inwissel-pogingen
    // (bijv. twee keer scannen, of twee kassa's tegelijk) nooit allebei
    // kunnen slagen. Postgres serialiseert dit vanzelf via de rij-lock.
    const claim = await this.prisma.customerVoucher.updateMany({
      where: { id: voucher.id, status: { in: ['active', 'scheduled'] } },
      data: {
        status: 'redeemed',
        redeemedAt: new Date(),
        transactionId: dto.transactionId,
        locationId: dto.locationId,
        redeemedByStaffId: staffId,
      },
    });
    if (claim.count === 0) {
      throw new BadRequestException('Deze voucher is zojuist al ingewisseld (of niet meer geldig)');
    }

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer_voucher',
      entityId: voucher.id,
      action: 'update',
      actor: { actorType: 'staff', actorId: staffId, ipAddress: null },
      beforeState: { status: effectiveStatus },
      afterState: { status: 'redeemed', locationId: dto.locationId, transactionId: dto.transactionId },
      reason: `Voucher "${voucher.voucherTemplate.name}" ingewisseld`,
    });

    return { redeemed: true, templateName: voucher.voucherTemplate.name, benefit: voucher.voucherTemplate.benefit };
  }

  // -- Admin: Klantprofiel-acties ---------------------------------------------

  async listForCustomerAdmin(orgId: string, customerId: string) {
    const vouchers = await this.prisma.customerVoucher.findMany({
      where: { organizationId: orgId, customerId },
      include: { voucherTemplate: true },
      orderBy: { issuedAt: 'desc' },
    });
    return vouchers.map((v) => ({
      id: v.id,
      templateName: v.voucherTemplate.name,
      benefit: v.voucherTemplate.benefit,
      status: this.deriveEffectiveStatus(v),
      validFrom: v.validFrom,
      validUntil: v.validUntil,
      issuedAt: v.issuedAt,
      redeemedAt: v.redeemedAt,
      issueSource: v.issueSource,
      issueReason: v.issueReason,
    }));
  }

  async cancelVoucher(orgId: string, staffId: string, voucherId: string, reason?: string) {
    const voucher = await this.prisma.customerVoucher.findFirst({ where: { id: voucherId, organizationId: orgId } });
    if (!voucher) throw new NotFoundException('Voucher niet gevonden');
    const effectiveStatus = this.deriveEffectiveStatus(voucher);
    if (effectiveStatus === 'redeemed') throw new BadRequestException('Een al ingewisselde voucher kan niet worden ingetrokken');

    await this.prisma.customerVoucher.update({ where: { id: voucher.id }, data: { status: 'cancelled' } });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'customer_voucher',
      entityId: voucher.id,
      action: 'update',
      actor: { actorType: 'staff', actorId: staffId, ipAddress: null },
      beforeState: { status: effectiveStatus },
      afterState: { status: 'cancelled' },
      reason: reason ?? 'Handmatig ingetrokken',
    });

    return { cancelled: true };
  }

  // -- Verloopherinneringen (extern te triggeren — geen ingebouwde cron) ---

  /**
   * Zoekt vouchers die vandaag op een van hun template's
   * reminder-dagen-vóór-afloop zitten en nog geen reminder voor die dag
   * kregen, en stuurt de melding via de bestaande Messaging-module.
   * Zelfde aanpak als JourneyEngineService.runScheduler(): geen
   * ingebouwde cron in dit project — moet extern getriggerd worden (bijv.
   * Vercel Cron naar een beveiligd endpoint, zie VouchersController).
   */
  async sendExpiryReminders(orgId: string): Promise<{ remindersSent: number }> {
    const candidates = await this.prisma.customerVoucher.findMany({
      where: { organizationId: orgId, status: 'active' },
      include: { voucherTemplate: true },
    });

    let remindersSent = 0;
    for (const voucher of candidates) {
      if (this.deriveEffectiveStatus(voucher) !== 'active') continue;
      const daysLeft = Math.ceil((voucher.validUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      const dueReminderDay = voucher.voucherTemplate.reminderDaysBeforeExpiry.find(
        (d) => d === daysLeft && !voucher.remindersSentDays.includes(d),
      );
      if (dueReminderDay === undefined) continue;

      await this.messaging
        .send(orgId, {
          sourceType: 'system' as never,
          sourceId: voucher.id,
          templateGroupKey: 'voucher_expiring_soon',
          customerIds: [voucher.customerId],
          channel: 'push' as never,
          extraVariables: { voucher_name: voucher.voucherTemplate.name, days_left: daysLeft },
        })
        .then(async () => {
          await this.prisma.customerVoucher.update({
            where: { id: voucher.id },
            data: { remindersSentDays: { push: dueReminderDay } },
          });
          remindersSent += 1;
        })
        .catch((err) => {
          this.logger.error(`Verloopherinnering voor voucher ${voucher.id} mislukt: ${err instanceof Error ? err.message : err}`);
        });
    }
    return { remindersSent };
  }
}
