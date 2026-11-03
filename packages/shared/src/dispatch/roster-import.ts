/**
 * The roster CSV importer (owner's brief §14): one board row per line, co-drivers kept together,
 * pay tags lifted out of parentheses, truck numbers kept as text with their leading zeros, and a
 * stable id per row so running the import twice changes nothing.
 */

export interface RosterImportRow {
  /** Stable across runs: hashed from the team and the source name. */
  importKey: string;
  team: string;
  /** The name exactly as the sheet had it. */
  sourceName: string;
  name: string;
  coDriver: string | null;
  payTag: string | null;
  truckUnit: string | null;
  phone: string | null;
  line: number;
}

export interface RosterImportConflict {
  truckUnit: string;
  rows: { importKey: string; name: string; team: string }[];
}

export interface RosterImportResult {
  rows: RosterImportRow[];
  teams: string[];
  conflicts: RosterImportConflict[];
  skipped: { line: number; reason: string }[];
}

/** RFC-4180-ish: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
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
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** FNV-1a, twice, as 16 hex characters. Enough to key 128 rows without a database round trip. */
export function stableKey(...parts: string[]): string {
  const s = parts.map((p) => p.trim().toLowerCase()).join('|');
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return fnv(2166136261) + fnv(0x811c9dc5 ^ 0x5bd1e995);
}

/** `# 0053` → `0053`; only the decorative hash and the space go. */
export function cleanTruck(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().replace(/^#\s*/, '').trim();
  return t.length > 0 ? t : null;
}

/** "Baldwine / Michaelle" and "JOHN // MARK" are pairs; "A/C tech" is not. */
export function splitName(source: string): {
  name: string;
  coDriver: string | null;
  payTag: string | null;
} {
  let s = source.trim();
  let payTag: string | null = null;
  const tag = s.match(/\(([^()]*)\)\s*$/);
  if (tag) {
    payTag = tag[1]!.trim() || null;
    s = s.slice(0, tag.index).trim();
  }
  let parts: string[] | null = null;
  if (s.includes('//')) parts = s.split('//');
  else if (/^[A-Za-z][A-Za-z.' -]{1,}\s*\/\s*[A-Za-z][A-Za-z.' -]{1,}$/.test(s)) parts = s.split('/');
  if (parts && parts.length === 2) {
    const [a, b] = parts.map((p) => p.trim());
    return { name: titleCase(a!), coDriver: b ? titleCase(b) : null, payTag };
  }
  return { name: titleCase(s), coDriver: null, payTag };
}

/** Display casing: "JOHN O'BRIEN-SMITH" → "John O'Brien-Smith". The source string is kept beside it. */
export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s\-'./])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase())
    .trim();
}

const HEADER_ALIASES = {
  team: ['team', 'dispatcher', 'dispatch', 'disp'],
  name: ['driver', 'driver name', 'name', 'drivers'],
  truck: ['truck', 'truck #', 'truck#', 'unit', 'unit #', 'truck number'],
  phone: ['phone', 'phone #', 'phone number', 'cell'],
};

function findColumns(header: string[]): Record<keyof typeof HEADER_ALIASES, number> | null {
  const lower = header.map((h) => h.trim().toLowerCase());
  const pick = (aliases: string[]) => lower.findIndex((h) => aliases.includes(h));
  const cols = {
    team: pick(HEADER_ALIASES.team),
    name: pick(HEADER_ALIASES.name),
    truck: pick(HEADER_ALIASES.truck),
    phone: pick(HEADER_ALIASES.phone),
  };
  return cols.name >= 0 ? cols : null;
}

/**
 * Two layouts are read: a header row (Team / Driver / Truck / Phone in any order, any casing),
 * or the sheet's own shape where a line holding only a team name opens that team's block and
 * the lines after it are `name, truck`.
 */
export function parseRosterCsv(text: string): RosterImportResult {
  const lines = parseCsv(text);
  const rows: RosterImportRow[] = [];
  const skipped: { line: number; reason: string }[] = [];
  let cols: ReturnType<typeof findColumns> = null;
  let team = '';
  let headerLine = -1;
  lines.forEach((cells, index) => {
    const line = index + 1;
    const trimmed = cells.map((c) => c.trim());
    if (trimmed.every((c) => c === '')) return;
    if (!cols && headerLine < 0) {
      const found = findColumns(trimmed);
      if (found) {
        cols = found;
        headerLine = index;
        return;
      }
    }
    let teamCell = '';
    let nameCell = '';
    let truckCell = '';
    let phoneCell = '';
    if (cols) {
      teamCell = cols.team >= 0 ? (trimmed[cols.team] ?? '') : '';
      nameCell = trimmed[cols.name] ?? '';
      truckCell = cols.truck >= 0 ? (trimmed[cols.truck] ?? '') : '';
      phoneCell = cols.phone >= 0 ? (trimmed[cols.phone] ?? '') : '';
      if (teamCell) team = teamCell;
    } else {
      const nonEmpty = trimmed.filter((c) => c !== '');
      if (nonEmpty.length === 1 && !/\d{2,}/.test(nonEmpty[0]!)) {
        team = nonEmpty[0]!;
        return;
      }
      [nameCell = '', truckCell = '', phoneCell = ''] = nonEmpty;
      if (nonEmpty.length >= 3 && /^[A-Za-z]/.test(nonEmpty[0]!) && /^[A-Za-z]/.test(nonEmpty[1]!) && !/\d/.test(nonEmpty[1]!)) {
        // team, name, truck
        team = nonEmpty[0]!;
        [, nameCell = '', truckCell = '', phoneCell = ''] = nonEmpty;
      }
    }
    if (!nameCell) {
      skipped.push({ line, reason: 'no driver name' });
      return;
    }
    if (!team) {
      skipped.push({ line, reason: `"${nameCell}" has no team` });
      return;
    }
    const { name, coDriver, payTag } = splitName(nameCell);
    rows.push({
      importKey: `dbr_${stableKey(team, nameCell)}`,
      team: team.trim(),
      sourceName: nameCell,
      name,
      coDriver,
      payTag,
      truckUnit: cleanTruck(truckCell),
      phone: phoneCell || null,
      line,
    });
  });
  const byTruck = new Map<string, RosterImportRow[]>();
  for (const r of rows) if (r.truckUnit) byTruck.set(r.truckUnit, [...(byTruck.get(r.truckUnit) ?? []), r]);
  const conflicts: RosterImportConflict[] = [...byTruck.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([truckUnit, list]) => ({
      truckUnit,
      rows: list.map((r) => ({ importKey: r.importKey, name: r.name, team: r.team })),
    }));
  const teams = [...new Set(rows.map((r) => r.team))];
  return { rows, teams, conflicts, skipped };
}
