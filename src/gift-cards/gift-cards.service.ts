import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailgunService } from '../common/mailgun.service';
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
} from './dto/gift-cards.dto';

const MAX_BATCH_QUANTITY = 5000;
const MIN_GIFT_CARD_VALUE = 10; // onder dit bedrag wegen de vaste transactiekosten (Mollie e.d.) niet meer op tegen de waarde

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
 * cadeaukaart heeft geen eigen Wallet; een Wallet heeft geen
 * cadeaukaart-saldo. Het saldo van een kaart is ALTIJD de som van zijn
 * ledger — nooit rechtstreeks aangepast (getest: zie migratie-testlog).
 *
 * Bewuste architectuurkeuze tegen dubbele beloning: het VERKOPEN van een
 * cadeaukaart loopt hier, in deze service, en raakt daarom nooit
 * /transactions of de reward engine — dat is de hele reden dat er geen
 * "geen loyalty bij cadeaukaart-aankoop"-uitzondering ergens diep in de
 * reward-engine-code nodig is. Het latere GEBRUIK van een cadeaukaart
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
   * Klant-e-mailadres heeft GEEN unieke-constraint in het datamodel — er
   * kunnen dus meerdere klantrecords met hetzelfde e-mailadres bestaan
   * (bijv. één via Piggy-import, één handmatig aangemaakt, één via
   * portal-zelfregistratie). Een simpele findFirst() zou dan willekeurig
   * (databasevolgorde) het EERSTE record pakken — mogelijk niet het
   * account waar de klant daadwerkelijk op inlogt.
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
    // expliciet gekozen klant via recipientCustomerId), toch proberen te
    // koppelen aan een bestaand account met dat e-mailadres — zelfde
    // gedachte als bij de online koop-flow.
    const resolvedRecipientCustomerId =
      dto.recipientCustomerId ?? (dto.recipientEmail ? (await this.findBestMatchingCustomer(orgId, dto.recipientEmail))?.id : undefined);

    const giftCard = await this.prisma.giftCard.create({
      data: {
        organizationId: orgId,
        locationId: dto.locationId,
        giftCardNumber,
        publicTokenHash: this.hashToken(token),
        status: 'active',
        originalValue: dto.originalValue,
        currentBalance: dto.originalValue,
        isOrganizationWide: dto.isOrganizationWide ?? true,
        purchaserCustomerId: dto.purchaserCustomerId,
        recipientCustomerId: resolvedRecipientCustomerId,
        recipientName: dto.recipientName,
        recipientEmail: dto.recipientEmail,
        senderName: dto.senderName,
        senderEmail: dto.senderEmail,
        personalMessage: dto.personalMessage,
        scheduledSendAt: dto.scheduledSendAt ? new Date(dto.scheduledSendAt) : undefined,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        activatedAt: new Date(),
      },
    });

    await this.prisma.giftCardLedgerEntry.create({
      data: {
        giftCardId: giftCard.id,
        organizationId: orgId,
        locationId: dto.locationId,
        entryType: 'sale',
        amount: dto.originalValue,
        performedByUserId: ctx.actorId ?? undefined,
        reason: 'Cadeaukaart uitgegeven',
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

    // Kritiek: als de kaart direct aan een BEKENDE klant gekoppeld wordt
    // (recipientCustomerId, i.p.v. een los recipientEmail-veld), is dit
    // token straks nergens anders meer terug te vinden — niet in de
    // portal, niet ergens anders. Zonder deze e-mail zou de klant zijn
    // eigen kaart dus nooit meer kunnen openen. Nooit een harde fout
    // laten optreden op de uitgifte zelf als het versturen mislukt —
    // de kaart is al geldig aangemaakt, dat mag niet teruggedraaid worden.
    let emailSent: boolean | undefined;
    if (dto.recipientCustomerId && !dto.recipientEmail) {
      const recipient = await this.prisma.customer.findUnique({ where: { id: dto.recipientCustomerId }, select: { email: true } });
      if (recipient?.email) {
        await this.prisma.giftCard.update({ where: { id: giftCard.id }, data: { recipientEmail: recipient.email } });
        emailSent = await this.sendDigitalCard(orgId, giftCard.id, token)
          .then(() => true)
          .catch((err) => {
            this.logger.error(
              `Cadeaukaart ${giftCardNumber} (${giftCard.id}) uitgegeven, maar e-mail naar ${recipient.email} mislukt: ${err instanceof Error ? err.message : err}`,
            );
            return false;
          });
      }
    }

    let senderConfirmationSent: boolean | undefined;
    if (dto.senderEmail) {
      senderConfirmationSent = await this.sendPurchaseConfirmationToSender(orgId, giftCard.id)
        .then(() => true)
        .catch((err) => {
          this.logger.error(
            `Cadeaukaart ${giftCardNumber} (${giftCard.id}) uitgegeven, maar bevestigingsmail naar afzender ${dto.senderEmail} mislukt: ${err instanceof Error ? err.message : err}`,
          );
          return false;
        });
    }

    return { giftCardId: giftCard.id, giftCardNumber, token, currentBalance: dto.originalValue, emailSent, senderConfirmationSent };
  }

  /**
   * Verstuurt de digitale cadeaukaart per e-mail — vereist het RUWE
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
    const messageBlock = giftCard.personalMessage ? `\n\n"${giftCard.personalMessage}"\n` : '';

    const result = await this.mailgun.sendEmail(
      giftCard.recipientEmail,
      `Je hebt een cadeaukaart ter waarde van ${amountText} ontvangen!`,
      `${greeting}${messageBlock}\n\nJe hebt een cadeaukaart ontvangen ter waarde van ${amountText}.\n\nBekijk en gebruik je kaart via: ${qrUrl}\n\nVeel plezier!`,
      `<p>${greeting}</p>${giftCard.personalMessage ? `<p><em>"${giftCard.personalMessage}"</em></p>` : ''}<p>Je hebt een cadeaukaart ontvangen ter waarde van <strong>${amountText}</strong>.</p><p><a href="${qrUrl}">Bekijk en gebruik je kaart</a></p><p>Veel plezier!</p>`,
    );

    if (!result.sent) throw new BadRequestException('Versturen mislukt: ' + (result.reason || 'onbekende fout'));
    return { sent: true };
  }

  // -- Online verkoop via Mollie (iDEAL e.d.) --------------------------------

  /**
   * Start een online aankoop: maakt een cadeaukaart aan met status
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
      description: `Cadeaukaart ${giftCardNumber} (€${dto.originalValue.toFixed(2)})`,
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
   * Wordt aangeroepen door de Mollie-webhook (alleen een `id`, geen
   * status — zie MollieService voor waarom). Haalt de ECHTE status vers
   * op bij Mollie zelf, en activeert de kaart alleen als die status
   * daadwerkelijk 'paid' is. Idempotent: als de kaart al actief is
   * (bijv. Mollie roept de webhook twee keer aan), gebeurt er niets
   * extra — voorkomt dubbele ledger-entries.
   */
  async confirmMolliePayment(molliePaymentId: string): Promise<{ processed: boolean }> {
    const giftCard = await this.prisma.giftCard.findUnique({ where: { molliePaymentId } });
    if (!giftCard) return { processed: false }; // onbekende betaling — niets van ons, negeren

    if (giftCard.status !== 'draft') {
      return { processed: true }; // al verwerkt, of geannuleerd — idempotent, geen dubbele boeking
    }

    const payment = await this.mollie.getPayment(molliePaymentId);
    if (!payment || payment.status !== 'paid') {
      return { processed: true }; // nog niet (of niet meer) betaald — nog niets te activeren
    }

    // Koppel de kaart automatisch aan een BESTAAND klantaccount met
    // hetzelfde e-mailadres, zodat die 'm meteen ziet staan onder
    // "Cadeaukaarten" in Mijn Tegoed — zonder dat de koper of ontvanger
    // daar iets voor hoeft te doen. Bewust GEEN nieuw account aanmaken
    // als er nog geen match is: dat zou een account aanmaken zonder
    // toestemming/verificatie van de ontvanger. In dat geval blijft de
    // kaart gewoon bereikbaar via de e-mail met de losse kaartlink/QR,
    // exact zoals nu al het geval is.
    let recipientCustomerId: string | undefined;
    if (giftCard.recipientEmail) {
      const matchingCustomer = await this.findBestMatchingCustomer(giftCard.organizationId, giftCard.recipientEmail);
      recipientCustomerId = matchingCustomer?.id;
    }

    // Atomair CLAIMEN van de activering: de where-clause herhaalt de
    // status='draft'-voorwaarde in de UPDATE zelf (niet alleen in de
    // eerdere read hierboven), en de claim + ledger-entry zitten samen
    // in één transactie. Mollie kan de webhook soms bijna gelijktijdig
    // twee keer aanroepen — zonder deze extra check zouden beide
    // requests de eerdere `giftCard.status !== 'draft'`-lezing allebei
    // nog als 'draft' kunnen zien vóórdat de ander zijn write heeft
    // voltooid (klassieke read-then-write-race), en dan alsnog dubbel
    // activeren/mailen/boeken. Postgres serialiseert twee gelijktijdige
    // UPDATE's op dezelfde rij vanzelf (rij-lock) — de tweede transactie
    // ziet na de eerste committed heeft status niet meer 'draft' en
    // matcht dus 0 rijen.
    // Wanneer er een ontvanger-e-mailadres is, genereren we hier een
    // VERS token in plaats van te vertrouwen op het teruglezen van het
    // oorspronkelijke token uit Mollie's metadata — dat teruglezen bleek
    // in de praktijk niet altijd betrouwbaar, en faalde daarbij volledig
    // stil (geen log, geen foutmelding — de kaart werd dan gewoon nooit
    // verstuurd). Dit nieuwe token is nooit eerder aan iemand getoond,
    // dus vervangen is altijd veilig.
    const freshRecipientToken = giftCard.recipientEmail ? this.generateToken() : undefined;

    const claimed = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.giftCard.updateMany({
        where: { id: giftCard.id, status: 'draft' },
        data: {
          status: 'active',
          currentBalance: giftCard.originalValue,
          activatedAt: new Date(),
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
    if (!claimed) {
      return { processed: true }; // de andere, gelijktijdige aanroep won de race — niets meer te doen hier
    }

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
        // Bewust geen harde fout hier — de betaling en activering zijn al
        // veiliggesteld; een mislukte e-mail mag dat nooit terugdraaien.
        // WEL duidelijk loggen (zichtbaar in Vercel → project → Logs),
        // anders lijkt een online cadeaukaart-aankoop stil te verdwijnen
        // zonder dat iemand het merkt.
        this.logger.error(
          `Cadeaukaart ${giftCard.giftCardNumber} (${giftCard.id}) betaald, maar e-mail naar ${giftCard.recipientEmail} mislukt: ${err instanceof Error ? err.message : err}`,
        );
      });
    } else if (giftCard.recipientEmail && !freshRecipientToken) {
      // Zou nooit mogen gebeuren (freshRecipientToken wordt hierboven
      // altijd gegenereerd zodra recipientEmail gezet is) — toch expliciet
      // loggen in plaats van stil niets te doen, mocht er ooit een
      // logicafout sluipen die dit combineert.
      this.logger.error(
        `Cadeaukaart ${giftCard.giftCardNumber} (${giftCard.id}) heeft een ontvanger-e-mailadres (${giftCard.recipientEmail}) maar geen token om te versturen — niet verstuurd.`,
      );
    }

    if (giftCard.senderEmail) {
      await this.sendPurchaseConfirmationToSender(giftCard.organizationId, giftCard.id).catch((err) => {
        this.logger.error(
          `Cadeaukaart ${giftCard.giftCardNumber} (${giftCard.id}) betaald, maar bevestigingsmail naar afzender ${giftCard.senderEmail} mislukt: ${err instanceof Error ? err.message : err}`,
        );
      });
    }

    return { processed: true };
  }

  /**
   * Aparte bevestigingsmail aan de KOPER (afzender) zelf — bewust NOOIT
   * de kaart-token/QR of een bruikbare cadeaukaart-code hierin, alleen
   * bevestiging + samenvatting. De daadwerkelijke kaart gaat uitsluitend
   * naar de ontvanger via sendDigitalCard hierboven.
   */
  private async sendPurchaseConfirmationToSender(orgId: string, giftCardId: string): Promise<void> {
    const giftCard = await this.prisma.giftCard.findFirst({ where: { id: giftCardId, organizationId: orgId } });
    if (!giftCard || !giftCard.senderEmail) return;
    if (giftCard.senderConfirmationSentAt) return; // extra vangnet, los van de atomaire claim hierboven

    const amount = Number(giftCard.originalValue).toFixed(2).replace('.', ',');
    const purchaseDate = (giftCard.activatedAt ?? giftCard.issuedAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
    const recipientLine = giftCard.recipientEmail
      ? `Verstuurd naar: ${giftCard.recipientEmail}`
      : 'Er is geen ontvanger-e-mailadres opgegeven — je vindt de kaart terug op de bedankpagina die je na de betaling zag.';

    const lines = [
      'Je cadeaukaart is succesvol verstuurd',
      '',
      `Bedrag: €${amount}`,
      `Ontvanger: ${giftCard.recipientName || '(geen naam opgegeven)'}`,
      recipientLine,
      `Van: ${giftCard.senderName ?? ''}`,
      giftCard.personalMessage ? `Persoonlijke boodschap: "${giftCard.personalMessage}"` : undefined,
      `Ordernummer: ${giftCard.giftCardNumber}`,
      `Datum van aankoop: ${purchaseDate}`,
    ].filter((line): line is string => line !== undefined);

    const emailResult = await this.mailgun.sendEmail(giftCard.senderEmail, 'Je cadeaukaart is succesvol verstuurd', lines.join('\n'));
    if (!emailResult.sent) {
      throw new Error(emailResult.reason || 'Mailgun gaf geen reden voor de mislukking');
    }

    await this.prisma.giftCard.update({ where: { id: giftCard.id }, data: { senderConfirmationSentAt: new Date() } });
  }

  /**
   * Koppelt bestaande, nog niet gekoppelde cadeaukaarten met.recipientEmail
   * gelijk aan dit e-mailadres alsnog aan dit klantaccount — dekt precies
   * de omgekeerde volgorde van de automatische koppeling in
   * confirmMolliePayment (die alleen koppelt als het account op het
   * moment van BETALEN al bestond). Als iemand pas ÁCHTERAF een account
   * aanmaakt met hetzelfde e-mailadres als waar een cadeaukaart eerder
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
    const cardsToInsert: { organizationId: string; locationId?: string; batchId: string; publicTokenHash: string; giftCardNumber: string; originalValue: number }[] = [];
    const exportRows: { giftCardNumber: string; token: string; qrUrl: string }[] = [];

    for (let i = 0; i < dto.quantity; i++) {
      const token = this.generateToken();
      const giftCardNumber = 'GC-' + String(existingCount + i + 1).padStart(6, '0');
      cardsToInsert.push({
        organizationId: orgId,
        locationId: dto.locationId,
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
    if (!giftCard) throw new NotFoundException('Cadeaukaart niet gevonden');
    if (giftCard.organizationId !== orgId) throw new NotFoundException('Cadeaukaart niet gevonden');
    if (giftCard.status !== 'draft') throw new ConflictException('Deze kaart is al geactiveerd of niet meer geldig');

    await this.prisma.$transaction([
      this.prisma.giftCard.update({
        where: { id: giftCard.id },
        data: {
          status: 'active',
          originalValue: dto.originalValue,
          currentBalance: dto.originalValue,
          activatedAt: new Date(),
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
    if (!giftCard) throw new NotFoundException('Cadeaukaart niet gevonden');
    if (giftCard.organizationId !== orgId) throw new NotFoundException('Cadeaukaart niet gevonden');
    if (giftCard.status !== 'active' && giftCard.status !== 'partially_redeemed') {
      throw new ConflictException(`Deze kaart heeft status "${giftCard.status}" en kan niet worden ingewisseld`);
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
    if (!giftCard) throw new NotFoundException('Cadeaukaart niet gevonden');
    return {
      giftCardId: giftCard.id,
      giftCardNumber: giftCard.giftCardNumber,
      status: giftCard.status,
      currentBalance: Number(giftCard.currentBalance),
      originalValue: Number(giftCard.originalValue),
    };
  }

  /**
   * Voor de klantportal: de ingelogde klant wil zijn eigen cadeaukaart
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
    if (!giftCard) throw new NotFoundException('Cadeaukaart niet gevonden');
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
    if (!giftCard) throw new NotFoundException('Cadeaukaart niet gevonden');
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
      select: { originalValue: true, currentBalance: true, status: true, locationId: true },
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
   * Voor de portal: laat een klant zijn EIGEN gekoppelde cadeaukaart
   * bekijken zonder in een e-mail te hoeven zoeken. Genereert een
   * VERS token voor dezelfde kaart (zelfde saldo, zelfde geschiedenis
   * — alleen een nieuw token) en slaat alleen de hash op, exact
   * hetzelfde principe als overal elders. Het vorige token wordt
   * daarmee ongeldig; onschadelijk, want dit is de enige legitieme
   * manier waarop de klant zijn kaart alsnog kan bekijken.
   */
  async regenerateTokenForCustomer(orgId: string, customerId: string, giftCardId: string) {
    const card = await this.prisma.giftCard.findFirst({
      where: { id: giftCardId, organizationId: orgId, recipientCustomerId: customerId },
    });
    if (!card) throw new NotFoundException('Cadeaukaart niet gevonden of hoort niet bij jouw account');
    if (card.status !== 'active' && card.status !== 'partially_redeemed') {
      throw new ConflictException(`Deze kaart heeft status "${card.status}" en kan niet bekeken worden`);
    }

    const token = this.generateToken();
    await this.prisma.giftCard.update({ where: { id: card.id }, data: { publicTokenHash: this.hashToken(token) } });

    return { giftCardId: card.id, giftCardNumber: card.giftCardNumber, token, currentBalance: Number(card.currentBalance) };
  }

  private async getCardOrThrow(orgId: string, giftCardId: string) {
    const card = await this.prisma.giftCard.findFirst({ where: { id: giftCardId, organizationId: orgId } });
    if (!card) throw new NotFoundException('Cadeaukaart niet gevonden');
    return card;
  }
}
