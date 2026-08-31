import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailgunService } from '../common/mailgun.service';
import { escapeHtml } from '../common/escape-html';
import { MollieService } from '../common/mollie.service';
import { RequestContext } from '../common/decorators/current-context.decorator';
import {
  IssueGiftCardDto,
  CreateBatchDto,
  ActivateGiftCardDto,
  RedeemGiftCardDto,
  TopUpGiftCardDto,
  BlockGiftCardDto,
  ReplaceGiftCardDto,
  AdjustGiftCardDto,
  RefundGiftCardDto,
  BulkPurchaseDto,
} from './dto/gift-cards.dto';

const MAX_BATCH_QUANTITY = 5000;
const MIN_GIFT_CARD_VALUE = 10; // onder dit bedrag wegen de vaste transactiekosten (Mollie e.d.) niet meer op tegen de waarde
const DEFAULT_GIFT_CARD_VALIDITY_YEARS = 2; // wettelijke/gangbare geldigheidstermijn — kan per kaart overschreven worden via dto.expiresAt

function defaultGiftCardExpiry(from: Date = new Date()): Date {
  const expiry = new Date(from);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + DEFAULT_GIFT_CARD_VALIDITY_YEARS);
  return expiry;
}

/** Consistente NL-datumnotatie voor "Geldig tot" — overal hetzelfde formaat (sticker, e-mail, portal, admin). */
function formatExpiryDateNL(date: Date): string {
  return date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Simpele formaatcheck — geen poging om elk technisch geldig e-mailadres
// te dekken, maar voldoende om overduidelijke tikfouten (geen @, geen
// domeinnaam) tegen te houden vóór er geld/een echte e-mail bij komt
// kijken. IssueGiftCardDto is een plain interface (geen class-validator-
// klasse), dus de globale ValidationPipe valideert dit NIET automatisch
// — vandaar deze expliciete check hier in de service.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(value: string | undefined): boolean {
  return !!value && EMAIL_PATTERN.test(value.trim());
}

/**
 * GiftCard -> GiftCardLedgerEntry — een volledig aparte boekhouding van
 * het loyaltytegoed (Customer -> Wallet -> WalletLedgerEntry). Een
 * kadobon heeft geen eigen Wallet; een Wallet heeft geen
 * kadobon-saldo. Het saldo van een kaart is ALTIJD de som van zijn
 * ledger — nooit rechtstreeks aangepast (getest: zie migratie-testlog).
 *
 * Bewuste architectuurkeuze tegen dubbele beloning: het VERKOPEN van een
 * kadobon loopt hier, in deze service, en raakt daarom nooit
 * /transactions of de reward engine — dat is de hele reden dat er geen
 * "geen loyalty bij kadobon-aankoop"-uitzondering ergens diep in de
 * reward-engine-code nodig is. Het latere GEBRUIK van een kadobon
 * als betaalmiddel loopt via een normale transactie (net als contant of
 * pin) en verdient daardoor gewoon normaal loyaltytegoed.
 */
@Injectable()
export class GiftCardsService {
  private readonly logger = new Logger(GiftCardsService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private mailgun: MailgunService,
    private mollie: MollieService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Gast-e-mailadres heeft GEEN unieke-constraint in het datamodel — er
   * kunnen dus meerdere gastrecords met hetzelfde e-mailadres bestaan
   * (bijv. één via Piggy-import, één handmatig aangemaakt, één via
   * portal-zelfregistratie). Een simpele findFirst() zou dan willekeurig
   * (databasevolgorde) het EERSTE record pakken — mogelijk niet het
   * account waar de gast daadwerkelijk op inlogt.
   *
   * Voorkeur, in volgorde:
   *   1. Een record met een wachtwoord ingesteld (bewijs dat dit account
   *      echt via de portal gebruikt wordt).
   *   2. Anders het meest recent aangemaakte record.
   */
  private async findBestMatchingCustomer(orgId: string, email: string): Promise<{ id: string } | null> {
    const candidates = await this.prisma.customer.findMany({
      where: { organizationId: orgId, email: { equals: email, mode: 'insensitive' }, deletedAt: null },
      select: { id: true, passwordHash: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    if (candidates.length === 0) return null;
    const withPassword = candidates.find((c) => !!c.passwordHash);
    return withPassword ?? candidates[0];
  }

  private generateToken(): string {
    return randomBytes(12).toString('base64url'); // 96 bits entropie, zelfde niveau als de loyaltykaarten
  }

  // -- Direct uitgeven (admin/kassa/online) — géén batch nodig -------------

  async issue(orgId: string, ctx: RequestContext, dto: IssueGiftCardDto) {
    if (dto.originalValue < MIN_GIFT_CARD_VALUE) throw new BadRequestException(`Minimaal bedrag is €${MIN_GIFT_CARD_VALUE} (i.v.m. transactiekosten)`);
    if (dto.recipientEmail && !isValidEmail(dto.recipientEmail)) {
      throw new BadRequestException('Het e-mailadres van de ontvanger lijkt niet geldig.');
    }
    if (dto.senderEmail && !isValidEmail(dto.senderEmail)) {
      throw new BadRequestException('Het e-mailadres van de afzender lijkt niet geldig.');
    }

    const existingCount = await this.prisma.giftCard.count({ where: { organizationId: orgId } });
    const token = this.generateToken();
    const giftCardNumber = 'GC-' + String(existingCount + 1).padStart(6, '0');

    // Als de medewerker alleen een vrij-tekst e-mailadres invulde (geen
    // expliciet gekozen gast via recipientCustomerId), toch proberen te
    // koppelen aan een bestaand account met dat e-mailadres — zelfde
    // gedachte als bij de online koop-flow.
    const resolvedRecipientCustomerId =
      dto.recipientCustomerId ?? (dto.recipientEmail ? (await this.findBestMatchingCustomer(orgId, dto.recipientEmail))?.id : undefined);

    const giftCard = await this.prisma.giftCard.create({
      data: {
        organizationId: orgId,
        giftCardNumber,
        publicTokenHash: this.hashToken(token),
        status: 'active',
        originalValue: dto.originalValue,
        currentBalance: dto.originalValue,
        locationIds: dto.locationIds ?? [],
        isPhysical: dto.isPhysical ?? false,
        purchaserCustomerId: dto.purchaserCustomerId,
        recipientCustomerId: resolvedRecipientCustomerId,
        recipientName: dto.recipientName,
        recipientEmail: dto.recipientEmail,
        senderName: dto.senderName,
        senderEmail: dto.senderEmail,
        personalMessage: dto.personalMessage,
        scheduledSendAt: dto.scheduledSendAt ? new Date(dto.scheduledSendAt) : undefined,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : defaultGiftCardExpiry(),
        activatedAt: new Date(),
      },
    });

    await this.prisma.giftCardLedgerEntry.create({
      data: {
        giftCardId: giftCard.id,
        organizationId: orgId,
        locationId: dto.locationIds?.[0],
        entryType: 'sale',
        amount: dto.originalValue,
        performedByUserId: ctx.actorId ?? undefined,
        reason: 'Kadobon uitgegeven',
      },
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'gift_card',
      entityId: giftCard.id,
      action: 'create',
      actor: ctx,
      afterState: { originalValue: dto.originalValue, giftCardNumber },
    });

    // Kritiek: als de kaart direct aan een BEKENDE gast gekoppeld wordt
    // (recipientCustomerId, i.p.v. een los recipientEmail-veld), is dit
    // token straks nergens anders meer terug te vinden — niet in de
    // portal, niet ergens anders. Zonder deze e-mail zou de gast zijn
    // eigen kaart dus nooit meer kunnen openen. Nooit een harde fout
    // laten optreden op de uitgifte zelf als het versturen mislukt —
    // de kaart is al geldig aangemaakt, dat mag niet teruggedraaid worden.
    let emailSent: boolean | undefined;
    if (dto.recipientCustomerId && !dto.recipientEmail) {
      const recipient = await this.prisma.customer.findFirst({ where: { id: dto.recipientCustomerId, organizationId: orgId }, select: { email: true } });
      if (recipient?.email) {
        await this.prisma.giftCard.update({ where: { id: giftCard.id }, data: { recipientEmail: recipient.email } });
        emailSent = await this.sendDigitalCard(orgId, giftCard.id, token)
          .then(() => true)
          .catch((err) => {
            this.logger.error(
              `Kadobon ${giftCardNumber} (${giftCard.id}) uitgegeven, maar e-mail naar ${recipient.email} mislukt: ${err instanceof Error ? err.message : err}`,
            );
            return false;
          });
      }
    }

    let senderConfirmationSent: boolean | undefined;
    if (dto.senderEmail) {
      senderConfirmationSent = await this.sendPurchaseConfirmationToSender(orgId, [giftCard.id])
        .then(() => true)
        .catch((err) => {
          this.logger.error(
            `Kadobon ${giftCardNumber} (${giftCard.id}) uitgegeven, maar bevestigingsmail naar afzender ${dto.senderEmail} mislukt: ${err instanceof Error ? err.message : err}`,
          );
          return false;
        });
    }

    return { giftCardId: giftCard.id, giftCardNumber, token, currentBalance: dto.originalValue, emailSent, senderConfirmationSent, expiresAt: giftCard.expiresAt };
  }

  /**
   * Verstuurt de digitale kadobon per e-mail — vereist het RUWE
   * token als parameter (net als bij batches: dat bestaat alleen op het
   * moment van uitgeven, wordt nooit opgeslagen). Bedoeld om direct na
   * `issue()` aangeroepen te worden, met het token uit dát antwoord.
   *
   * Geplande verzending (`scheduledSendAt`, bijv. op iemands verjaardag)
   * wordt wél opgeslagen op de kaart, maar er is in deze omgeving geen
   * achtergrond-scheduler die dat veld op de juiste dag daadwerkelijk
   * afvuurt — dat zou, net als de dagafsluiting-e-mail, een eigen cron-
   * endpoint nodig hebben. Bewust niet gebouwd in deze stap; direct
   * versturen werkt nu al volledig.
   */
  async sendDigitalCard(orgId: string, giftCardId: string, rawToken: string) {
    const giftCard = await this.getCardOrThrow(orgId, giftCardId);
    if (giftCard.publicTokenHash !== this.hashToken(rawToken)) {
      throw new BadRequestException('Token komt niet overeen met deze kaart');
    }
    if (!giftCard.recipientEmail) throw new BadRequestException('Geen ontvanger-e-mailadres bekend voor deze kaart');

    const qrUrl = `https://loyalty-platform-live.vercel.app/g/${rawToken}`;
    const amountText = '€' + Number(giftCard.originalValue).toFixed(2);
    const greeting = giftCard.recipientName ? `Beste ${giftCard.recipientName},` : 'Beste,';
    const greetingHtml = giftCard.recipientName ? `Beste ${escapeHtml(giftCard.recipientName)},` : 'Beste,';
    const messageBlock = giftCard.personalMessage ? `\n\n"${giftCard.personalMessage}"\n` : '';
    const validityNote = 'Je kaart is te besteden bij zowel Het Strand als Zomers Beachclub & Brewery.';
    const expiryNote = giftCard.expiresAt ? `Geldig tot ${formatExpiryDateNL(giftCard.expiresAt)}.` : '';

    const result = await this.mailgun.sendEmail(
      giftCard.recipientEmail,
      `Je hebt een kadobon ter waarde van ${amountText} ontvangen!`,
      `${greeting}${messageBlock}\n\nJe hebt een kadobon ontvangen ter waarde van ${amountText}.\n\n${validityNote} ${expiryNote}\n\nBekijk en gebruik je kaart via: ${qrUrl}\n\nVeel plezier!`,
      `<p>${greetingHtml}</p>${giftCard.personalMessage ? `<p><em>"${escapeHtml(giftCard.personalMessage)}"</em></p>` : ''}<p>Je hebt een kadobon ontvangen ter waarde van <strong>${amountText}</strong>.</p><p>${validityNote} ${expiryNote}</p><p><a href="${qrUrl}">Bekijk en gebruik je kaart</a></p><p>Veel plezier!</p>`,
    );

    if (!result.sent) throw new BadRequestException('Versturen mislukt: ' + (result.reason || 'onbekende fout'));
    return { sent: true };
  }

  // -- Online verkoop via Mollie (iDEAL e.d.) --------------------------------

  /**
   * Start een online aankoop: maakt een kadobon aan met status
   * 'draft' (dus GEEN saldo, GEEN ledger-entry — de kaart telt pas mee
   * zodra de betaling écht bevestigd is) en een bijbehorende Mollie-
   * betaling. Het ruwe token gaat NIET de database in, maar wél mee in
   * Mollie's metadata — dat is de enige plek waar het bewaard blijft
   * totdat de betaling bevestigd wordt en de kaart écht geactiveerd kan
   * worden.
   */
  async startOnlinePurchase(
    orgId: string,
    dto: IssueGiftCardDto,
    publicAppUrl: string,
  ): Promise<{ checkoutUrl: string } | { checkoutUrl: null; reason: string }> {
    if (dto.originalValue < MIN_GIFT_CARD_VALUE) throw new BadRequestException(`Minimaal bedrag is €${MIN_GIFT_CARD_VALUE} (i.v.m. transactiekosten)`);
    if (!this.mollie.isConfigured()) {
      return { checkoutUrl: null, reason: 'Online betalen is nog niet ingesteld — neem contact op met de zaak.' };
    }

    // Afzendergegevens zijn bij een ONLINE aankoop altijd verplicht (de
    // koper betaalt zelf en moet een bevestiging kunnen krijgen) — in
    // tegenstelling tot de admin/POS-uitgifte, waar een medewerker een
    // kaart ook zonder deze gegevens mag aanmaken (bijv. contant aan de
    // balie, geen digitale bevestiging nodig).
    if (!dto.senderName || !dto.senderName.trim()) {
      throw new BadRequestException('Vul je naam in.');
    }
    if (!isValidEmail(dto.senderEmail)) {
      throw new BadRequestException('Vul een geldig e-mailadres in (voor je aankoopbevestiging).');
    }
    if (dto.recipientEmail && !isValidEmail(dto.recipientEmail)) {
      throw new BadRequestException('Het e-mailadres van de ontvanger lijkt niet geldig.');
    }

    const existingCount = await this.prisma.giftCard.count({ where: { organizationId: orgId } });
    const token = this.generateToken();
    const giftCardNumber = 'GC-' + String(existingCount + 1).padStart(6, '0');

    const giftCard = await this.prisma.giftCard.create({
      data: {
        organizationId: orgId,
        giftCardNumber,
        publicTokenHash: this.hashToken(token),
        status: 'draft',
        originalValue: dto.originalValue,
        currentBalance: 0,
        recipientName: dto.recipientName,
        recipientEmail: dto.recipientEmail,
        senderName: dto.senderName.trim(),
        senderEmail: dto.senderEmail!.trim(),
        personalMessage: dto.personalMessage,
        scheduledSendAt: dto.scheduledSendAt ? new Date(dto.scheduledSendAt) : undefined,
      },
    });

    const paymentResult = await this.mollie.createPayment({
      amount: dto.originalValue,
      description: `Kadobon ${giftCardNumber} (€${dto.originalValue.toFixed(2)})`,
      redirectUrl: `${publicAppUrl}/gift-cards/thank-you/${giftCard.id}${dto.brand ? '?brand=' + encodeURIComponent(dto.brand) : ''}`,
      webhookUrl: `${publicAppUrl}/gift-cards/mollie-webhook`,
      metadata: { giftCardId: giftCard.id, organizationId: orgId, rawToken: token },
    });

    if (!paymentResult.created) {
      await this.prisma.giftCard.update({ where: { id: giftCard.id }, data: { status: 'cancelled' } });
      return { checkoutUrl: null, reason: paymentResult.reason };
    }

    await this.prisma.giftCard.update({ where: { id: giftCard.id }, data: { molliePaymentId: paymentResult.payment.id } });

    const checkoutUrl = paymentResult.payment._links.checkout?.href;
    if (!checkoutUrl) {
      return { checkoutUrl: null, reason: 'Mollie gaf geen checkout-link terug' };
    }
    return { checkoutUrl };
  }

  /**
   * Zelfde als startOnlinePurchase, maar voor MEERDERE kadobonnen in
   * één keer (elk met een eigen bedrag/ontvanger, gedeelde afzender) —
   * bijv. voor een bedrijf dat in één keer vijf kadobonnen voor
   * verschillende collega's koopt. Eén Mollie-betaling voor het
   * totaalbedrag; confirmMolliePayment activeert bij bevestiging alle
   * kaarten die bij deze betaling horen.
   */
  async startBulkOnlinePurchase(
    orgId: string,
    dto: BulkPurchaseDto,
    publicAppUrl: string,
  ): Promise<{ checkoutUrl: string } | { checkoutUrl: null; reason: string }> {
    if (!this.mollie.isConfigured()) {
      return { checkoutUrl: null, reason: 'Online betalen is nog niet ingesteld — neem contact op met de zaak.' };
    }
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Geen kadobonnen opgegeven');
    }
    const MAX_BULK_ITEMS = 25; // ruim voldoende voor een zakelijke bestelling, voorkomt misbruik/timeouts
    if (dto.items.length > MAX_BULK_ITEMS) {
      throw new BadRequestException(`Maximaal ${MAX_BULK_ITEMS} kadobonnen per bestelling`);
    }
    if (!dto.senderName || !dto.senderName.trim()) {
      throw new BadRequestException('Vul je naam in.');
    }
    if (!isValidEmail(dto.senderEmail)) {
      throw new BadRequestException('Vul een geldig e-mailadres in (voor je aankoopbevestiging).');
    }
    for (const item of dto.items) {
      if (item.originalValue < MIN_GIFT_CARD_VALUE) {
        throw new BadRequestException(`Minimaal bedrag per kaart is €${MIN_GIFT_CARD_VALUE} (i.v.m. transactiekosten)`);
      }
      if (item.recipientEmail && !isValidEmail(item.recipientEmail)) {
        throw new BadRequestException(`Het e-mailadres van ontvanger "${item.recipientName || item.recipientEmail}" lijkt niet geldig.`);
      }
    }

    const existingCount = await this.prisma.giftCard.count({ where: { organizationId: orgId } });
    const createdCards: { id: string; giftCardNumber: string }[] = [];
    for (let i = 0; i < dto.items.length; i++) {
      const item = dto.items[i];
      const token = this.generateToken();
      const giftCardNumber = 'GC-' + String(existingCount + 1 + i).padStart(6, '0');
      const giftCard = await this.prisma.giftCard.create({
        data: {
          organizationId: orgId,
          giftCardNumber,
          publicTokenHash: this.hashToken(token),
          status: 'draft',
          originalValue: item.originalValue,
          currentBalance: 0,
          recipientName: item.recipientName,
          recipientEmail: item.recipientEmail,
          senderName: dto.senderName.trim(),
          senderEmail: dto.senderEmail.trim(),
          personalMessage: item.personalMessage,
        },
      });
      createdCards.push({ id: giftCard.id, giftCardNumber: giftCard.giftCardNumber });
    }

    const totalAmount = dto.items.reduce((sum, item) => sum + item.originalValue, 0);
    // Mollie kent de redirectUrl pas ná het aanmaken van de betaling nog
    // niet het eigen payment-ID — we gebruiken daarom het ID van de
    // EERSTE aangemaakte kaart als kenmerk in de URL. De bedankpagina
    // zoekt die kaart op, leest daarvan molliePaymentId (dat hieronder,
    // vóór de checkout-redirect, al gezet wordt) en haalt daarmee alle
    // bijbehorende kaarten van dezelfde betaling op.
    const paymentResult = await this.mollie.createPayment({
      amount: totalAmount,
      description: `${createdCards.length} kadobonnen (${createdCards.map((c) => c.giftCardNumber).join(', ')})`,
      redirectUrl: `${publicAppUrl}/gift-cards/thank-you-bulk/${createdCards[0].id}${dto.brand ? '?brand=' + encodeURIComponent(dto.brand) : ''}`,
      webhookUrl: `${publicAppUrl}/gift-cards/mollie-webhook`,
      metadata: { organizationId: orgId, giftCardIds: createdCards.map((c) => c.id), bulk: true },
    });

    if (!paymentResult.created) {
      await this.prisma.giftCard.updateMany({ where: { id: { in: createdCards.map((c) => c.id) } }, data: { status: 'cancelled' } });
      return { checkoutUrl: null, reason: paymentResult.reason };
    }

    await this.prisma.giftCard.updateMany({ where: { id: { in: createdCards.map((c) => c.id) } }, data: { molliePaymentId: paymentResult.payment.id } });

    const checkoutUrl = paymentResult.payment._links.checkout?.href;
    if (!checkoutUrl) {
      return { checkoutUrl: null, reason: 'Mollie gaf geen checkout-link terug' };
    }
    return { checkoutUrl };
  }

  /**
   * Wordt aangeroepen door de Mollie-webhook (alleen een `id`, geen
   * status — zie MollieService voor waarom). Haalt de ECHTE status vers
   * op bij Mollie zelf, en activeert de kaart(en) alleen als die status
   * daadwerkelijk 'paid' is. Idempotent: als de kaart al actief is
   * (bijv. Mollie roept de webhook twee keer aan), gebeurt er niets
   * extra — voorkomt dubbele ledger-entries. Verwerkt óók bulk-
   * aankopen (meerdere kaarten per betaling) — zie startBulkOnlinePurchase.
   */
  async confirmMolliePayment(molliePaymentId: string): Promise<{ processed: boolean }> {
    const draftCards = await this.prisma.giftCard.findMany({ where: { molliePaymentId, status: 'draft' } });
    if (draftCards.length === 0) {
      // Geen draft-kaarten (meer) voor deze betaling — ofwel een
      // onbekende betaling (niets van ons), ofwel al eerder volledig
      // verwerkt/geannuleerd (idempotent, geen dubbele boeking).
      const anyCardForPayment = await this.prisma.giftCard.findFirst({ where: { molliePaymentId }, select: { id: true } });
      return { processed: !!anyCardForPayment };
    }

    const payment = await this.mollie.getPayment(molliePaymentId);
    if (!payment || payment.status !== 'paid') {
      return { processed: true }; // nog niet (of niet meer) betaald — nog niets te activeren
    }

    const activatedCardIds: string[] = [];
    for (const giftCard of draftCards) {
      // Koppel de kaart automatisch aan een BESTAAND gastaccount met
      // hetzelfde e-mailadres, zodat die 'm meteen ziet staan onder
      // "Kadobonnen" in Mijn Tegoed — zonder dat de koper of
      // ontvanger daar iets voor hoeft te doen. Bewust GEEN nieuw
      // account aanmaken als er nog geen match is: dat zou een account
      // aanmaken zonder toestemming/verificatie van de ontvanger. In
      // dat geval blijft de kaart gewoon bereikbaar via de e-mail met
      // de losse kaartlink/QR, exact zoals nu al het geval is.
      let recipientCustomerId: string | undefined;
      if (giftCard.recipientEmail) {
        const matchingCustomer = await this.findBestMatchingCustomer(giftCard.organizationId, giftCard.recipientEmail);
        recipientCustomerId = matchingCustomer?.id;
      }

      // Wanneer er een ontvanger-e-mailadres is, genereren we hier een
      // VERS token in plaats van te vertrouwen op het teruglezen van
      // het oorspronkelijke token uit Mollie's metadata — dat teruglezen
      // bleek in de praktijk niet altijd betrouwbaar, en faalde daarbij
      // volledig stil. Dit nieuwe token is nooit eerder aan iemand
      // getoond, dus vervangen is altijd veilig.
      const freshRecipientToken = giftCard.recipientEmail ? this.generateToken() : undefined;

      // Atomair CLAIMEN van de activering per kaart: de where-clause
      // herhaalt de status='draft'-voorwaarde in de UPDATE zelf, en de
      // claim + ledger-entry zitten samen in één transactie. Voorkomt
      // dubbele activering/mailen/boeking bij (bijna-)gelijktijdige
      // webhook-aanroepen — Postgres serialiseert dit vanzelf via de
      // rij-lock. Eén mislukte kaart in de batch (zeldzaam, alleen bij
      // een racende gelijktijdige aanroep) blokkeert de rest van de
      // batch niet — we gaan gewoon door met de volgende kaart.
      const claimed = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.giftCard.updateMany({
          where: { id: giftCard.id, status: 'draft' },
          data: {
            status: 'active',
            currentBalance: giftCard.originalValue,
            activatedAt: new Date(),
            expiresAt: defaultGiftCardExpiry(),
            recipientCustomerId,
            ...(freshRecipientToken ? { publicTokenHash: this.hashToken(freshRecipientToken) } : {}),
          },
        });
        if (claim.count === 0) return false;

        await tx.giftCardLedgerEntry.create({
          data: {
            giftCardId: giftCard.id,
            organizationId: giftCard.organizationId,
            entryType: 'sale',
            amount: giftCard.originalValue,
            reason: 'Online verkocht via Mollie (' + molliePaymentId + ')',
            metadata: { molliePaymentId },
          },
        });
        return true;
      });
      if (!claimed) continue; // de andere, gelijktijdige aanroep won de race voor DEZE kaart

      await this.audit.record({
        organizationId: giftCard.organizationId,
        entityType: 'gift_card',
        entityId: giftCard.id,
        action: 'update',
        actor: { actorType: 'system', actorId: null, ipAddress: null },
        beforeState: { status: 'draft' },
        afterState: { status: 'active' },
        reason: `Online betaling bevestigd via Mollie — afzender ${giftCard.senderName ?? 'onbekend'} <${giftCard.senderEmail ?? 'onbekend'}>, ontvanger ${giftCard.recipientName ?? '(geen naam opgegeven)'} <${giftCard.recipientEmail ?? '(geen e-mail opgegeven)'}>`,
      });

      if (giftCard.recipientEmail && freshRecipientToken) {
        await this.sendDigitalCard(giftCard.organizationId, giftCard.id, freshRecipientToken).catch((err) => {
          // Bewust geen harde fout hier — de betaling en activering zijn
          // al veiliggesteld; een mislukte e-mail mag dat nooit
          // terugdraaien. WEL duidelijk loggen (zichtbaar in Vercel →
          // project → Logs), anders lijkt een online kadobon-aankoop
          // stil te verdwijnen zonder dat iemand het merkt.
          this.logger.error(
            `Kadobon ${giftCard.giftCardNumber} (${giftCard.id}) betaald, maar e-mail naar ${giftCard.recipientEmail} mislukt: ${err instanceof Error ? err.message : err}`,
          );
        });
      } else if (giftCard.recipientEmail && !freshRecipientToken) {
        this.logger.error(
          `Kadobon ${giftCard.giftCardNumber} (${giftCard.id}) heeft een ontvanger-e-mailadres (${giftCard.recipientEmail}) maar geen token om te versturen — niet verstuurd.`,
        );
      }

      activatedCardIds.push(giftCard.id);
    }

    // ÉÉN gecombineerde bevestigingsmail aan de afzender voor de hele
    // batch (bij een enkele aankoop dus gewoon 1 kaart) — nooit N losse
    // mails bij een bulk-aankoop.
    if (activatedCardIds.length > 0 && draftCards[0].senderEmail) {
      await this.sendPurchaseConfirmationToSender(draftCards[0].organizationId, activatedCardIds).catch((err) => {
        this.logger.error(
          `${activatedCardIds.length} kadobon(en) betaald (betaling ${molliePaymentId}), maar bevestigingsmail naar afzender ${draftCards[0].senderEmail} mislukt: ${err instanceof Error ? err.message : err}`,
        );
      });
    }

    return { processed: true };
  }

  /**
   * Aparte bevestigingsmail aan de KOPER (afzender) zelf — bewust NOOIT
   * de kaart-token/QR of een bruikbare kadobon-code hierin, alleen
   * bevestiging + samenvatting. De daadwerkelijke kaart(en) gaan
   * uitsluitend naar de ontvanger(s) via sendDigitalCard hierboven.
   *
   * Accepteert een LIJST kaart-id's zodat één bulk-aankoop (meerdere
   * ontvangers/bedragen, één betaling) ook één gecombineerde
   * bevestiging oplevert in plaats van N losse mails — voor een enkele
   * aankoop is dat gewoon een array met 1 element, exact hetzelfde
   * gedrag als voorheen.
   */
  private async sendPurchaseConfirmationToSender(orgId: string, giftCardIds: string[]): Promise<void> {
    const giftCards = await this.prisma.giftCard.findMany({ where: { id: { in: giftCardIds }, organizationId: orgId } });
    if (giftCards.length === 0) return;
    const senderEmail = giftCards[0].senderEmail;
    if (!senderEmail) return;
    if (giftCards.every((g) => g.senderConfirmationSentAt)) return; // extra vangnet, los van de atomaire claim in confirmMolliePayment

    const purchaseDate = (giftCards[0].activatedAt ?? giftCards[0].issuedAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });

    let subject: string;
    let lines: string[];
    if (giftCards.length === 1) {
      const giftCard = giftCards[0];
      const amount = Number(giftCard.originalValue).toFixed(2).replace('.', ',');
      const recipientLine = giftCard.recipientEmail
        ? `Verstuurd naar: ${giftCard.recipientEmail}`
        : 'Er is geen ontvanger-e-mailadres opgegeven — je vindt de kaart terug op de bedankpagina die je na de betaling zag.';
      subject = 'Je kadobon is succesvol verstuurd';
      lines = [
        'Je kadobon is succesvol verstuurd',
        '',
        `Bedrag: €${amount}`,
        `Ontvanger: ${giftCard.recipientName || '(geen naam opgegeven)'}`,
        recipientLine,
        `Van: ${giftCard.senderName ?? ''}`,
        giftCard.personalMessage ? `Persoonlijke boodschap: "${giftCard.personalMessage}"` : undefined,
        `Ordernummer: ${giftCard.giftCardNumber}`,
        `Datum van aankoop: ${purchaseDate}`,
        giftCard.expiresAt ? `Geldig tot: ${formatExpiryDateNL(giftCard.expiresAt)}` : undefined,
        '',
        'Te besteden bij zowel Het Strand als Zomers Beachclub & Brewery.',
      ].filter((line): line is string => line !== undefined);
    } else {
      const totalAmount = giftCards.reduce((sum, g) => sum + Number(g.originalValue), 0).toFixed(2).replace('.', ',');
      subject = `Je ${giftCards.length} kadobonnen zijn succesvol verstuurd`;
      lines = [
        `Je ${giftCards.length} kadobonnen zijn succesvol verstuurd`,
        '',
        `Totaalbedrag: €${totalAmount}`,
        `Van: ${giftCards[0].senderName ?? ''}`,
        '',
        'Overzicht:',
        ...giftCards.map((g) => {
          const amount = Number(g.originalValue).toFixed(2).replace('.', ',');
          const recipient = g.recipientEmail ? `${g.recipientName || '(geen naam)'} <${g.recipientEmail}>` : '(voor jezelf, geen ontvanger-e-mail opgegeven)';
          const expiry = g.expiresAt ? `, geldig tot ${formatExpiryDateNL(g.expiresAt)}` : '';
          return `- ${g.giftCardNumber}: €${amount} — ${recipient}${expiry}`;
        }),
        '',
        `Datum van aankoop: ${purchaseDate}`,
        '',
        'Te besteden bij zowel Het Strand als Zomers Beachclub & Brewery.',
      ];
    }

    const emailResult = await this.mailgun.sendEmail(senderEmail, subject, lines.join('\n'));
    if (!emailResult.sent) {
      throw new Error(emailResult.reason || 'Mailgun gaf geen reden voor de mislukking');
    }

    await this.prisma.giftCard.updateMany({ where: { id: { in: giftCardIds } }, data: { senderConfirmationSentAt: new Date() } });
  }

  /**
   * Koppelt bestaande, nog niet gekoppelde kadobonnen met.recipientEmail
   * gelijk aan dit e-mailadres alsnog aan dit gastaccount — dekt precies
   * de omgekeerde volgorde van de automatische koppeling in
   * confirmMolliePayment (die alleen koppelt als het account op het
   * moment van BETALEN al bestond). Als iemand pas ÁCHTERAF een account
   * aanmaakt met hetzelfde e-mailadres als waar een kadobon eerder
   * naartoe gestuurd is, zag die de kaart tot nu toe niet staan in Mijn
   * Tegoed — dit repareert dat alsnog, op het moment van accountaanmaak.
   * Bewust alleen 'active' kaarten (nooit 'draft', die zijn nog niet
   * betaald) en alleen kaarten die nog geen koppeling hebben (nooit een
   * bestaande koppeling overschrijven).
   */
  async linkUnclaimedGiftCardsToCustomer(orgId: string, customerId: string, email: string): Promise<number> {
    if (!email) return 0;
    const result = await this.prisma.giftCard.updateMany({
      where: { organizationId: orgId, recipientEmail: { equals: email, mode: 'insensitive' }, recipientCustomerId: null, status: 'active' },
      data: { recipientCustomerId: customerId },
    });
    return result.count;
  }

  // -- Batches met lege fysieke kaarten (later bij POS geactiveerd) --------

  async createBatch(orgId: string, ctx: RequestContext, dto: CreateBatchDto) {
    if (dto.quantity < 1 || dto.quantity > MAX_BATCH_QUANTITY) {
      throw new BadRequestException(`Aantal moet tussen 1 en ${MAX_BATCH_QUANTITY} liggen.`);
    }

    const batch = await this.prisma.giftCardBatch.create({
      data: { organizationId: orgId, locationId: dto.locationId, name: dto.name, quantity: dto.quantity, status: 'generating' },
    });

    const existingCount = await this.prisma.giftCard.count({ where: { organizationId: orgId } });
    const cardLocationIds = dto.locationId ? [dto.locationId] : [];
    const cardsToInsert: { organizationId: string; locationIds: string[]; batchId: string; publicTokenHash: string; giftCardNumber: string; originalValue: number }[] = [];
    const exportRows: { giftCardNumber: string; token: string; qrUrl: string }[] = [];

    for (let i = 0; i < dto.quantity; i++) {
      const token = this.generateToken();
      const giftCardNumber = 'GC-' + String(existingCount + i + 1).padStart(6, '0');
      cardsToInsert.push({
        organizationId: orgId,
        locationIds: cardLocationIds,
        batchId: batch.id,
        publicTokenHash: this.hashToken(token),
        giftCardNumber,
        originalValue: 0, // pas bekend bij activering aan de kassa
      });
      exportRows.push({ giftCardNumber, token, qrUrl: `https://loyalty-platform-live.vercel.app/g/${token}` });
    }

    await this.prisma.giftCard.createMany({ data: cardsToInsert.map((c) => ({ ...c, status: 'draft' as const })) });
    await this.prisma.giftCardBatch.update({ where: { id: batch.id }, data: { status: 'exported', exportedAt: new Date() } });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'gift_card_batch',
      entityId: batch.id,
      action: 'create',
      actor: ctx,
      afterState: { name: dto.name, quantity: dto.quantity },
    });

    return { batchId: batch.id, name: dto.name, quantity: dto.quantity, cards: exportRows };
  }

  // -- Lege fysieke kaart activeren bij de kassa ---------------------------

  async activate(orgId: string, ctx: RequestContext, dto: ActivateGiftCardDto) {
    if (dto.originalValue < MIN_GIFT_CARD_VALUE) throw new BadRequestException(`Minimaal bedrag is €${MIN_GIFT_CARD_VALUE} (i.v.m. transactiekosten)`);

    const giftCard = await this.prisma.giftCard.findUnique({ where: { publicTokenHash: this.hashToken(dto.token) } });
    if (!giftCard) throw new NotFoundException('Kadobon niet gevonden');
    if (giftCard.organizationId !== orgId) throw new NotFoundException('Kadobon niet gevonden');
    if (giftCard.status !== 'draft') throw new ConflictException('Deze kaart is al geactiveerd of niet meer geldig');

    await this.prisma.$transaction([
      this.prisma.giftCard.update({
        where: { id: giftCard.id },
        data: {
          status: 'active',
          originalValue: dto.originalValue,
          currentBalance: dto.originalValue,
          activatedAt: new Date(),
          expiresAt: defaultGiftCardExpiry(),
          isPhysical: true, // vooraf gedrukte batch-kaart, per definitie fysiek
          purchaserCustomerId: dto.purchaserCustomerId,
          recipientCustomerId: dto.recipientCustomerId,
        },
      }),
      this.prisma.giftCardLedgerEntry.create({
        data: {
          giftCardId: giftCard.id,
          organizationId: orgId,
          entryType: 'sale',
          amount: dto.originalValue,
          performedByUserId: ctx.actorId ?? undefined,
          reason: 'Fysieke kaart geactiveerd bij kassa',
        },
      }),
    ]);

    await this.audit.record({
      organizationId: orgId,
      entityType: 'gift_card',
      entityId: giftCard.id,
      action: 'update',
      actor: ctx,
      beforeState: { status: 'draft' },
      afterState: { status: 'active', originalValue: dto.originalValue },
      reason: 'Kaart geactiveerd',
    });

    return { giftCardId: giftCard.id, giftCardNumber: giftCard.giftCardNumber, currentBalance: dto.originalValue };
  }

  // -- Inwisselen (volledig of gedeeltelijk) --------------------------------

  async redeem(orgId: string, ctx: RequestContext, dto: RedeemGiftCardDto) {
    if (dto.amount <= 0) throw new BadRequestException('Bedrag moet groter dan €0 zijn');

    const giftCard = await this.prisma.giftCard.findUnique({ where: { publicTokenHash: this.hashToken(dto.token) } });
    if (!giftCard) throw new NotFoundException('Kadobon niet gevonden');
    if (giftCard.organizationId !== orgId) throw new NotFoundException('Kadobon niet gevonden');
    if (giftCard.status !== 'active' && giftCard.status !== 'partially_redeemed') {
      throw new ConflictException(`Deze kaart heeft status "${giftCard.status}" en kan niet worden ingewisseld`);
    }
    if (giftCard.expiresAt && giftCard.expiresAt < new Date()) {
      throw new ConflictException(`Deze kaart is verlopen op ${giftCard.expiresAt.toLocaleDateString('nl-NL')} en kan niet meer worden ingewisseld`);
    }
    // Locatiescope daadwerkelijk afdwingen — leeg array = organisatiebreed
    // (bruikbaar bij zowel Het Strand als Zomers), gevuld array beperkt
    // tot precies die locatie(s). Zelfde controle als bij vouchers.
    if (giftCard.locationIds.length > 0 && dto.locationId && !giftCard.locationIds.includes(dto.locationId)) {
      throw new ForbiddenException('Deze kadobon is niet geldig op deze locatie');
    }
    const currentBalance = Number(giftCard.currentBalance);
    if (dto.amount > currentBalance) {
      throw new BadRequestException(`Onvoldoende saldo — beschikbaar: €${currentBalance.toFixed(2)}`);
    }

    const newBalance = currentBalance - dto.amount;
    const newStatus = newBalance === 0 ? 'redeemed' : 'partially_redeemed';

    const ledgerEntry = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.giftCardLedgerEntry.create({
        data: {
          giftCardId: giftCard.id,
          organizationId: orgId,
          entryType: 'redeem',
          amount: -dto.amount,
          transactionId: dto.transactionId,
          performedByUserId: ctx.actorId ?? undefined,
          reason: dto.reason || 'Besteed bij aankoop',
        },
      });
      await tx.giftCard.update({ where: { id: giftCard.id }, data: { currentBalance: newBalance, status: newStatus } });
      return entry;
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'gift_card',
      entityId: giftCard.id,
      action: 'update',
      actor: ctx,
      beforeState: { currentBalance },
      afterState: { currentBalance: newBalance, status: newStatus },
      reason: dto.reason || 'Ingewisseld',
    });

    return { giftCardId: giftCard.id, giftCardNumber: giftCard.giftCardNumber, redeemedAmount: dto.amount, remainingBalance: newBalance, status: newStatus, ledgerEntryId: ledgerEntry.id };
  }

  async topUp(orgId: string, ctx: RequestContext, giftCardId: string, dto: TopUpGiftCardDto) {
    if (dto.amount <= 0) throw new BadRequestException('Bedrag moet groter dan €0 zijn');
    const giftCard = await this.getCardOrThrow(orgId, giftCardId);
    if (giftCard.status === 'blocked' || giftCard.status === 'cancelled' || giftCard.status === 'expired') {
      throw new ConflictException(`Deze kaart heeft status "${giftCard.status}" en kan niet worden opgewaardeerd`);
    }

    const newBalance = Number(giftCard.currentBalance) + dto.amount;
    await this.prisma.$transaction([
      this.prisma.giftCardLedgerEntry.create({
        data: {
          giftCardId: giftCard.id,
          organizationId: orgId,
          entryType: 'top_up',
          amount: dto.amount,
          performedByUserId: ctx.actorId ?? undefined,
          reason: dto.reason || 'Opgewaardeerd',
        },
      }),
      this.prisma.giftCard.update({ where: { id: giftCard.id }, data: { currentBalance: newBalance, status: 'active' } }),
    ]);

    await this.audit.record({
      organizationId: orgId,
      entityType: 'gift_card',
      entityId: giftCard.id,
      action: 'update',
      actor: ctx,
      beforeState: { currentBalance: Number(giftCard.currentBalance) },
      afterState: { currentBalance: newBalance },
      reason: dto.reason || 'Opgewaardeerd',
    });

    return { giftCardId: giftCard.id, currentBalance: newBalance };
  }

  // -- Refund / reversal (tegenboeking, nooit het saldoveld direct wijzigen) --

  async refundLedgerEntry(orgId: string, ctx: RequestContext, giftCardId: string, dto: RefundGiftCardDto) {
    const giftCard = await this.getCardOrThrow(orgId, giftCardId);
    const originalEntry = await this.prisma.giftCardLedgerEntry.findFirst({ where: { id: dto.ledgerEntryId, giftCardId: giftCard.id } });
    if (!originalEntry) throw new NotFoundException('Oorspronkelijke boeking niet gevonden');

    const reversalAmount = -Number(originalEntry.amount);
    const newBalance = Number(giftCard.currentBalance) + reversalAmount;
    if (newBalance < 0) throw new BadRequestException('Terugboeken zou een negatief saldo veroorzaken');

    const reversal = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.giftCardLedgerEntry.create({
        data: {
          giftCardId: giftCard.id,
          organizationId: orgId,
          entryType: 'reversal',
          amount: reversalAmount,
          performedByUserId: ctx.actorId ?? undefined,
          reason: dto.reason || `Terugboeking van boeking ${originalEntry.id.slice(0, 8)}…`,
          metadata: { reversalOf: originalEntry.id },
        },
      });
      await tx.giftCard.update({
        where: { id: giftCard.id },
        data: { currentBalance: newBalance, status: newBalance > 0 ? 'active' : giftCard.status },
      });
      return entry;
    });

    await this.audit.record({
      organizationId: orgId,
      entityType: 'gift_card',
      entityId: giftCard.id,
      action: 'update',
      actor: ctx,
      beforeState: { currentBalance: Number(giftCard.currentBalance) },
      afterState: { currentBalance: newBalance },
      reason: 'Terugboeking',
    });

    return { reversalLedgerEntryId: reversal.id, newBalance };
  }

  async manualAdjustment(orgId: string, ctx: RequestContext, giftCardId: string, dto: AdjustGiftCardDto) {
    const giftCard = await this.getCardOrThrow(orgId, giftCardId);
    const newBalance = Number(giftCard.currentBalance) + dto.amount;
    if (newBalance < 0) throw new BadRequestException('Correctie zou een negatief saldo veroorzaken');

    await this.prisma.$transaction([
      this.prisma.giftCardLedgerEntry.create({
        data: {
          giftCardId: giftCard.id,
          organizationId: orgId,
          entryType: 'adjustment',
          amount: dto.amount,
          performedByUserId: ctx.actorId ?? undefined,
          reason: dto.reason,
        },
      }),
      this.prisma.giftCard.update({ where: { id: giftCard.id }, data: { currentBalance: newBalance } }),
    ]);

    await this.audit.record({
      organizationId: orgId,
      entityType: 'gift_card',
      entityId: giftCard.id,
      action: 'update',
      actor: ctx,
      beforeState: { currentBalance: Number(giftCard.currentBalance) },
      afterState: { currentBalance: newBalance },
      reason: dto.reason,
    });

    return { currentBalance: newBalance };
  }

  // -- Blokkeren, vervangen (saldo verplaatst, nooit gekopieerd) -----------

  async block(orgId: string, ctx: RequestContext, giftCardId: string, dto: BlockGiftCardDto) {
    const giftCard = await this.getCardOrThrow(orgId, giftCardId);
    const updated = await this.prisma.giftCard.update({
      where: { id: giftCard.id },
      data: { status: 'blocked', blockedAt: new Date(), blockedReason: dto.reason },
    });
    await this.audit.record({
      organizationId: orgId, entityType: 'gift_card', entityId: giftCard.id, action: 'update', actor: ctx,
      beforeState: { status: giftCard.status }, afterState: { status: 'blocked' }, reason: dto.reason,
    });
    return updated;
  }

  async replace(orgId: string, ctx: RequestContext, oldCardId: string, dto: ReplaceGiftCardDto) {
    const oldCard = await this.getCardOrThrow(orgId, oldCardId);
    const newCard = await this.prisma.giftCard.findUnique({ where: { publicTokenHash: this.hashToken(dto.newCardToken) } });
    if (!newCard || newCard.organizationId !== orgId) throw new NotFoundException('Nieuwe kaart niet gevonden');
    if (newCard.status !== 'draft') throw new ConflictException('De nieuwe kaart is al in gebruik');

    const balance = Number(oldCard.currentBalance);

    await this.prisma.$transaction([
      this.prisma.giftCard.update({
        where: { id: oldCard.id },
        data: { status: 'redeemed', currentBalance: 0, replacedByGiftCardId: newCard.id, blockedAt: oldCard.blockedAt ?? new Date(), blockedReason: oldCard.blockedReason ?? (dto.reason || 'Vervangen') },
      }),
      this.prisma.giftCard.update({
        where: { id: newCard.id },
        data: { status: 'active', originalValue: oldCard.originalValue, currentBalance: balance, activatedAt: new Date(), purchaserCustomerId: oldCard.purchaserCustomerId, recipientCustomerId: oldCard.recipientCustomerId },
      }),
      this.prisma.giftCardLedgerEntry.create({
        data: { giftCardId: oldCard.id, organizationId: orgId, entryType: 'adjustment', amount: -balance, reason: 'Saldo verplaatst naar vervangkaart' },
      }),
      this.prisma.giftCardLedgerEntry.create({
        data: { giftCardId: newCard.id, organizationId: orgId, entryType: 'adjustment', amount: balance, reason: 'Saldo overgenomen van vervangen kaart' },
      }),
    ]);

    await this.audit.record({
      organizationId: orgId, entityType: 'gift_card', entityId: oldCard.id, action: 'update', actor: ctx,
      beforeState: { status: oldCard.status, currentBalance: balance }, afterState: { status: 'redeemed', replacedByGiftCardId: newCard.id }, reason: dto.reason || 'Vervangen',
    });

    return { oldCardId: oldCard.id, newCardId: newCard.id, transferredBalance: balance };
  }

  // -- Opzoeken (kassa/publiek) -----------------------------------------------

  async lookupByToken(orgId: string, token: string) {
    const giftCard = await this.prisma.giftCard.findFirst({
      where: { publicTokenHash: this.hashToken(token), organizationId: orgId },
    });
    if (!giftCard) throw new NotFoundException('Kadobon niet gevonden');
    return {
      giftCardId: giftCard.id,
      giftCardNumber: giftCard.giftCardNumber,
      status: giftCard.status,
      currentBalance: Number(giftCard.currentBalance),
      originalValue: Number(giftCard.originalValue),
    };
  }

  /**
   * Voor de gastportal: de ingelogde gast wil zijn eigen kadobon
   * bekijken (QR + leesbaar token). Omdat het ruwe token nooit wordt
   * opgeslagen, genereren we hier een VERS token en vervangen we de
   * opgeslagen hash — het oude token wordt daardoor automatisch
   * ongeldig. Praktisch gevolg, en eigenlijk een pluspunt: een oude
   * screenshot/print van een eerdere weergave werkt niet meer, alleen
   * de nieuwste weergave is geldig — veiliger dan een voor altijd
   * geldige QR.
   */
  async rotateAndGetViewToken(orgId: string, giftCardId: string, customerId: string) {
    const giftCard = await this.prisma.giftCard.findFirst({
      where: { id: giftCardId, organizationId: orgId, recipientCustomerId: customerId },
    });
    if (!giftCard) throw new NotFoundException('Kadobon niet gevonden');
    if (giftCard.status !== 'active' && giftCard.status !== 'partially_redeemed') {
      throw new ConflictException(`Deze kaart heeft status "${giftCard.status}" en kan niet bekeken worden`);
    }

    const newToken = this.generateToken();
    await this.prisma.giftCard.update({ where: { id: giftCard.id }, data: { publicTokenHash: this.hashToken(newToken) } });

    return { token: newToken, giftCardNumber: giftCard.giftCardNumber, currentBalance: Number(giftCard.currentBalance) };
  }

  // -- Admin: overzicht + detail ---------------------------------------------

  async listCards(orgId: string, filters: { status?: string; search?: string }) {
    let customerMatchIds: string[] = [];
    if (filters.search) {
      const matched = await this.prisma.customer.findMany({
        where: {
          organizationId: orgId,
          OR: [
            { firstName: { contains: filters.search, mode: 'insensitive' } },
            { lastName: { contains: filters.search, mode: 'insensitive' } },
            { email: { contains: filters.search, mode: 'insensitive' } },
            { phone: { contains: filters.search } },
          ],
        },
        select: { id: true },
        take: 100,
      });
      customerMatchIds = matched.map((c) => c.id);
    }

    return this.prisma.giftCard.findMany({
      where: {
        organizationId: orgId,
        status: filters.status as never,
        ...(filters.search
          ? {
              OR: [
                { giftCardNumber: { contains: filters.search, mode: 'insensitive' } },
                { recipientName: { contains: filters.search, mode: 'insensitive' } },
                { recipientEmail: { contains: filters.search, mode: 'insensitive' } },
                { senderName: { contains: filters.search, mode: 'insensitive' } },
                { senderEmail: { contains: filters.search, mode: 'insensitive' } },
                ...(customerMatchIds.length > 0
                  ? [{ purchaserCustomerId: { in: customerMatchIds } }, { recipientCustomerId: { in: customerMatchIds } }]
                  : []),
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        purchaser: { select: { firstName: true, lastName: true, email: true } },
        recipient: { select: { firstName: true, lastName: true, email: true } },
      },
    });
  }

  async getCardDetail(orgId: string, giftCardId: string) {
    const giftCard = await this.prisma.giftCard.findFirst({
      where: { id: giftCardId, organizationId: orgId },
      include: {
        purchaser: { select: { id: true, firstName: true, lastName: true, email: true } },
        recipient: { select: { id: true, firstName: true, lastName: true, email: true } },
        ledgerEntries: { orderBy: { occurredAt: 'desc' } },
        replacedByGiftCard: { select: { id: true, giftCardNumber: true, status: true } },
        replacesGiftCard: { select: { id: true, giftCardNumber: true, status: true } },
      },
    });
    if (!giftCard) throw new NotFoundException('Kadobon niet gevonden');
    return giftCard;
  }

  async listBatches(orgId: string) {
    return this.prisma.giftCardBatch.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { cards: true } } },
    });
  }

  // -- Rapportage -----------------------------------------------------------

  async getReport(orgId: string) {
    const cards = await this.prisma.giftCard.findMany({
      where: { organizationId: orgId, status: { not: 'draft' } },
      select: { originalValue: true, currentBalance: true, status: true, locationIds: true },
    });

    const totalSold = cards.reduce((sum: number, c) => sum + Number(c.originalValue), 0);
    const totalOutstanding = cards.reduce((sum: number, c) => sum + Number(c.currentBalance), 0);
    const totalRedeemed = totalSold - totalOutstanding;
    const byStatus: Record<string, number> = {};
    for (const c of cards) {
      byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    }

    return {
      totalCardsSold: cards.length,
      totalSoldValue: totalSold,
      totalRedeemedValue: totalRedeemed,
      totalOutstandingLiability: totalOutstanding, // apart van loyalty-liability — zie README
      averageCardValue: cards.length > 0 ? totalSold / cards.length : 0,
      byStatus,
    };
  }

  /**
   * Voor de portal: laat een gast zijn EIGEN gekoppelde kadobon
   * bekijken zonder in een e-mail te hoeven zoeken. Genereert een
   * VERS token voor dezelfde kaart (zelfde saldo, zelfde geschiedenis
   * — alleen een nieuw token) en slaat alleen de hash op, exact
   * hetzelfde principe als overal elders. Het vorige token wordt
   * daarmee ongeldig; onschadelijk, want dit is de enige legitieme
   * manier waarop de gast zijn kaart alsnog kan bekijken.
   */
  async regenerateTokenForCustomer(orgId: string, customerId: string, giftCardId: string) {
    const card = await this.prisma.giftCard.findFirst({
      where: { id: giftCardId, organizationId: orgId, recipientCustomerId: customerId },
    });
    if (!card) throw new NotFoundException('Kadobon niet gevonden of hoort niet bij jouw account');
    if (card.status !== 'active' && card.status !== 'partially_redeemed') {
      throw new ConflictException(`Deze kaart heeft status "${card.status}" en kan niet bekeken worden`);
    }

    const token = this.generateToken();
    await this.prisma.giftCard.update({ where: { id: card.id }, data: { publicTokenHash: this.hashToken(token) } });

    return { giftCardId: card.id, giftCardNumber: card.giftCardNumber, token, currentBalance: Number(card.currentBalance) };
  }

  private async getCardOrThrow(orgId: string, giftCardId: string) {
    const card = await this.prisma.giftCard.findFirst({ where: { id: giftCardId, organizationId: orgId } });
    if (!card) throw new NotFoundException('Kadobon niet gevonden');
    return card;
  }

  /**
   * Draait dagelijks via de cron (zie gift-card-expiry-cron.controller.ts):
   * zet elke kaart die zijn vervaldatum is gepasseerd op status 'expired'
   * en boekt het resterende saldo af met een 'expiration'-ledgerboeking —
   * dezelfde entryType die de financiële rapportagemodule al gebruikt om
   * "verlopen" te tonen. Alleen 'active'/'partially_redeemed' kaarten met
   * saldo komen in aanmerking; een kaart op €0 hoeft niet apart als
   * "verlopen" geboekt te worden (er staat toch niets meer open), maar
   * krijgt de statuswijziging zelf uiteraard wel.
   */
  async processExpiredGiftCards(orgId: string): Promise<{ expiredCount: number; expiredValue: number }> {
    const now = new Date();
    const expiredCards = await this.prisma.giftCard.findMany({
      where: {
        organizationId: orgId,
        status: { in: ['active', 'partially_redeemed'] },
        expiresAt: { lt: now },
      },
    });

    let expiredValue = 0;
    for (const card of expiredCards) {
      const balance = Number(card.currentBalance);
      await this.prisma.$transaction(async (tx) => {
        // Atomair — zelfde bescherming tegen een race met een
        // gelijktijdige inwisseling als elders in deze service: de
        // where-clause herhaalt status IN (...) in de UPDATE zelf.
        const claim = await tx.giftCard.updateMany({
          where: { id: card.id, status: { in: ['active', 'partially_redeemed'] } },
          data: { status: 'expired', currentBalance: 0 },
        });
        if (claim.count === 0) return;

        if (balance > 0) {
          await tx.giftCardLedgerEntry.create({
            data: {
              giftCardId: card.id,
              organizationId: orgId,
              entryType: 'expiration',
              amount: balance * -1,
              reason: `Automatisch verlopen op ${card.expiresAt?.toLocaleDateString('nl-NL')} (${DEFAULT_GIFT_CARD_VALIDITY_YEARS} jaar geldigheid)`,
            },
          });
          expiredValue += balance;
        }
      });
    }

    if (expiredCards.length > 0) {
      this.logger.log(`${expiredCards.length} kadobon(nen) automatisch verlopen voor organisatie ${orgId}, totaal €${expiredValue.toFixed(2)} afgeboekt`);
    }

    return { expiredCount: expiredCards.length, expiredValue };
  }

  /**
   * Draait dagelijks via de cron: mailt de ontvanger (of, als er geen
   * ontvanger-e-mailadres bekend is, niemand — een kaart zonder
   * ontvanger-e-mail is alleen bereikbaar via de link die de koper zelf
   * bewaarde) exact 30 dagen vóór de vervaldatum. `expiryReminderSentAt`
   * voorkomt dat dezelfde kaart twee keer gemaild wordt als de cron
   * vaker draait of een dag gemist heeft — eenmaal verstuurd is genoeg.
   */
  async sendExpiryReminders(orgId: string): Promise<{ remindersSent: number }> {
    const REMINDER_DAYS_BEFORE = 30;
    const windowStart = new Date();
    windowStart.setUTCDate(windowStart.getUTCDate() + REMINDER_DAYS_BEFORE);
    windowStart.setUTCHours(0, 0, 0, 0);
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCHours(23, 59, 59, 999);

    const candidates = await this.prisma.giftCard.findMany({
      where: {
        organizationId: orgId,
        status: { in: ['active', 'partially_redeemed'] },
        expiresAt: { gte: windowStart, lte: windowEnd },
        expiryReminderSentAt: null,
        recipientEmail: { not: null },
      },
    });

    let remindersSent = 0;
    for (const card of candidates) {
      const amountText = '€' + Number(card.currentBalance).toFixed(2);
      const expiryText = formatExpiryDateNL(card.expiresAt!);
      const greeting = card.recipientName ? `Beste ${card.recipientName},` : 'Beste,';
      const greetingHtml = card.recipientName ? `Beste ${escapeHtml(card.recipientName)},` : 'Beste,';

      const result = await this.mailgun
        .sendEmail(
          card.recipientEmail!,
          `Je kadobon verloopt over ${REMINDER_DAYS_BEFORE} dagen`,
          `${greeting}\n\nJe kadobon (${card.giftCardNumber}) met een resterend saldo van ${amountText} verloopt op ${expiryText}. Gebruik 'm op tijd bij Het Strand of Zomers Beachclub & Brewery!\n\nGebruik de link of QR-code uit de e-mail die je bij ontvangst van de kaart kreeg om 'm te bekijken en te gebruiken. Kun je die niet meer vinden? Kom gerust langs — we zoeken je kaart dan op aan de hand van dit kaartnummer.`,
          `<p>${greetingHtml}</p><p>Je kadobon (${card.giftCardNumber}) met een resterend saldo van <strong>${amountText}</strong> verloopt op <strong>${expiryText}</strong>. Gebruik 'm op tijd bij Het Strand of Zomers Beachclub &amp; Brewery!</p><p>Gebruik de link of QR-code uit de e-mail die je bij ontvangst van de kaart kreeg om 'm te bekijken en te gebruiken. Kun je die niet meer vinden? Kom gerust langs — we zoeken je kaart dan op aan de hand van dit kaartnummer.</p>`,
        )
        .catch((err) => {
          this.logger.error(`Verloopherinnering voor kadobon ${card.id} mislukt: ${err instanceof Error ? err.message : err}`);
          return { sent: false };
        });

      if (result.sent) {
        await this.prisma.giftCard.update({ where: { id: card.id }, data: { expiryReminderSentAt: new Date() } });
        remindersSent += 1;
      }
    }

    return { remindersSent };
  }
}
