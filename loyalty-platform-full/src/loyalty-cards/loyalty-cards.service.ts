import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GuestAuthService } from '../guest-auth/guest-auth.service';
import { RequestContext } from '../common/decorators/current-context.decorator';
import {
  CreateBatchDto,
  ClaimNewCustomerDto,
  ClaimLinkExistingDto,
  AdminLinkCardDto,
  BlockCardDto,
  ReplaceCardDto,
} from './dto/loyalty-cards.dto';

const MAX_BATCH_QUANTITY = 5000; // serverloze functie-tijdslimiet — grotere oplages in meerdere batches

/**
 * QR TOKEN -> LOYALTY CARD -> CUSTOMER -> WALLET
 *
 * De belangrijkste architectuurregel: een kaart bezit nooit het
 * gastprofiel of saldo. Die blijven altijd bij de Customer/Wallet. Dat
 * maakt vervangen/blokkeren/opnieuw-koppelen altijd veilig, zonder ooit
 * saldo te hoeven verplaatsen of te kunnen verliezen.
 *
 * De ruwe QR-token wordt NOOIT opgeslagen — alleen een SHA-256-hash,
 * zelfde principe als bij inlogcodes/sessietokens elders in dit
 * platform. Praktisch gevolg: de ruwe tokens zijn ALLEEN beschikbaar in
 * het antwoord van createBatch() zelf, op het moment van aanmaken — dat
 * antwoord moet dus meteen gedownload/bewaard worden, hij kan later
 * nooit meer worden teruggehaald.
 */
@Injectable()
export class LoyaltyCardsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private guestAuth: GuestAuthService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private generateToken(): string {
    // 96 bits entropie, URL-veilig — niet te raden, niet oplopend.
    return randomBytes(12).toString('base64url');
  }

  // -- Batches --------------------------------------------------------------

  async createBatch(orgId: string, ctx: RequestContext, dto: CreateBatchDto) {
    if (dto.quantity < 1 || dto.quantity > MAX_BATCH_QUANTITY) {
      throw new BadRequestException(`Aantal moet tussen 1 en ${MAX_BATCH_QUANTITY} liggen — splits grotere oplages op in meerdere batches.`);
    }

    const batch = await this.prisma.loyaltyCardBatch.create({
      data: { organizationId: orgId, locationId: dto.locationId, name: dto.name, quantity: dto.quantity, status: 'generating' },
    });

    const existingCount = await this.prisma.loyaltyCard.count({ where: { organizationId: orgId } });

    const cardsToInsert: { organizationId: string; locationId?: string; batchId: string; publicTokenHash: string; cardNumber: string }[] = [];
    const exportRows: { cardNumber: string; token: string; qrUrl: string }[] = [];

    for (let i = 0; i < dto.quantity; i++) {
      const token = this.generateToken();
      const cardNumber = 'BC-' + String(existingCount + i + 1).padStart(6, '0');
      cardsToInsert.push({
        organizationId: orgId,
        locationId: dto.locationId,
        batchId: batch.id,
        publicTokenHash: this.hashToken(token),
        cardNumber,
      });
      exportRows.push({ cardNumber, token, qrUrl: `https://loyalty-platform-live.vercel.app/c/${token}` });
    }

    await this.prisma.loyaltyCard.createMany({ data: cardsToInsert });
    await this.prisma.loyaltyCardBatch.update({ where: { id: batch.id }, data: { status: 'exported', exportedAt: new Date() } });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'loyalty_card_batch',
      entityId: batch.id,
      action: 'create',
      actor: ctx,
      afterState: { name: dto.name, quantity: dto.quantity },
    });

    return {
      batchId: batch.id,
      name: dto.name,
      quantity: dto.quantity,
      // Laatste kans om de ruwe tokens te zien — hierna bestaan ze alleen
      // nog op de fysieke kaart zelf.
      cards: exportRows,
    };
  }

  /**
   * Geeft direct een nieuwe, al-actieve kaart uit aan een gast die al
   * ingelogd is (bijv. via de portal, "e-mail mijn QR om te printen") —
   * geen claimflow nodig, want de identiteit staat al vast door de
   * sessie zelf. Bewust géén poging om een eerder token te "hervinden"
   * (dat kan sowieso niet, we bewaren nooit het ruwe token) — elke klik
   * op "verstuur opnieuw" maakt gewoon een nieuwe, geldige kaart aan.
   * Dat is onschuldig: meerdere geldige kaarten per gast is al een
   * bewust ondersteund scenario in dit systeem.
   */
  async issueDirectToCustomer(orgId: string, customerId: string) {
    const existingCount = await this.prisma.loyaltyCard.count({ where: { organizationId: orgId } });
    const token = this.generateToken();
    const cardNumber = 'BC-' + String(existingCount + 1).padStart(6, '0');

    const card = await this.prisma.loyaltyCard.create({
      data: {
        organizationId: orgId,
        customerId,
        publicTokenHash: this.hashToken(token),
        cardNumber,
        status: 'active',
        claimedAt: new Date(),
      },
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'loyalty_card',
      entityId: card.id,
      action: 'create',
      actor: { actorType: 'customer_self_service', actorId: customerId, ipAddress: null },
      afterState: { cardNumber, customerId },
      reason: 'Zelf aangevraagd via gastportal (e-mail om te printen)',
    });

    return { cardNumber, token, qrUrl: `https://loyalty-platform-live.vercel.app/c/${token}` };
  }

  async listBatches(orgId: string) {
    return this.prisma.loyaltyCardBatch.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { cards: true } } },
    });
  }

  // -- Admin: overzicht + detail ---------------------------------------------

  async listCards(orgId: string, filters: { status?: string; customerId?: string; search?: string }) {
    // Zoeken op kaartnummer ÉN op de gekoppelde gast (naam/e-mail/
    // telefoon) — anders moet je exact het kaartnummer weten om een
    // kaart terug te vinden, wat in de praktijk niet werkbaar is.
    let customerMatchIds: string[] = [];
    if (filters.search) {
      const searchWords = filters.search.trim().split(/\s+/).filter(Boolean);
      const matchedCustomers = await this.prisma.customer.findMany({
        where: {
          organizationId: orgId,
          OR: [
            { firstName: { contains: filters.search, mode: 'insensitive' } },
            { lastName: { contains: filters.search, mode: 'insensitive' } },
            { email: { contains: filters.search, mode: 'insensitive' } },
            { phone: { contains: filters.search } },
            ...(searchWords.length >= 2
              ? [
                  {
                    AND: [
                      { firstName: { contains: searchWords[0], mode: 'insensitive' as const } },
                      { lastName: { contains: searchWords.slice(1).join(' '), mode: 'insensitive' as const } },
                    ],
                  },
                ]
              : []),
          ],
        },
        select: { id: true },
        take: 100,
      });
      customerMatchIds = matchedCustomers.map((c) => c.id);
    }

    return this.prisma.loyaltyCard.findMany({
      where: {
        organizationId: orgId,
        status: filters.status as never,
        customerId: filters.customerId,
        ...(filters.search
          ? {
              OR: [
                { cardNumber: { contains: filters.search, mode: 'insensitive' } },
                ...(customerMatchIds.length > 0 ? [{ customerId: { in: customerMatchIds } }] : []),
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { customer: { select: { firstName: true, lastName: true, email: true } }, batch: { select: { name: true } } },
    });
  }

  async getCardDetail(orgId: string, cardId: string) {
    const card = await this.prisma.loyaltyCard.findFirst({
      where: { id: cardId, organizationId: orgId },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        batch: { select: { id: true, name: true } },
        replacedBy: { select: { id: true, cardNumber: true, status: true } },
        replacesCard: { select: { id: true, cardNumber: true, status: true } },
      },
    });
    if (!card) throw new NotFoundException('Kaart niet gevonden');
    return card;
  }

  // -- Publieke claim-flow ----------------------------------------------------

  /** Publieke, niet-geauthenticeerde lookup voor de claim-pagina — toont bewust minimale info (sectie 13: privacy bij een gevonden kaart). */
  async publicLookup(rawToken: string) {
    const card = await this.prisma.loyaltyCard.findUnique({
      where: { publicTokenHash: this.hashToken(rawToken) },
      select: { id: true, organizationId: true, status: true },
    });
    if (!card) return { found: false as const };
    return { found: true as const, status: card.status, cardId: card.id, organizationId: card.organizationId };
  }

  async claimAsNewCustomer(rawToken: string, dto: ClaimNewCustomerDto) {
    const card = await this.getUnclaimedCardOrThrow(rawToken);

    const customer = await this.prisma.customer.create({
      data: {
        organizationId: card.organizationId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        sourceChannel: 'qr',
      } as never,
    });

    if (dto.marketingConsent) {
      await this.prisma.customerConsent
        .create({
          data: { customerId: customer.id, consentType: 'marketing', granted: true, source: 'signup_form', privacyPolicyVersion: '2026-01' } as never,
        })
        .catch(() => undefined); // Consent-registratie is niet kritiek voor de kaartkoppeling zelf — nooit de claim laten falen hierop.
    }

    await this.linkCardToCustomer(card, customer.id, {
      actorType: 'customer_self_service',
      actorId: null,
      ipAddress: null,
      organizationId: card.organizationId,
      permissions: [],
      homeLocationId: null,
    });

    const session = await this.guestAuth.issueSession(customer.id, 'card-claim');
    return { claimed: true, customerId: customer.id, sessionToken: session.token };
  }

  async claimAsExistingCustomer(rawToken: string, dto: ClaimLinkExistingDto) {
    const card = await this.getUnclaimedCardOrThrow(rawToken);
    // Nooit een kaart koppelen puur op basis van een ingetypt e-mailadres
    // — de sessie hier is alleen geldig na een geverifieerde e-mailcode
    // (zie GuestAuthService), exact zoals de opdracht vereist.
    const customer = await this.guestAuth.resolveSession(dto.sessionToken);
    if (customer.organizationId !== card.organizationId) {
      throw new ForbiddenException('Deze kaart hoort niet bij jouw organisatie');
    }

    await this.linkCardToCustomer(card, customer.id, {
      actorType: 'customer_self_service',
      actorId: customer.id,
      ipAddress: null,
      organizationId: card.organizationId,
      permissions: [],
      homeLocationId: null,
    });

    return { claimed: true, customerId: customer.id };
  }

  private async getUnclaimedCardOrThrow(rawToken: string) {
    const card = await this.prisma.loyaltyCard.findUnique({ where: { publicTokenHash: this.hashToken(rawToken) } });
    if (!card) throw new NotFoundException('Kaart niet gevonden');
    if (card.status !== 'unclaimed') throw new ConflictException('Deze kaart is al gekoppeld of niet meer geldig');
    return card;
  }

  /** Atomair: kaart koppelen + eventueel pending-saldo migreren naar de wallet — nooit los van elkaar, ter voorkoming van dubbel saldo. */
  private async linkCardToCustomer(
    card: { id: string; pendingBalance: unknown; organizationId: string },
    customerId: string,
    ctx: RequestContext,
  ) {
    const pendingAmount = Number(card.pendingBalance);

    await this.prisma.$transaction(async (tx) => {
      await tx.loyaltyCard.update({
        where: { id: card.id },
        data: { customerId, status: 'active', claimedAt: new Date(), pendingBalance: 0 },
      });

      if (pendingAmount > 0) {
        let wallet = await tx.wallet.findUnique({ where: { customerId } });
        if (!wallet) wallet = await tx.wallet.create({ data: { organizationId: card.organizationId, customerId } });

        await tx.walletLedgerEntry.create({
          data: {
            walletId: wallet.id,
            organizationId: card.organizationId,
            entryType: 'transfer',
            amount: pendingAmount,
            remainingAmount: pendingAmount,
            status: 'available',
            source: 'system',
            performedByType: 'system',
            reason: 'Ongeregistreerd gespaard tegoed bij kaartclaim',
            occurredAt: new Date(),
          },
        });
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { availableBalance: { increment: pendingAmount }, lifetimeEarned: { increment: pendingAmount } },
        });
      }
    });

    await this.audit.record({
      organizationId: card.organizationId,
      entityType: 'loyalty_card',
      entityId: card.id,
      action: 'update',
      actor: ctx,
      beforeState: { status: 'unclaimed', customerId: null },
      afterState: { status: 'active', customerId },
      reason: 'Kaart geclaimd',
    });
  }

  // -- Admin: handmatig koppelen (bijv. voor Piggy-geïmporteerde gasten) ---

  async adminLinkCard(orgId: string, ctx: RequestContext, dto: AdminLinkCardDto) {
    const card = await this.getUnclaimedCardOrThrow(dto.token);
    if (card.organizationId !== orgId) throw new NotFoundException('Kaart niet gevonden');

    const customer = await this.prisma.customer.findFirst({ where: { id: dto.customerId, organizationId: orgId } });
    if (!customer) throw new NotFoundException('Gast niet gevonden');

    await this.linkCardToCustomer(card, customer.id, ctx);
    return { linked: true, customerId: customer.id };
  }

  // -- POS/personeel: kaart identificeren -------------------------------------

  async posLookup(orgId: string, rawToken: string, amount?: number) {
    const card = await this.prisma.loyaltyCard.findFirst({
      where: { publicTokenHash: this.hashToken(rawToken), organizationId: orgId },
      include: { customer: { include: { wallet: true, tier: true } } },
    });
    if (!card) throw new NotFoundException('Kaart niet gevonden');

    if (card.status === 'blocked' || card.status === 'lost' || card.status === 'replaced' || card.status === 'expired') {
      return { valid: false, status: card.status, message: 'Deze kaart is niet meer geldig' };
    }
    if (card.status === 'unclaimed') {
      return { valid: false, status: card.status, message: 'Deze kaart is nog niet geactiveerd door een gast' };
    }

    await this.prisma.loyaltyCard.update({ where: { id: card.id }, data: { lastUsedAt: new Date() } });

    const creditRule = await this.prisma.creditRule.findFirst({ where: { organizationId: orgId, isActive: true } });
    const threshold = creditRule?.cardRedemptionThreshold ? Number(creditRule.cardRedemptionThreshold) : null;
    const requiresExtraVerification = threshold !== null && amount !== undefined && amount > threshold;

    return {
      valid: true,
      status: card.status,
      customerId: card.customer?.id,
      customerName: [card.customer?.firstName, card.customer?.lastName].filter(Boolean).join(' '),
      tier: card.customer?.tier?.name ?? null,
      availableBalance: card.customer?.wallet ? Number(card.customer.wallet.availableBalance) : 0,
      requiresExtraVerification,
      cardRedemptionThreshold: threshold,
    };
  }

  // -- Admin-acties: blokkeren, verloren, vervangen, heractiveren ----------

  async blockCard(orgId: string, ctx: RequestContext, cardId: string, dto: BlockCardDto) {
    return this.setCardStatus(orgId, ctx, cardId, 'blocked', dto.reason);
  }

  async markLost(orgId: string, ctx: RequestContext, cardId: string, dto: BlockCardDto) {
    return this.setCardStatus(orgId, ctx, cardId, 'lost', dto.reason);
  }

  async reactivate(orgId: string, ctx: RequestContext, cardId: string) {
    const card = await this.prisma.loyaltyCard.findFirst({ where: { id: cardId, organizationId: orgId } });
    if (!card) throw new NotFoundException('Kaart niet gevonden');
    if (!card.customerId) {
      throw new BadRequestException('Kaart is nooit gekoppeld geweest — kan niet heractiveren, alleen (opnieuw) koppelen');
    }

    const updated = await this.prisma.loyaltyCard.update({
      where: { id: card.id },
      data: { status: 'active', blockedAt: null, blockedReason: null },
    });
    await this.audit.record({
      organizationId: orgId,
      entityType: 'loyalty_card',
      entityId: card.id,
      action: 'update',
      actor: ctx,
      beforeState: { status: card.status },
      afterState: { status: 'active' },
      reason: 'Heractivering',
    });
    return updated;
  }

  private async setCardStatus(orgId: string, ctx: RequestContext, cardId: string, status: 'blocked' | 'lost', reason: string) {
    const card = await this.prisma.loyaltyCard.findFirst({ where: { id: cardId, organizationId: orgId } });
    if (!card) throw new NotFoundException('Kaart niet gevonden');

    const updated = await this.prisma.loyaltyCard.update({
      where: { id: card.id },
      data: { status, blockedAt: new Date(), blockedReason: reason },
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'loyalty_card',
      entityId: card.id,
      action: 'update',
      actor: ctx,
      beforeState: { status: card.status },
      afterState: { status },
      reason,
    });
    return updated;
  }

  async replaceCard(orgId: string, ctx: RequestContext, oldCardId: string, dto: ReplaceCardDto) {
    const oldCard = await this.prisma.loyaltyCard.findFirst({ where: { id: oldCardId, organizationId: orgId } });
    if (!oldCard) throw new NotFoundException('Oude kaart niet gevonden');
    if (!oldCard.customerId) {
      throw new BadRequestException('Kaart is nooit gekoppeld geweest — vervangen heeft alleen zin voor een gekoppelde kaart');
    }

    const newCard = await this.getUnclaimedCardOrThrow(dto.newCardToken);
    if (newCard.organizationId !== orgId) throw new NotFoundException('Nieuwe kaart niet gevonden');

    await this.prisma.$transaction([
      this.prisma.loyaltyCard.update({
        where: { id: oldCard.id },
        data: {
          status: 'replaced',
          replacedByCardId: newCard.id,
          blockedAt: oldCard.blockedAt ?? new Date(),
          blockedReason: oldCard.blockedReason ?? (dto.reason || 'Vervangen'),
        },
      }),
      this.prisma.loyaltyCard.update({
        where: { id: newCard.id },
        data: { customerId: oldCard.customerId, status: 'active', claimedAt: new Date() },
      }),
    ]);

    await this.audit.record({
      organizationId: orgId,
      entityType: 'loyalty_card',
      entityId: oldCard.id,
      action: 'update',
      actor: ctx,
      beforeState: { status: oldCard.status },
      afterState: { status: 'replaced', replacedByCardId: newCard.id },
      reason: dto.reason || 'Vervangen',
    });
    await this.audit.record({
      organizationId: orgId,
      entityType: 'loyalty_card',
      entityId: newCard.id,
      action: 'update',
      actor: ctx,
      beforeState: { status: 'unclaimed' },
      afterState: { status: 'active', customerId: oldCard.customerId },
      reason: 'Vervangkaart geactiveerd',
    });

    return { oldCardId: oldCard.id, newCardId: newCard.id };
  }

  // -- Ongeregistreerd sparen (kaart nog niet geclaimd) -----------------------

  async addPendingEarn(orgId: string, cardId: string, amount: number, reason?: string) {
    const card = await this.prisma.loyaltyCard.findFirst({ where: { id: cardId, organizationId: orgId } });
    if (!card) throw new NotFoundException('Kaart niet gevonden');
    if (card.status !== 'unclaimed') {
      throw new BadRequestException('Deze kaart is al gekoppeld — gebruik de normale kassaflow voor een gekoppelde gast');
    }

    await this.prisma.$transaction([
      this.prisma.loyaltyCardPendingEntry.create({ data: { cardId: card.id, amount, reason } }),
      this.prisma.loyaltyCard.update({ where: { id: card.id }, data: { pendingBalance: { increment: amount } } }),
    ]);

    return { pendingBalance: Number(card.pendingBalance) + amount };
  }
}
