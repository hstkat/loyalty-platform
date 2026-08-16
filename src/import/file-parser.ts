import { BadRequestException } from '@nestjs/common';
import * as Papa from 'papaparse';
import { Workbook, Cell, Row } from 'exceljs';
import { createHash } from 'crypto';

export interface ParsedFile {
  columns: string[];
  rows: Record<string, string>[];
  fileHash: string;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — ruim voldoende voor een paar duizend rijen, houdt de serverloze functie binnen zijn tijdslimiet
const MAX_ROWS = 10_000;

/**
 * Parses an uploaded CSV or XLSX file (given as base64) into a uniform
 * row structure. Deliberately conservative about size/row limits — this
 * runs inside a single Vercel serverless invocation with a hard time
 * budget, not a background worker (see README "Bekende begrenzingen").
 */
export async function parseImportFile(filename: string, fileBase64: string): Promise<ParsedFile> {
  const buffer = Buffer.from(fileBase64, 'base64');
  if (buffer.length > MAX_FILE_BYTES) {
    throw new BadRequestException(`Bestand is te groot (max. ${MAX_FILE_BYTES / 1024 / 1024} MB) — splits het op in kleinere delen.`);
  }
  if (buffer.length === 0) {
    throw new BadRequestException('Bestand is leeg.');
  }

  const extension = filename.toLowerCase().split('.').pop();
  const fileHash = createHash('sha256').update(new Uint8Array(buffer)).digest('hex');

  let rows: Record<string, string>[];
  let columns: string[];

  if (extension === 'csv') {
    ({ rows, columns } = parseCsv(buffer));
  } else if (extension === 'xlsx' || extension === 'xls') {
    ({ rows, columns } = await parseXlsx(buffer));
  } else {
    throw new BadRequestException('Alleen .csv en .xlsx-bestanden worden ondersteund.');
  }

  if (rows.length === 0) {
    throw new BadRequestException('Geen rijen gevonden in het bestand.');
  }
  if (rows.length > MAX_ROWS) {
    throw new BadRequestException(`Bestand bevat ${rows.length} rijen — het maximum is ${MAX_ROWS}. Splits het bestand op.`);
  }

  return { columns, rows, fileHash };
}

function parseCsv(buffer: Buffer): { rows: Record<string, string>[]; columns: string[] } {
  const text = buffer.toString('utf-8');
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });

  if (result.errors.length > 0 && result.data.length === 0) {
    throw new BadRequestException('Kon het CSV-bestand niet lezen: ' + result.errors[0].message);
  }

  const columns = result.meta.fields || [];
  return { rows: result.data, columns };
}

async function parseXlsx(buffer: Buffer): Promise<{ rows: Record<string, string>[]; columns: string[] }> {
  const workbook = new Workbook();
  try {
    // Cast nodig door een bekend typeconflict tussen @types/node-versies
    // en exceljs' eigen Buffer-typedefinitie (Vercel's schone install
    // gebruikt een net iets andere @types/node-resolutie dan sommige
    // lokale omgevingen) — functioneel identiek, alleen de TypeScript-
    // typen botsen onterecht.
    await workbook.xlsx.load(buffer as never);
  } catch (err) {
    throw new BadRequestException('Kon het Excel-bestand niet lezen — is het echt een .xlsx-bestand?');
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new BadRequestException('Geen werkblad gevonden in het Excel-bestand.');

  const headerRow = sheet.getRow(1);
  const columns: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell: Cell) => {
    columns.push(String(cell.value ?? '').trim());
  });

  const rows: Record<string, string>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row: Row, rowNumber: number) => {
    if (rowNumber === 1) return; // header
    const obj: Record<string, string> = {};
    let hasAnyValue = false;
    columns.forEach((col, idx) => {
      const cell = row.getCell(idx + 1);
      let value: unknown = cell.value;
      // Excel-formules: gebruik de berekende waarde, nooit de formule-tekst
      if (value && typeof value === 'object' && 'result' in (value as object)) {
        value = (value as { result: unknown }).result;
      }
      if (value instanceof Date) {
        obj[col] = value.toISOString().slice(0, 10);
      } else {
        obj[col] = value === null || value === undefined ? '' : String(value).trim();
      }
      if (obj[col]) hasAnyValue = true;
    });
    if (hasAnyValue) rows.push(obj);
  });

  return { rows, columns };
}
