import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseImportFile } from './file-parser';
import { suggestColumnMapping } from './column-mapping';
import { ParseImportDto, PreviewImportDto, CommitBatchDto, ResolveReviewDto } from './dto/import.dto';
import { createHash } from 'crypto';

const DEFAULT_BATCH_SIZE = 100;

interface MappedRow {
  rowNumber: number;
  raw: Record<string, string>;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  externalId?: string;
  language?: string;
  tier?: string;
  sourcePoints?: number; // ruwe waarde uit het bestand, vóór conversie
}

@Injectable()
export class ImportService {
  constructor(private prisma: PrismaService) {}

  // -- Stap 1: bestand uploaden en parsen (nog niets importeren) -----------

  async parseFile(orgId: string, userId: string | undefined, dto: ParseImportDto) {
    const parsed = await parseImportFile(dto.filename, dto.fileBase64);

    // Waarschuw (blokkeer niet) als exact dit bestand al eerder volledig
    // is verwerkt — sectie 8: voorkomt per ongeluk dubbel importeren,
    // maar een bevoegde beheerder kan altijd bewust doorgaan.
    const existingCompleted = await this.prisma.importJob.findFirst({
      where: { organizationId: orgId, fileHash: parsed.fileHash, status: 'completed' },
      orderBy: { createdAt: 'desc' },
    });

    const job = await this.prisma.importJob.create({
      data: {
        organizationId: orgId,
        locationId: dto.locationId,
        filename: dto.filename,
        fileHash: parsed.fileHash,
        status: 'parsed',
        totalRows: parsed.rows.length,
        rawRows: parsed.rows as never,
        createdByUserId: userId,
      },
    });

    const suggestedMapping = suggestColumnMapping(parsed.columns);

    return {
      importJobId: job.id,
      totalRows: parsed.rows.length,
      columns: parsed.columns,
      suggestedMapping,
      previewRows: parsed.rows.slice(0, 10),
      duplicateOfCompletedJobId: existingCompleted?.id ?? null,
    };
  }

  // -- Stap 2+3: kolommen mappen, conversie instellen, dry run -------------

  async preview(orgId: string, jobId: string, dto: PreviewImportDto) {
    const job = await this.getJobOrThrow(orgId, jobId);
    if (!job.rawRows) {
      throw new BadRequestException('Ruwe bestandsdata ontbreekt voor deze job (mogelijk al opgeschoond na eerdere voltooiing).');
    }
    if (dto.conversionType === 'ratio' && (!dto.conversionRate || dto.conversionRate <= 0)) {
      throw new BadRequestException('Vul een geldige conversieratio in (bijv. 100 punten = €1).');
    }

    const rawRows = job.rawRows as unknown as Record<string, string>[];
    const mappedRows = rawRows.map((raw, idx) => this.mapRow(raw, idx + 1, dto.columnMapping));

    const seenIdentities = new Map<string, number>();

    const existingCustomers = await this.prisma.customer.findMany({
      where: { organizationId: orgId, deletedAt: null },
      select: { id: true, email: true, phone: true, externalId: true, externalSource: true },
    });
    type MatchCandidate = { id: string; email: string | null; phone: string | null; externalId: string | null; externalSource: string | null };
    const byEmail = new Map<string, MatchCandidate>(existingCustomers.filter((c) => c.email).map((c): [string, MatchCandidate] => [c.email!.toLowerCase(), c]));
    const byPhone = new Map<string, MatchCandidate>(existingCustomers.filter((c) => c.phone).map((c): [string, MatchCandidate] => [this.normalizePhone(c.phone!), c]));
    const byExternalId = new Map<string, MatchCandidate>(
      existingCustomers.filter((c) => c.externalId && c.externalSource === 'piggy').map((c): [string, MatchCandidate] => [c.externalId!, c]),
    );

    const priorMigrationEntries = await this.prisma.walletLedgerEntry.findMany({
      where: { organizationId: orgId, entryType: 'migration_import' },
      select: { metadata: true },
    });
    const priorSourceIds = new Set(
      priorMigrationEntries
        .map((e) => (e.metadata as { source_customer_id?: string } | null)?.source_customer_id)
        .filter((id): id is string => !!id),
    );

    let successCount = 0;
    let errorCount = 0;
    let reviewCount = 0;
    let duplicateCount = 0;
    let totalSourceBalance = 0;
    let totalConvertedCredit = 0;

    const records = mappedRows.map((row) => {
      const rowHash = createHash('sha256').update(JSON.stringify(row.raw) + row.rowNumber).digest('hex');

      if (row.email && !this.isValidEmail(row.email)) {
        errorCount++;
        return this.buildRecord(job.id, row, rowHash, 'invalid', { errorMessage: 'Ongeldig e-mailadres' });
      }
      if (!row.email && !row.phone && !row.externalId) {
        errorCount++;
        return this.buildRecord(job.id, row, rowHash, 'invalid', { errorMessage: 'Geen e-mail, telefoon of klant-ID — kan niet worden geïdentificeerd' });
      }
      if (row.sourcePoints !== undefined && (isNaN(row.sourcePoints) || row.sourcePoints < 0)) {
        errorCount++;
        return this.buildRecord(job.id, row, rowHash, 'invalid', { errorMessage: 'Ongeldig of negatief saldo' });
      }

      const identityKey = (row.email?.toLowerCase() || '') + '|' + (row.phone ? this.normalizePhone(row.phone) : '') + '|' + (row.externalId || '');
      if (identityKey !== '||' && seenIdentities.has(identityKey)) {
        duplicateCount++;
        return this.buildRecord(job.id, row, rowHash, 'skip', {
          errorMessage: `Dubbele regel in bestand (zelfde als rij ${seenIdentities.get(identityKey)})`,
        });
      }
      if (identityKey !== '||') seenIdentities.set(identityKey, row.rowNumber);

      const emailMatch = row.email ? byEmail.get(row.email.toLowerCase()) : undefined;
      const phoneMatch = row.phone ? byPhone.get(this.normalizePhone(row.phone)) : undefined;
      const externalMatch = row.externalId ? byExternalId.get(row.externalId) : undefined;

      const distinctMatches = new Set([emailMatch?.id, phoneMatch?.id, externalMatch?.id].filter(Boolean));

      const sourcePoints = row.sourcePoints ?? 0;
      const convertedCredit = this.convert(sourcePoints, dto.conversionType, dto.conversionRate);
      totalSourceBalance += sourcePoints;

      if (distinctMatches.size > 1) {
        reviewCount++;
        return this.buildRecord(job.id, row, rowHash, 'review_required', {
          sourceBalance: sourcePoints,
          errorMessage: 'Tegenstrijdige match: e-mail en telefoon wijzen naar verschillende bestaande klanten',
        });
      }

      const matchedCustomer = emailMatch || phoneMatch || externalMatch;

      if (matchedCustomer && row.externalId && priorSourceIds.has(row.externalId)) {
        duplicateCount++;
        return this.buildRecord(job.id, row, rowHash, 'duplicate', {
          matchedCustomerId: matchedCustomer.id,
          sourceBalance: sourcePoints,
          errorMessage: 'Dit brondossier is al eerder geïmporteerd',
        });
      }

      totalConvertedCredit += convertedCredit;
      successCount++;
      if (matchedCustomer) {
        return this.buildRecord(job.id, row, rowHash, 'matched_customer', {
          matchedCustomerId: matchedCustomer.id,
          sourceBalance: sourcePoints,
          convertedCredit,
        });
      }
      return this.buildRecord(job.id, row, rowHash, 'new_customer', { sourceBalance: sourcePoints, convertedCredit });
    });

    await this.prisma.$transaction([
      this.prisma.importRecord.deleteMany({ where: { importJobId: job.id } }),
      this.prisma.importRecord.createMany({ data: records }),
      this.prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: 'previewed',
          columnMapping: dto.columnMapping as never,
          conversionType: dto.conversionType,
          conversionRate: dto.conversionType === 'ratio' ? dto.conversionRate : 1,
          balanceMode: dto.balanceMode,
          successRows: successCount,
          errorRows: errorCount,
          reviewRows: reviewCount,
          duplicateRows: duplicateCount,
          totalSourceBalance,
          totalConvertedCredit,
        },
      }),
    ]);

    return {
      importJobId: job.id,
      totalRows: mappedRows.length,
      newCustomers: records.filter((r) => r.action === 'new_customer').length,
      existingCustomers: records.filter((r) => r.action === 'matched_customer').length,
      reviewRequired: reviewCount,
      invalid: errorCount,
      duplicates: duplicateCount,
      totalSourceBalance,
      totalConvertedCredit,
      conversionType: dto.conversionType,
      conversionRate: dto.conversionType === 'ratio' ? dto.conversionRate : 1,
      sampleRecords: records.slice(0, 25),
    };
  }

  // -- Handmatige beoordeling van "review_required"-rijen -------------------

  async resolveReview(orgId: string, jobId: string, recordId: string, dto: ResolveReviewDto) {
    const job = await this.getJobOrThrow(orgId, jobId);
    const record = await this.prisma.importRecord.findFirst({ where: { id: recordId, importJobId: job.id } });
    if (!record) throw new NotFoundException('Import-rij niet gevonden');

    if (dto.resolution === 'skip') {
      return this.prisma.importRecord.update({ where: { id: record.id }, data: { action: 'skip', errorMessage: 'Handmatig overgeslagen' } });
    }
    if (dto.resolution === 'match_existing') {
      if (!dto.customerId) throw new BadRequestException('customerId is verplicht bij match_existing');
      const customer = await this.prisma.customer.findFirst({ where: { id: dto.customerId, organizationId: orgId } });
      if (!customer) throw new NotFoundException('Klant niet gevonden');
      return this.prisma.importRecord.update({
        where: { id: record.id },
        data: { action: 'matched_customer', matchedCustomerId: customer.id, errorMessage: null },
      });
    }
    return this.prisma.importRecord.update({
      where: { id: record.id },
      data: { action: 'new_customer', matchedCustomerId: null, errorMessage: null },
    });
  }

  // -- Stap 4: definitieve import, in batches ------------------------------

  async commitBatch(orgId: string, jobId: string, dto: CommitBatchDto) {
    const job = await this.getJobOrThrow(orgId, jobId);
    if (job.status !== 'previewed' && job.status !== 'processing') {
      throw new BadRequestException(`Job heeft status "${job.status}" — alleen een gepreviewde job kan worden geboekt.`);
    }

    if (job.status === 'previewed') {
      await this.prisma.importJob.update({ where: { id: job.id }, data: { status: 'processing', startedAt: new Date() } });
    }

    const batchSize = Math.min(dto.batchSize ?? DEFAULT_BATCH_SIZE, 200);
    const pending = await this.prisma.importRecord.findMany({
      where: { importJobId: job.id, action: { in: ['new_customer', 'matched_customer'] }, committedAt: null },
      take: batchSize,
      orderBy: { rowNumber: 'asc' },
    });

    let batchErrors = 0;
    for (const record of pending) {
      try {
        await this.commitOneRecord(orgId, job, record);
      } catch (err) {
        batchErrors++;
        await this.prisma.importRecord.update({
          where: { id: record.id },
          data: { action: 'invalid', errorMessage: `Boeken mislukt: ${(err as Error).message}` },
        });
      }
    }

    const remaining = await this.prisma.importRecord.count({
      where: { importJobId: job.id, action: { in: ['new_customer', 'matched_customer'] }, committedAt: null },
    });
    const processedSoFar = await this.prisma.importRecord.count({
      where: { importJobId: job.id, committedAt: { not: null } },
    });

    await this.prisma.importJob.update({ where: { id: job.id }, data: { processedRows: processedSoFar } });

    const done = remaining === 0;
    if (done) {
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: { status: 'completed', completedAt: new Date(), rawRows: null as never },
      });
    }

    return { processed: pending.length - batchErrors, batchErrors, remaining, done };
  }

  private async commitOneRecord(
    orgId: string,
    job: { id: string; balanceMode: string; filename: string; conversionRate: unknown; createdByUserId: string | null; columnMapping: unknown },
    record: { id: string; rowNumber: number; rawData: unknown; action: string; matchedCustomerId: string | null; sourceBalance: unknown; convertedCredit: unknown },
  ) {
    const raw = record.rawData as Record<string, string>;
    const convertedCredit = Number(record.convertedCredit ?? 0);
    const sourceBalance = Number(record.sourceBalance ?? 0);

    let customerId = record.matchedCustomerId;
    let customerCreated = false;

    if (record.action === 'new_customer') {
      const mapped = this.reconstructMappedFields(job, raw);
      const created = await this.prisma.customer.create({
        data: {
          organizationId: orgId,
          firstName: mapped.firstName,
          lastName: mapped.lastName,
          email: mapped.email,
          phone: mapped.phone,
          dateOfBirth: mapped.dateOfBirth ? new Date(mapped.dateOfBirth) : undefined,
          language: mapped.language || 'nl',
          externalId: mapped.externalId,
          externalSource: mapped.externalId ? 'piggy' : undefined,
          sourceChannel: 'import',
        } as never,
      });
      customerId = created.id;
      customerCreated = true;
    }

    if (!customerId) throw new Error('Geen klant gekoppeld aan deze rij');

    let wallet = await this.prisma.wallet.findUnique({ where: { customerId } });
    if (!wallet) wallet = await this.prisma.wallet.create({ data: { organizationId: orgId, customerId } });

    const metadata = {
      import_job_id: job.id,
      source: 'piggy',
      source_customer_id: raw?.['__externalId'] || undefined,
      original_points: sourceBalance,
      conversion_rate: job.conversionRate ? Number(job.conversionRate) : 1,
      converted_value: convertedCredit,
      imported_at: new Date().toISOString(),
      imported_by: job.createdByUserId,
      source_filename: job.filename,
    };

    const ledgerEntry = await this.prisma.$transaction(async (tx) => {
      if (job.balanceMode === 'replace') {
        const currentBalance = Number(wallet!.availableBalance);
        if (currentBalance !== 0) {
          await tx.walletLedgerEntry.create({
            data: {
              walletId: wallet!.id,
              organizationId: orgId,
              entryType: 'correction',
              amount: -currentBalance,
              status: 'available',
              source: 'system',
              performedByType: 'system',
              reason: 'Saldo teruggezet naar €0 vóór Piggy-migratie (vervangmodus)',
              occurredAt: new Date(),
            },
          });
          await tx.wallet.update({ where: { id: wallet!.id }, data: { availableBalance: { decrement: currentBalance } } });
        }
      }

      const entry = await tx.walletLedgerEntry.create({
        data: {
          walletId: wallet!.id,
          organizationId: orgId,
          entryType: 'migration_import',
          amount: convertedCredit,
          remainingAmount: convertedCredit,
          status: 'available',
          source: 'system',
          performedByType: 'system',
          reason: 'Piggy-migratie',
          metadata: metadata as never,
          occurredAt: new Date(),
        },
      });

      await tx.wallet.update({
        where: { id: wallet!.id },
        data: { availableBalance: { increment: convertedCredit }, lifetimeEarned: { increment: convertedCredit } },
      });

      return entry;
    });

    await this.prisma.importRecord.update({
      where: { id: record.id },
      data: { matchedCustomerId: customerId, ledgerEntryId: ledgerEntry.id, customerCreatedByImport: customerCreated, committedAt: new Date() },
    });
  }

  // -- Geschiedenis + detail ------------------------------------------------

  async listJobs(orgId: string) {
    return this.prisma.importJob.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, filename: true, source: true, status: true, totalRows: true, processedRows: true,
        successRows: true, errorRows: true, reviewRows: true, duplicateRows: true,
        totalConvertedCredit: true, conversionType: true, conversionRate: true,
        createdAt: true, completedAt: true, rolledBackAt: true,
      },
    });
  }

  async getJobDetail(orgId: string, jobId: string, page = 1, pageSize = 50) {
    const job = await this.getJobOrThrow(orgId, jobId);
    const records = await this.prisma.importRecord.findMany({
      where: { importJobId: job.id },
      orderBy: { rowNumber: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { job: { ...job, rawRows: undefined }, records };
  }

  // -- Rollback ---------------------------------------------------------------

  async rollback(orgId: string, jobId: string) {
    const job = await this.getJobOrThrow(orgId, jobId);
    if (job.status !== 'completed') {
      throw new BadRequestException('Alleen een volledig voltooide import kan worden teruggedraaid.');
    }

    const committedRecords = await this.prisma.importRecord.findMany({
      where: { importJobId: job.id, committedAt: { not: null }, ledgerEntryId: { not: null } },
    });

    let reversedCount = 0;
    let deletedCustomerCount = 0;

    for (const record of committedRecords) {
      const ledgerEntry = await this.prisma.walletLedgerEntry.findUnique({ where: { id: record.ledgerEntryId! } });
      if (!ledgerEntry) continue;
      const wallet = await this.prisma.wallet.findUnique({ where: { id: ledgerEntry.walletId } });
      if (!wallet) continue;

      const reversal = await this.prisma.$transaction(async (tx) => {
        const rev = await tx.walletLedgerEntry.create({
          data: {
            walletId: wallet.id,
            organizationId: orgId,
            entryType: 'correction',
            amount: -Number(ledgerEntry.amount),
            status: 'available',
            source: 'system',
            performedByType: 'system',
            reason: 'Rollback van Piggy-migratie',
            relatedLedgerEntryId: ledgerEntry.id,
            occurredAt: new Date(),
          },
        });
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { availableBalance: { decrement: Number(ledgerEntry.amount) }, lifetimeEarned: { decrement: Number(ledgerEntry.amount) } },
        });
        return rev;
      });

      await this.prisma.importRecord.update({ where: { id: record.id }, data: { reversalLedgerEntryId: reversal.id } });
      reversedCount++;

      if (record.customerCreatedByImport && record.matchedCustomerId) {
        const [txCount, resCount, otherLedgerCount] = await Promise.all([
          this.prisma.transaction.count({ where: { customerId: record.matchedCustomerId } }),
          this.prisma.reservation.count({ where: { customerId: record.matchedCustomerId } }).catch(() => 0),
          this.prisma.walletLedgerEntry.count({ where: { walletId: wallet.id, id: { notIn: [ledgerEntry.id, reversal.id] } } }),
        ]);
        if (txCount === 0 && resCount === 0 && otherLedgerCount === 0) {
          await this.prisma.customer.delete({ where: { id: record.matchedCustomerId } }).catch(() => undefined);
          deletedCustomerCount++;
        }
      }
    }

    await this.prisma.importJob.update({ where: { id: job.id }, data: { status: 'rolled_back', rolledBackAt: new Date() } });
    return { reversedCount, deletedCustomerCount };
  }

  // -- Hulpfuncties -----------------------------------------------------------

  private async getJobOrThrow(orgId: string, jobId: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id: jobId, organizationId: orgId } });
    if (!job) throw new NotFoundException('Import-job niet gevonden');
    return job;
  }

  private mapRow(raw: Record<string, string>, rowNumber: number, mapping: Record<string, string>): MappedRow {
    const get = (field: string) => {
      const col = mapping[field];
      if (!col) return undefined;
      const value = raw[col];
      return value === undefined || value === '' ? undefined : String(value).trim();
    };

    const pointsRaw = get('points_balance');
    let sourcePoints: number | undefined;
    if (pointsRaw !== undefined) {
      const normalized = pointsRaw.replace(/\./g, '').replace(',', '.');
      const parsedNormalized = parseFloat(normalized);
      const parsedPlain = parseFloat(pointsRaw);
      sourcePoints = !isNaN(parsedNormalized) ? parsedNormalized : parsedPlain;
    }

    return {
      rowNumber,
      raw: { ...raw, __externalId: get('external_customer_id') || '' },
      firstName: get('first_name') || get('full_name')?.split(' ')[0],
      lastName: get('last_name') || get('full_name')?.split(' ').slice(1).join(' '),
      email: get('email'),
      phone: get('phone'),
      dateOfBirth: get('date_of_birth'),
      externalId: get('external_customer_id'),
      language: get('language'),
      tier: get('tier'),
      sourcePoints,
    };
  }

  private reconstructMappedFields(job: unknown, raw: Record<string, string>) {
    const mapping = (job as { columnMapping?: Record<string, string> }).columnMapping || {};
    const get = (field: string) => {
      const col = mapping[field];
      if (!col) return undefined;
      const value = raw[col];
      return value === undefined || value === '' ? undefined : String(value).trim();
    };
    const fullName = get('full_name');
    return {
      firstName: get('first_name') || fullName?.split(' ')[0],
      lastName: get('last_name') || fullName?.split(' ').slice(1).join(' '),
      email: get('email'),
      phone: get('phone'),
      dateOfBirth: get('date_of_birth'),
      language: get('language'),
      externalId: get('external_customer_id'),
    };
  }

  private buildRecord(
    jobId: string,
    row: MappedRow,
    rowHash: string,
    action: 'new_customer' | 'matched_customer' | 'review_required' | 'invalid' | 'skip' | 'duplicate',
    extra: { matchedCustomerId?: string; sourceBalance?: number; convertedCredit?: number; errorMessage?: string },
  ) {
    return {
      importJobId: jobId,
      rowNumber: row.rowNumber,
      rowHash,
      rawData: row.raw as never,
      action,
      matchedCustomerId: extra.matchedCustomerId,
      sourceBalance: extra.sourceBalance,
      convertedCredit: extra.convertedCredit,
      errorMessage: extra.errorMessage,
    };
  }

  private convert(sourcePoints: number, type: 'ratio' | 'one_to_one', rate?: number): number {
    if (type === 'one_to_one') return Math.round(sourcePoints * 100) / 100;
    if (!rate || rate <= 0) return 0;
    return Math.round((sourcePoints / rate) * 100) / 100;
  }

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  private normalizePhone(phone: string): string {
    return phone.replace(/[^\d]/g, '');
  }
}
