import { excelSerialToIsoDate, readXlsx } from './xlsx-lite';

/**
 * The customer's PM board, read into rows (docs/pm-module/04-sheet-import.md §1).
 *
 * Twelve columns, matched by header whatever the case or spacing, so the sheet the customer
 * exports and the snake_case fixture in the package read the same. Values are parsed here and
 * nothing is judged: a blank is null, a number keeps its commas out, a date says which format
 * it arrived in. Judgement is the plan's.
 */

export interface SheetRow {
  /** 1-based line in the file, for the report. */
  line: number;
  rowLabel: string | null;
  unit: string | null;
  group: string | null;
  lastPmDate: string | null;
  lastPmDateFormat: 'iso' | 'us' | 'serial' | null;
  lastPmMileage: number | null;
  currentMileage: number | null;
  totalRunning: number | null;
  pmEvery: number | null;
  nextService: number | null;
  milesLeft: number | null;
  amount: number | null;
  shop: string | null;
  /** Cells that could not be read as what their column needs. */
  parseErrors: string[];
}

const COLUMNS: Record<string, keyof Omit<SheetRow, 'line' | 'parseErrors' | 'lastPmDateFormat'>> = {
  '#': 'rowLabel',
  row: 'rowLabel',
  unit: 'unit',
  group: 'group',
  'last pm date': 'lastPmDate',
  last_pm_date: 'lastPmDate',
  'last pm mileage': 'lastPmMileage',
  last_pm_mileage: 'lastPmMileage',
  'current mileage': 'currentMileage',
  current_mileage: 'currentMileage',
  'total running': 'totalRunning',
  total_running: 'totalRunning',
  'pm every': 'pmEvery',
  pm_every: 'pmEvery',
  'next service': 'nextService',
  next_service: 'nextService',
  'miles left': 'milesLeft',
  miles_left: 'milesLeft',
  amount: 'amount',
  shop: 'shop',
};

const REQUIRED: (keyof SheetRow)[] = ['unit', 'lastPmDate', 'lastPmMileage', 'currentMileage', 'pmEvery'];

function headerKey(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function blank(value: string): boolean {
  const v = value.trim();
  return v === '' || v === '—' || v === '-' || v === '–' || v.toLowerCase() === 'n/a';
}

function number(value: string, errors: string[], label: string): number | null {
  if (blank(value)) return null;
  const cleaned = value.replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    errors.push(`${label}: "${value}" is not a number`);
    return null;
  }
  return n;
}

function date(value: string, errors: string[], label: string): { iso: string | null; format: SheetRow['lastPmDateFormat'] } {
  if (blank(value)) return { iso: null, format: null };
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return { iso: v.slice(0, 10), format: 'iso' };
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (us) return { iso: `${us[3]}-${(us[1] as string).padStart(2, '0')}-${(us[2] as string).padStart(2, '0')}`, format: 'us' };
  if (/^\d+(\.\d+)?$/.test(v)) return { iso: excelSerialToIsoDate(Number(v)), format: 'serial' };
  errors.push(`${label}: "${value}" is not a date (ISO or MM/DD/YYYY)`);
  return { iso: null, format: null };
}

/** Header-mapped rows from a grid; the first row with a `unit` column is the header. */
export function rowsFromGrid(grid: string[][]): { rows: SheetRow[]; headers: string[]; missing: string[] } {
  const headerAt = grid.findIndex((r) => r.some((c) => headerKey(c) === 'unit'));
  if (headerAt < 0) throw new Error('No header row with a UNIT column');
  const headers = grid[headerAt] as string[];
  const map = headers.map((h) => COLUMNS[headerKey(h)] ?? null);
  const present = new Set(map.filter(Boolean));
  const missing = REQUIRED.filter((k) => !present.has(k as never));
  const rows: SheetRow[] = [];
  for (let i = headerAt + 1; i < grid.length; i += 1) {
    const cells = grid[i] as string[];
    const errors: string[] = [];
    const get = (key: string): string => {
      const at = map.indexOf(key as never);
      return at >= 0 ? (cells[at] ?? '') : '';
    };
    const lastPm = date(get('lastPmDate'), errors, 'LAST PM DATE');
    rows.push({
      line: i + 1,
      rowLabel: blank(get('rowLabel')) ? null : get('rowLabel').trim(),
      unit: blank(get('unit')) ? null : get('unit').trim().replace(/^#/, ''),
      group: blank(get('group')) ? null : get('group').trim(),
      lastPmDate: lastPm.iso,
      lastPmDateFormat: lastPm.format,
      lastPmMileage: number(get('lastPmMileage'), errors, 'LAST PM MILEAGE'),
      currentMileage: number(get('currentMileage'), errors, 'CURRENT MILEAGE'),
      totalRunning: number(get('totalRunning'), errors, 'TOTAL RUNNING'),
      pmEvery: number(get('pmEvery'), errors, 'PM EVERY'),
      nextService: number(get('nextService'), errors, 'NEXT SERVICE'),
      milesLeft: number(get('milesLeft'), errors, 'MILES LEFT'),
      amount: number(get('amount'), errors, 'AMOUNT'),
      shop: blank(get('shop')) ? null : get('shop').trim(),
      parseErrors: errors,
    });
  }
  return { rows, headers, missing };
}

/** A file, by its bytes and name: `.xlsx` through the zip reader, anything else as CSV. */
export function readSheet(buffer: Buffer, fileName: string): { rows: SheetRow[]; headers: string[]; missing: string[]; kind: 'xlsx' | 'csv' } {
  const isXlsx = /\.xlsx$/i.test(fileName) || (buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50);
  const grid = isXlsx ? readXlsx(buffer) : parseCsv(buffer.toString('utf8'));
  return { ...rowsFromGrid(grid), kind: isXlsx ? 'xlsx' : 'csv' };
}
