import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeRateService } from '../wallet/exchange-rate.service';
import { ReportFiltersDto, ResolvedPeriod } from './dto/financial-reports.dto';

const MAX_EXPORT_ROWS = 5000; // veilige bovengrens per tabblad/sectie, voorkomt trage/te grote exports

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatEuro(n: number): string {
  return '€' + n.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateNL(d: Date): string {
  return d.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTimeNL(d: Date): string {
  return d.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Berekent financiële rapportages ALTIJD rechtstreeks vanuit de bestaande
 * ledgers (GiftCardLedgerEntry, WalletLedgerEntry, Transaction) — nooit
 * vanuit de cached saldo-velden (GiftCard.currentBalance,
 * Wallet.availableBalance). Dat is een bewuste, expliciete eis: elk
 * bedrag in het rapport moet herleidbaar zijn tot losse ledger-boekingen,
 * zodat kantoor/boekhouding het rapport ooit kan narekenen tegen de ruwe
 * mutaties. Cadeaukaarten en loyaltytegoed/punten blijven overal financieel
 * gescheiden gerapporteerd — nooit samengevoegde totalen.
 */
@Injectable()
export class FinancialReportsService {
  constructor(
    private prisma: PrismaService,
    private exchangeRate: ExchangeRateService,
  ) {}

  // -- Periode-resolutie ------------------------------------------------

  resolvePeriod(filters: ReportFiltersDto): ResolvedPeriod {
    const now = new Date();
    const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
    const endOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
    // Maandag als eerste dag van de week (Nederlandse conventie), niet zondag.
    const startOfWeek = (d: Date) => {
      const day = d.getUTCDay(); // 0 = zondag
      const diff = (day === 0 ? -6 : 1) - day;
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() + diff);
      return startOfDay(monday);
    };
    const endOfWeek = (d: Date) => {
      const monday = startOfWeek(d);
      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      return endOfDay(sunday);
    };
    const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
    const endOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    const startOfQuarter = (d: Date) => {
      const q = Math.floor(d.getUTCMonth() / 3);
      return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1, 0, 0, 0, 0));
    };
    const endOfQuarter = (d: Date) => {
      const q = Math.floor(d.getUTCMonth() / 3);
      return new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0, 23, 59, 59, 999));
    };
    const startOfYear = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
    const endOfYear = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), 11, 31, 23, 59, 59, 999));

    switch (filters.periodType) {
      case 'today':
        return { periodStart: startOfDay(now), periodEnd: endOfDay(now) };
      case 'this_week':
        return { periodStart: startOfWeek(now), periodEnd: endOfWeek(now) };
      case 'last_week': {
        const lastWeekDay = new Date(now);
        lastWeekDay.setUTCDate(now.getUTCDate() - 7);
        return { periodStart: startOfWeek(lastWeekDay), periodEnd: endOfWeek(lastWeekDay) };
      }
      case 'this_month':
        return { periodStart: startOfMonth(now), periodEnd: endOfMonth(now) };
      case 'last_month': {
        const lastMonthDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        return { periodStart: startOfMonth(lastMonthDay), periodEnd: endOfMonth(lastMonthDay) };
      }
      case 'quarter':
        return { periodStart: startOfQuarter(now), periodEnd: endOfQuarter(now) };
      case 'year':
        return { periodStart: startOfYear(now), periodEnd: endOfYear(now) };
      case 'custom': {
        if (!filters.from || !filters.to) {
          throw new BadRequestException('Vrije periode vereist zowel "from" als "to"');
        }
        const from = startOfDay(new Date(filters.from));
        const to = endOfDay(new Date(filters.to));
        if (from > to) throw new BadRequestException('"from" moet vóór "to" liggen');
        return { periodStart: from, periodEnd: to };
      }
      default:
        throw new BadRequestException(`Onbekend periodetype: ${filters.periodType}`);
    }
  }

  // -- Cadeaukaarten (kadobonnen) ----------------------------------------

  private async computeGiftCardSection(orgId: string, period: ResolvedPeriod, locationId?: string) {
    const whereBase = {
      organizationId: orgId,
      occurredAt: { gte: period.periodStart, lte: period.periodEnd },
      ...(locationId ? { locationId } : {}),
    };

    const entries = await this.prisma.giftCardLedgerEntry.findMany({
      where: whereBase,
      select: { entryType: true, amount: true, transactionId: true, giftCardId: true },
    });

    let soldValue = 0;
    let soldCount = 0;
    let redeemedValue = 0;
    let redeemedCount = 0;
    let redeemedLinkedToTransactionValue = 0;
    let correctionsValue = 0;
    let refundsValue = 0;
    let reversalsValue = 0;
    let expiredValue = 0;
    let expiredCount = 0;
    const redeemedGiftCardIds = new Set<string>();

    for (const entry of entries) {
      const amount = Number(entry.amount);
      switch (entry.entryType) {
        case 'sale':
        case 'issue':
        case 'top_up':
          soldValue += amount;
          soldCount += 1;
          break;
        case 'redeem':
          redeemedValue += Math.abs(amount);
          redeemedCount += 1;
          redeemedGiftCardIds.add(entry.giftCardId);
          if (entry.transactionId) redeemedLinkedToTransactionValue += Math.abs(amount);
          break;
        case 'adjustment':
          correctionsValue += amount;
          break;
        case 'refund':
          refundsValue += Math.abs(amount);
          break;
        case 'reversal':
          reversalsValue += amount;
          break;
        case 'expiration':
          expiredValue += Math.abs(amount);
          expiredCount += 1;
          break;
      }
    }

    // Volledig vs. gedeeltelijk ingewisseld — bepaald aan de hand van de
    // HUIDIGE status van de kaart (niet aan de hand van deze ene periode,
    // want een kaart kan over meerdere periodes heen gedeeltelijk
    // opgebouwd worden). Dit is de enige plek in dit rapport die wél een
    // kaartstatus opvraagt — puur voor deze classificatie, niet voor de
    // financiële bedragen zelf (die komen allemaal uit de ledger hierboven).
    let fullyRedeemedCount = 0;
    let partiallyRedeemedCount = 0;
    if (redeemedGiftCardIds.size > 0) {
      const cards = await this.prisma.giftCard.findMany({
        where: { id: { in: Array.from(redeemedGiftCardIds) } },
        select: { status: true },
      });
      for (const card of cards) {
        if (card.status === 'redeemed') fullyRedeemedCount += 1;
        else if (card.status === 'partially_redeemed') partiallyRedeemedCount += 1;
      }
    }

    // Openstaand saldo/liability — ALTIJD herberekend vanuit de ledger
    // (nooit GiftCard.currentBalance rechtstreeks gelezen), zoals
    // expliciet vereist. Dit is een "nu"-snapshot (niet met terugwerkende
    // kracht per periode-einddatum), wat gangbaar is voor een liability-
    // cijfer: het weerspiegelt wat er OP DIT MOMENT nog aan verplichting
    // openstaat, los van welke periode de omzet/inwisseling-activiteit in
    // het rapport beslaat.
    const liabilityWhere = { organizationId: orgId, ...(locationId ? { locationId } : {}) };
    const liabilityGroups = await this.prisma.giftCardLedgerEntry.groupBy({
      by: ['giftCardId'],
      where: liabilityWhere,
      _sum: { amount: true },
    });
    const outstandingLiability = liabilityGroups.reduce((sum, g) => {
      const balance = Number(g._sum.amount ?? 0);
      return balance > 0 ? sum + balance : sum;
    }, 0);

    return {
      soldCount,
      soldValue: round2(soldValue),
      redeemedCount,
      redeemedValue: round2(redeemedValue),
      fullyRedeemedCount,
      partiallyRedeemedCount,
      correctionsValue: round2(correctionsValue),
      refundsValue: round2(refundsValue),
      reversalsValue: round2(reversalsValue),
      expiredCount,
      expiredValue: round2(expiredValue),
      outstandingLiability: round2(outstandingLiability),
      reconciliation: {
        ledgerRedeemedTotal: round2(redeemedValue),
        posLinkedTotal: round2(redeemedLinkedToTransactionValue),
        difference: round2(redeemedValue - redeemedLinkedToTransactionValue),
      },
    };
  }

  // -- Loyaltytegoed / spaarpunten ("Strand tegoed") ----------------------

  private async computeLoyaltySection(orgId: string, period: ResolvedPeriod, locationId?: string) {
    // Let op: WalletLedgerEntry heeft GEEN eigen locationId-kolom (het
    // tegoed zelf is klant-gebonden, niet locatie-gebonden — een klant
    // spaart bij Het Strand en geeft uit bij Zomers, of andersom). Een
    // locatiefilter kan hier daarom alleen via de gekoppelde Transaction
    // (die WEL een locationId heeft) — entries zonder transactionId
    // (bijv. handmatige correcties, verjaardagsbonussen) tellen dan NIET
    // mee bij een locatie-specifiek rapport, alleen bij het
    // organisatiebrede totaal. Dit wordt expliciet vermeld in de
    // rapport-metadata (zie getSummary), zodat dit nooit verward wordt
    // met een "compleet" cijfer per locatie.
    const entryWhere = locationId
      ? { organizationId: orgId, occurredAt: { gte: period.periodStart, lte: period.periodEnd }, transaction: { locationId } }
      : { organizationId: orgId, occurredAt: { gte: period.periodStart, lte: period.periodEnd } };

    const entries = await this.prisma.walletLedgerEntry.findMany({
      where: entryWhere,
      select: { entryType: true, amount: true, occurredAt: true, transactionId: true },
    });

    let pointsIssued = 0;
    let pointsRedeemed = 0;
    let manualCorrections = 0;
    let pointsExpired = 0;
    const redeemedByDate = new Map<string, number>(); // YYYY-MM-DD -> punten die dag ingewisseld, voor correcte per-dag koers

    for (const entry of entries) {
      const amount = Number(entry.amount);
      switch (entry.entryType) {
        case 'earn':
        case 'bonus':
        case 'campaign_bonus':
          pointsIssued += amount;
          break;
        case 'redeem': {
          const abs = Math.abs(amount);
          pointsRedeemed += abs;
          const dateKey = entry.occurredAt.toISOString().slice(0, 10);
          redeemedByDate.set(dateKey, (redeemedByDate.get(dateKey) ?? 0) + abs);
          break;
        }
        case 'manual_adjustment':
        case 'correction':
          manualCorrections += amount;
          break;
        case 'expiration':
          pointsExpired += Math.abs(amount);
          break;
      }
    }

    // Geldwaarde van ingewisselde punten — PER DAG berekend met de koers
    // die op DIE dag gold (koers kan per dag verschillen, zie
    // ExchangeRateService), niet met één gemiddelde koers over de hele
    // periode. Zelfde methodiek als de bestaande dagafsluiting, alleen
    // dan opgeteld over meerdere dagen.
    let redeemedEuroValue = 0;
    for (const [dateKey, points] of redeemedByDate) {
      const rate = await this.exchangeRate.getPointsPerEuro(orgId, locationId, new Date(`${dateKey}T12:00:00.000Z`));
      redeemedEuroValue += rate > 0 ? points / rate : 0;
    }

    // Geldwaarde van uitgegeven punten — zelfde per-dag-koers-principe,
    // maar dan op het moment van UITGIFTE (earn/bonus), niet inwisseling.
    // Nuttig om te zien hoeveel toekomstige verplichting er is
    // bijgekomen, tegen de koers van dat moment.
    const issuedByDate = new Map<string, number>();
    for (const entry of entries) {
      if (['earn', 'bonus', 'campaign_bonus'].includes(entry.entryType)) {
        const dateKey = entry.occurredAt.toISOString().slice(0, 10);
        issuedByDate.set(dateKey, (issuedByDate.get(dateKey) ?? 0) + Number(entry.amount));
      }
    }
    let issuedEuroValue = 0;
    for (const [dateKey, points] of issuedByDate) {
      const rate = await this.exchangeRate.getPointsPerEuro(orgId, locationId, new Date(`${dateKey}T12:00:00.000Z`));
      issuedEuroValue += rate > 0 ? points / rate : 0;
    }

    // Openstaand tegoed — ALTIJD herberekend vanuit de ledger (som van
    // nog-niet-verbruikte "available"-lots), nooit Wallet.availableBalance
    // rechtstreeks gelezen. Bewust GEEN locatiefilter hier: het tegoed
    // zelf is niet aan een locatie gebonden (zie toelichting hierboven).
    const outstandingGroups = await this.prisma.walletLedgerEntry.aggregate({
      where: { organizationId: orgId, status: 'available', remainingAmount: { gt: 0 } },
      _sum: { remainingAmount: true },
    });
    const outstandingBalance = Number(outstandingGroups._sum.remainingAmount ?? 0);

    return {
      pointsIssued: round2(pointsIssued),
      pointsIssuedEuroValue: round2(issuedEuroValue),
      pointsRedeemed: round2(pointsRedeemed),
      pointsRedeemedEuroValue: round2(redeemedEuroValue),
      manualCorrections: round2(manualCorrections),
      pointsExpired: round2(pointsExpired),
      outstandingBalance: round2(outstandingBalance),
      locationFilterNote: locationId
        ? 'Bij een locatiefilter tellen alleen mutaties gekoppeld aan een POS-transactie op die locatie mee — handmatige correcties/bonussen zonder transactiekoppeling verschijnen alleen in het organisatiebrede totaal.'
        : undefined,
    };
  }

  // -- Publieke samenvatting -----------------------------------------------

  private async computeSummaryData(orgId: string, filters: ReportFiltersDto) {
    const period = this.resolvePeriod(filters);

    if (filters.locationId) {
      const location = await this.prisma.location.findFirst({ where: { id: filters.locationId, organizationId: orgId } });
      if (!location) throw new BadRequestException('Locatie niet gevonden');
    }

    const [giftCards, loyalty, locations] = await Promise.all([
      this.computeGiftCardSection(orgId, period, filters.locationId),
      this.computeLoyaltySection(orgId, period, filters.locationId),
      this.prisma.location.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } }),
    ]);

    const locationName = filters.locationId ? locations.find((l) => l.id === filters.locationId)?.name : 'Hele organisatie';

    return {
      organizationId: orgId,
      locationId: filters.locationId ?? null,
      locationName,
      periodType: filters.periodType,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      generatedAt: new Date(),
      giftCards,
      loyalty,
      allLocations: locations,
    };
  }

  private async recordHistory(orgId: string, filters: ReportFiltersDto, period: ResolvedPeriod, format: string, staffId?: string) {
    // Elke keer dat een rapport bekeken/geëxporteerd wordt, registreren we
    // de gebruikte parameters in de geschiedenis — zie schema-commentaar
    // bij FinancialReportHistory voor waarom (nooit het bestand/de
    // bedragen zelf, alleen de parameters om het later exact zo opnieuw
    // te kunnen genereren).
    await this.prisma.financialReportHistory.create({
      data: {
        organizationId: orgId,
        reportType: filters.periodType,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        locationId: filters.locationId,
        format,
        generatedByStaffId: staffId,
      },
    });
  }

  async getSummary(orgId: string, filters: ReportFiltersDto, staffId?: string) {
    const data = await this.computeSummaryData(orgId, filters);
    await this.recordHistory(orgId, filters, { periodStart: data.periodStart, periodEnd: data.periodEnd }, 'view', staffId);
    return data;
  }

  async getHistory(orgId: string, limit = 50) {
    return this.prisma.financialReportHistory.findMany({
      where: { organizationId: orgId },
      orderBy: { generatedAt: 'desc' },
      take: limit,
    });
  }

  // -- Detailregels (doorklikbaar vanuit het dashboard) --------------------

  private maskGiftCardNumber(number: string): string {
    return number.replace(/^(GC-)(\d+)$/, (_m, prefix: string, digits: string) => prefix + '••••' + digits.slice(-2));
  }

  async getGiftCardDetails(orgId: string, filters: ReportFiltersDto, page = 1, pageSize = 50) {
    const period = this.resolvePeriod(filters);
    const where = {
      organizationId: orgId,
      occurredAt: { gte: period.periodStart, lte: period.periodEnd },
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
    };

    const [entries, total] = await Promise.all([
      this.prisma.giftCardLedgerEntry.findMany({
        where,
        include: {
          giftCard: { select: { giftCardNumber: true, originalValue: true, currentBalance: true, status: true } },
          transaction: { select: { id: true } },
        },
        orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.giftCardLedgerEntry.count({ where }),
    ]);

    const locations = await this.prisma.location.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } });
    const locationMap = new Map(locations.map((l) => [l.id, l.name]));

    return {
      page,
      pageSize,
      total,
      rows: entries.map((e) => ({
        date: e.occurredAt,
        locationName: e.locationId ? (locationMap.get(e.locationId) ?? '—') : '—',
        giftCardNumberMasked: this.maskGiftCardNumber(e.giftCard.giftCardNumber),
        originalValue: Number(e.giftCard.originalValue),
        amount: Number(e.amount),
        remainingBalance: Number(e.giftCard.currentBalance),
        entryType: e.entryType,
        status: e.giftCard.status,
        transactionId: e.transactionId,
        reason: e.reason,
      })),
    };
  }

  async getLoyaltyDetails(orgId: string, filters: ReportFiltersDto, page = 1, pageSize = 50) {
    const period = this.resolvePeriod(filters);
    const where = filters.locationId
      ? { organizationId: orgId, occurredAt: { gte: period.periodStart, lte: period.periodEnd }, transaction: { locationId: filters.locationId } }
      : { organizationId: orgId, occurredAt: { gte: period.periodStart, lte: period.periodEnd } };

    const [entries, total] = await Promise.all([
      this.prisma.walletLedgerEntry.findMany({
        where,
        include: {
          wallet: { select: { customer: { select: { firstName: true, lastName: true } } } },
          transaction: { select: { id: true, locationId: true } },
        },
        orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.walletLedgerEntry.count({ where }),
    ]);

    const locations = await this.prisma.location.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } });
    const locationMap = new Map(locations.map((l) => [l.id, l.name]));

    const rows = [];
    for (const e of entries) {
      const rate = await this.exchangeRate.getPointsPerEuro(orgId, filters.locationId, e.occurredAt);
      rows.push({
        date: e.occurredAt,
        customerName: [e.wallet.customer.firstName, e.wallet.customer.lastName].filter(Boolean).join(' ') || '(naam onbekend)',
        points: Number(e.amount),
        euroValue: rate > 0 ? round2(Number(e.amount) / rate) : 0,
        entryType: e.entryType,
        locationName: e.transaction?.locationId ? (locationMap.get(e.transaction.locationId) ?? '—') : '—',
        transactionId: e.transactionId,
        campaignId: e.campaignId,
        reason: e.reason,
      });
    }

    return { page, pageSize, total, rows };
  }

  /** Ongepagineerd, voor exports — met een veilige bovengrens. */
  private async getAllGiftCardEntriesForExport(orgId: string, period: ResolvedPeriod, locationId?: string) {
    const where = {
      organizationId: orgId,
      occurredAt: { gte: period.periodStart, lte: period.periodEnd },
      ...(locationId ? { locationId } : {}),
    };
    const entries = await this.prisma.giftCardLedgerEntry.findMany({
      where,
      include: { giftCard: { select: { giftCardNumber: true, originalValue: true, currentBalance: true, status: true } } },
      orderBy: { occurredAt: 'asc' },
      take: MAX_EXPORT_ROWS,
    });
    const locations = await this.prisma.location.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } });
    const locationMap = new Map(locations.map((l) => [l.id, l.name]));
    return entries.map((e) => ({
      date: e.occurredAt,
      locationName: e.locationId ? (locationMap.get(e.locationId) ?? '—') : '—',
      giftCardNumberMasked: this.maskGiftCardNumber(e.giftCard.giftCardNumber),
      originalValue: Number(e.giftCard.originalValue),
      amount: Number(e.amount),
      remainingBalance: Number(e.giftCard.currentBalance),
      entryType: e.entryType,
      status: e.giftCard.status,
      transactionId: e.transactionId,
      reason: e.reason,
    }));
  }

  /** Ongepagineerd, voor exports — met een veilige bovengrens. */
  private async getAllLoyaltyEntriesForExport(orgId: string, period: ResolvedPeriod, locationId?: string) {
    const where = locationId
      ? { organizationId: orgId, occurredAt: { gte: period.periodStart, lte: period.periodEnd }, transaction: { locationId } }
      : { organizationId: orgId, occurredAt: { gte: period.periodStart, lte: period.periodEnd } };
    const entries = await this.prisma.walletLedgerEntry.findMany({
      where,
      include: { wallet: { select: { customer: { select: { firstName: true, lastName: true } } } }, transaction: { select: { locationId: true } } },
      orderBy: { occurredAt: 'asc' },
      take: MAX_EXPORT_ROWS,
    });
    const locations = await this.prisma.location.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } });
    const locationMap = new Map(locations.map((l) => [l.id, l.name]));
    const rows = [];
    for (const e of entries) {
      const rate = await this.exchangeRate.getPointsPerEuro(orgId, locationId, e.occurredAt);
      rows.push({
        date: e.occurredAt,
        customerName: [e.wallet.customer.firstName, e.wallet.customer.lastName].filter(Boolean).join(' ') || '(naam onbekend)',
        points: Number(e.amount),
        euroValue: rate > 0 ? round2(Number(e.amount) / rate) : 0,
        entryType: e.entryType,
        locationName: e.transaction?.locationId ? (locationMap.get(e.transaction.locationId) ?? '—') : '—',
        transactionId: e.transactionId,
        campaignId: e.campaignId,
        reason: e.reason,
      });
    }
    return rows;
  }

  private async resolveStaffName(staffId?: string): Promise<string | undefined> {
    if (!staffId) return undefined;
    const staff = await this.prisma.staffUser.findUnique({ where: { id: staffId }, select: { firstName: true, lastName: true } });
    if (!staff) return undefined;
    return [staff.firstName, staff.lastName].filter(Boolean).join(' ');
  }

  // -- Excel-export -------------------------------------------------------

  async generateExcelBuffer(orgId: string, filters: ReportFiltersDto, staffId?: string): Promise<Buffer> {
    const summary = await this.computeSummaryData(orgId, filters);
    const period = { periodStart: summary.periodStart, periodEnd: summary.periodEnd };
    await this.recordHistory(orgId, filters, period, 'excel', staffId);
    const generatedByName = await this.resolveStaffName(staffId);

    const [giftCardEntries, loyaltyEntries] = await Promise.all([
      this.getAllGiftCardEntriesForExport(orgId, period, filters.locationId),
      this.getAllLoyaltyEntriesForExport(orgId, period, filters.locationId),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Strand tegoed platform';
    workbook.created = new Date();

    // -- Tab 1: Samenvatting ---------------------------------------------
    const summarySheet = workbook.addWorksheet('Samenvatting');
    summarySheet.columns = [{ width: 32 }, { width: 24 }];
    summarySheet.addRow(['Organisatie', 'Het Strand & Zomers']);
    summarySheet.addRow(['Locatie', summary.locationName]);
    summarySheet.addRow(['Rapportperiode', `${formatDateNL(summary.periodStart)} t/m ${formatDateNL(summary.periodEnd)}`]);
    summarySheet.addRow(['Gegenereerd op', formatDateTimeNL(new Date())]);
    summarySheet.addRow(['Gegenereerd door', generatedByName ?? '—']);
    summarySheet.addRow([]);
    summarySheet.addRow(['KADOBONNEN']).font = { bold: true };
    summarySheet.addRow(['Aantal verkocht', summary.giftCards.soldCount]);
    summarySheet.addRow(['Totale verkoopwaarde', formatEuro(summary.giftCards.soldValue)]);
    summarySheet.addRow(['Aantal ingeleverd (mutaties)', summary.giftCards.redeemedCount]);
    summarySheet.addRow(['Totaal ingeleverd', formatEuro(summary.giftCards.redeemedValue)]);
    summarySheet.addRow(['Waarvan volledig ingewisseld', summary.giftCards.fullyRedeemedCount]);
    summarySheet.addRow(['Waarvan gedeeltelijk ingewisseld', summary.giftCards.partiallyRedeemedCount]);
    summarySheet.addRow(['Correcties', formatEuro(summary.giftCards.correctionsValue)]);
    summarySheet.addRow(['Refunds', formatEuro(summary.giftCards.refundsValue)]);
    summarySheet.addRow(['Reversals', formatEuro(summary.giftCards.reversalsValue)]);
    summarySheet.addRow(['Verlopen', `${summary.giftCards.expiredCount}x — ${formatEuro(summary.giftCards.expiredValue)}`]);
    summarySheet.addRow(['Openstaand saldo (liability)', formatEuro(summary.giftCards.outstandingLiability)]);
    summarySheet.addRow([]);
    summarySheet.addRow(['SPAARPUNTEN / LOYALTYTEGOED']).font = { bold: true };
    summarySheet.addRow(['Uitgegeven', `${summary.loyalty.pointsIssued} pt — ${formatEuro(summary.loyalty.pointsIssuedEuroValue)}`]);
    summarySheet.addRow(['Ingeleverd', `${summary.loyalty.pointsRedeemed} pt — ${formatEuro(summary.loyalty.pointsRedeemedEuroValue)}`]);
    summarySheet.addRow(['Handmatige correcties', `${summary.loyalty.manualCorrections} pt`]);
    summarySheet.addRow(['Verlopen', `${summary.loyalty.pointsExpired} pt`]);
    summarySheet.addRow(['Openstaand tegoed', `${summary.loyalty.outstandingBalance} pt`]);
    summarySheet.addRow([]);
    summarySheet.addRow(['RECONCILIATIE (kadobonnen)']).font = { bold: true };
    summarySheet.addRow(['Ledger-totaal ingeleverd', formatEuro(summary.giftCards.reconciliation.ledgerRedeemedTotal)]);
    summarySheet.addRow(['Gekoppeld aan POS-transactie', formatEuro(summary.giftCards.reconciliation.posLinkedTotal)]);
    const diffRow = summarySheet.addRow(['Verschil', formatEuro(summary.giftCards.reconciliation.difference)]);
    if (Math.abs(summary.giftCards.reconciliation.difference) > 0.01) {
      diffRow.getCell(2).font = { color: { argb: 'FFE8604A' }, bold: true };
    }

    // -- Tab 2: Verkochte kadobonnen --------------------------------------
    const soldSheet = workbook.addWorksheet('Verkochte kadobonnen');
    soldSheet.columns = [
      { header: 'Datum', key: 'date', width: 14 },
      { header: 'Locatie', key: 'location', width: 16 },
      { header: 'Kaartnummer', key: 'number', width: 16 },
      { header: 'Bedrag', key: 'amount', width: 14 },
    ];
    for (const e of giftCardEntries.filter((e) => ['sale', 'issue', 'top_up'].includes(e.entryType))) {
      soldSheet.addRow({ date: formatDateNL(e.date), location: e.locationName, number: e.giftCardNumberMasked, amount: formatEuro(e.amount) });
    }

    // -- Tab 3: Ingeleverde kadobonnen -------------------------------------
    const redeemedSheet = workbook.addWorksheet('Ingeleverde kadobonnen');
    redeemedSheet.columns = [
      { header: 'Datum', key: 'date', width: 14 },
      { header: 'Locatie', key: 'location', width: 16 },
      { header: 'Kaartnummer', key: 'number', width: 16 },
      { header: 'Ingeleverd bedrag', key: 'amount', width: 16 },
      { header: 'Resterend saldo', key: 'remaining', width: 16 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Transactie-ID', key: 'txId', width: 24 },
    ];
    for (const e of giftCardEntries.filter((e) => e.entryType === 'redeem')) {
      redeemedSheet.addRow({
        date: formatDateNL(e.date), location: e.locationName, number: e.giftCardNumberMasked,
        amount: formatEuro(Math.abs(e.amount)), remaining: formatEuro(e.remainingBalance), status: e.status, txId: e.transactionId ?? '—',
      });
    }

    // -- Tab 4: Afboekingen/correcties (kadobonnen + loyalty samen, apart gelabeld) --
    const correctionsSheet = workbook.addWorksheet('Afboekingen en correcties');
    correctionsSheet.columns = [
      { header: 'Datum', key: 'date', width: 14 },
      { header: 'Categorie', key: 'category', width: 16 },
      { header: 'Type', key: 'type', width: 16 },
      { header: 'Referentie', key: 'ref', width: 16 },
      { header: 'Bedrag', key: 'amount', width: 16 },
      { header: 'Reden', key: 'reason', width: 30 },
    ];
    for (const e of giftCardEntries.filter((e) => ['adjustment', 'refund', 'reversal', 'expiration'].includes(e.entryType))) {
      correctionsSheet.addRow({ date: formatDateNL(e.date), category: 'Kadobon', type: e.entryType, ref: e.giftCardNumberMasked, amount: formatEuro(e.amount), reason: e.reason ?? '—' });
    }
    for (const e of loyaltyEntries.filter((e) => ['manual_adjustment', 'correction', 'expiration', 'refund_reversal'].includes(e.entryType))) {
      correctionsSheet.addRow({ date: formatDateNL(e.date), category: 'Spaarpunten', type: e.entryType, ref: e.customerName, amount: `${e.points} pt`, reason: e.reason ?? '—' });
    }

    // -- Tab 5: Spaarpunten ingeleverd --------------------------------------
    const pointsRedeemedSheet = workbook.addWorksheet('Spaarpunten ingeleverd');
    pointsRedeemedSheet.columns = [
      { header: 'Datum', key: 'date', width: 14 },
      { header: 'Klant', key: 'customer', width: 24 },
      { header: 'Locatie', key: 'location', width: 16 },
      { header: 'Punten', key: 'points', width: 12 },
      { header: 'Geldwaarde', key: 'euro', width: 14 },
      { header: 'Transactie-ID', key: 'txId', width: 24 },
    ];
    for (const e of loyaltyEntries.filter((e) => e.entryType === 'redeem')) {
      pointsRedeemedSheet.addRow({ date: formatDateNL(e.date), customer: e.customerName, location: e.locationName, points: Math.abs(e.points), euro: formatEuro(Math.abs(e.euroValue)), txId: e.transactionId ?? '—' });
    }

    // -- Tab 6: Loyalty Credit (uitgegeven) ---------------------------------
    const creditSheet = workbook.addWorksheet('Loyalty Credit uitgegeven');
    creditSheet.columns = [
      { header: 'Datum', key: 'date', width: 14 },
      { header: 'Klant', key: 'customer', width: 24 },
      { header: 'Type', key: 'type', width: 18 },
      { header: 'Locatie', key: 'location', width: 16 },
      { header: 'Punten', key: 'points', width: 12 },
      { header: 'Geldwaarde', key: 'euro', width: 14 },
      { header: 'Campagne', key: 'campaign', width: 20 },
    ];
    for (const e of loyaltyEntries.filter((e) => ['earn', 'bonus', 'campaign_bonus'].includes(e.entryType))) {
      creditSheet.addRow({ date: formatDateNL(e.date), customer: e.customerName, type: e.entryType, location: e.locationName, points: e.points, euro: formatEuro(e.euroValue), campaign: e.campaignId ?? '—' });
    }

    // -- Tab 7: Openstaande saldi --------------------------------------------
    const outstandingSheet = workbook.addWorksheet('Openstaande saldi');
    outstandingSheet.columns = [{ width: 36 }, { width: 24 }];
    outstandingSheet.addRow(['Openstaand kadobon-saldo (liability)', formatEuro(summary.giftCards.outstandingLiability)]);
    outstandingSheet.addRow(['Openstaand loyaltytegoed', `${summary.loyalty.outstandingBalance} pt`]);
    outstandingSheet.addRow([]);
    outstandingSheet.addRow(['Peildatum', formatDateTimeNL(new Date())]);
    outstandingSheet.addRow(['Toelichting', 'Dit zijn actuele "nu"-standen, herberekend vanuit de ledger — niet gebonden aan de rapportperiode hierboven.']);

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  // -- PDF-export ----------------------------------------------------------

  async generatePdfBuffer(orgId: string, filters: ReportFiltersDto, staffId?: string): Promise<Buffer> {
    const summary = await this.computeSummaryData(orgId, filters);
    const period = { periodStart: summary.periodStart, periodEnd: summary.periodEnd };
    await this.recordHistory(orgId, filters, period, 'pdf', staffId);
    const generatedByName = await this.resolveStaffName(staffId);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const monthNames = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
      const title = `Rapport ${monthNames[summary.periodStart.getUTCMonth()]} ${summary.periodStart.getUTCFullYear()}`;

      doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'left' });
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').fillColor('#666666');
      doc.text(`Het Strand & Zomers — ${summary.locationName}`);
      doc.text(`Periode: ${formatDateNL(summary.periodStart)} t/m ${formatDateNL(summary.periodEnd)}`);
      doc.text(`Gegenereerd op ${formatDateTimeNL(new Date())}${generatedByName ? ' door ' + generatedByName : ''}`);
      doc.moveDown(1.2);
      doc.fillColor('#000000');

      const line = (label: string, value: string, opts?: { bold?: boolean; color?: string }) => {
        doc.fontSize(11).font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica');
        if (opts?.color) doc.fillColor(opts.color);
        doc.text(label, { continued: true, width: 350 });
        doc.text(value, { align: 'right' });
        doc.fillColor('#000000');
      };
      const sectionHeader = (text: string) => {
        doc.moveDown(0.8);
        doc.fontSize(13).font('Helvetica-Bold').fillColor('#1b3a5c').text(text);
        doc.fillColor('#000000');
        doc.moveDown(0.3);
      };

      sectionHeader('Kadobonnen');
      line('Kadobonnen verkocht', `${summary.giftCards.soldCount}x — ${formatEuro(summary.giftCards.soldValue)}`, { bold: true });
      line('Kadobonnen ingewisseld', formatEuro(summary.giftCards.redeemedValue), { bold: true });
      line('  waarvan volledig', `${summary.giftCards.fullyRedeemedCount}x`);
      line('  waarvan gedeeltelijk', `${summary.giftCards.partiallyRedeemedCount}x`);
      line('Kadobon correcties', formatEuro(summary.giftCards.correctionsValue));
      line('Refunds', formatEuro(summary.giftCards.refundsValue));
      line('Reversals', formatEuro(summary.giftCards.reversalsValue));
      line('Verlopen', `${summary.giftCards.expiredCount}x — ${formatEuro(summary.giftCards.expiredValue)}`);
      line('Openstaand kadobon-saldo', formatEuro(summary.giftCards.outstandingLiability), { bold: true });

      sectionHeader('Loyaltypunten / Beach Credit');
      line('Loyaltypunten uitgegeven', `${summary.loyalty.pointsIssued} punten`, { bold: true });
      line('  financiële waarde', formatEuro(summary.loyalty.pointsIssuedEuroValue));
      line('Loyaltypunten ingewisseld', `${summary.loyalty.pointsRedeemed} punten`, { bold: true });
      line('  financiële waarde', formatEuro(summary.loyalty.pointsRedeemedEuroValue));
      line('Handmatige correcties', `${summary.loyalty.manualCorrections} punten`);
      line('Verlopen', `${summary.loyalty.pointsExpired} punten`);
      line('Openstaand loyaltytegoed', `${summary.loyalty.outstandingBalance} punten`, { bold: true });

      sectionHeader('Reconciliatie (kadobonnen)');
      line('Ingewisseld volgens ledger', formatEuro(summary.giftCards.reconciliation.ledgerRedeemedTotal));
      line('Gekoppeld aan POS-transactie', formatEuro(summary.giftCards.reconciliation.posLinkedTotal));
      const diff = summary.giftCards.reconciliation.difference;
      line('Verschil', formatEuro(diff), Math.abs(diff) > 0.01 ? { bold: true, color: '#e8604a' } : {});
      if (Math.abs(diff) > 0.01) {
        doc.moveDown(0.3);
        doc.fontSize(9).font('Helvetica-Oblique').fillColor('#e8604a').text('⚠ Er is een verschil tussen de ledger en de gekoppelde POS-transacties — controleer de detailregels in de Excel-export.');
        doc.fillColor('#000000');
      }

      doc.moveDown(1.5);
      doc.fontSize(8).font('Helvetica').fillColor('#999999').text('Alle bedragen zijn berekend vanuit de onderliggende ledger-boekingen (Gift Card Ledger / Loyalty Ledger), niet vanuit cache-velden. Voor volledige detailregels, zie de Excel-export.');

      doc.end();
    });
  }
}
