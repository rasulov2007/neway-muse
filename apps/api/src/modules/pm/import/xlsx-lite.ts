import { inflateRawSync } from 'node:zlib';

/**
 * The smallest XLSX reader that reads the customer's PM board.
 *
 * A workbook is a zip of XML files. This walks the zip's central directory, inflates the first
 * worksheet and the shared strings, and returns the cells as strings - numbers as their decimal
 * text, dates left as Excel serial numbers for the caller to recognise by column. No formulas
 * are evaluated (the sheet's derived columns are recomputed by the importer anyway), no styles
 * are read, and nothing is added to the runtime: a dependency for one flat sheet is not worth
 * carrying.
 */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function readEntries(buffer: Buffer): ZipEntry[] {
  // End of central directory: the last 22+ bytes, with the comment length at the end.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file (no central directory)');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip (central directory entry)');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const header = entry.localOffset;
  if (buffer.readUInt32LE(header) !== 0x04034b50) throw new Error(`Corrupt zip (local header for ${entry.name})`);
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported zip compression (${entry.method}) for ${entry.name}`);
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  const items = xml.match(/<si>[\s\S]*?<\/si>/g) ?? [];
  for (const item of items) {
    const texts = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1] ?? ''));
    out.push(texts.join(''));
  }
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The first worksheet as rows of cell strings; empty cells are ''. Serial dates stay numeric. */
export function readXlsx(buffer: Buffer): string[][] {
  const entries = readEntries(buffer);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const sheetEntry =
    byName.get('xl/worksheets/sheet1.xml') ?? entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  if (!sheetEntry) throw new Error('The workbook has no worksheet');
  const strings = byName.has('xl/sharedStrings.xml') ? sharedStrings(readEntry(buffer, byName.get('xl/sharedStrings.xml') as ZipEntry).toString('utf8')) : [];
  const sheet = readEntry(buffer, sheetEntry).toString('utf8');

  const rows: string[][] = [];
  for (const rowXml of sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const row: string[] = [];
    for (const cell of rowXml.matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? '';
      const inner = cell[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /t="(\w+)"/.exec(attrs)?.[1] ?? 'n';
      const index = ref ? columnIndex(ref) : row.length;
      let value: string;
      if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        value = v === undefined ? '' : (strings[Number(v)] ?? '');
      } else if (type === 'inlineStr') {
        value = decodeXml(/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '');
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      }
      while (row.length < index) row.push('');
      row[index] = value;
    }
    rows.push(row);
  }
  return rows;
}

/** Excel's serial day number to an ISO date (1900 date system, with its leap-year quirk). */
export function excelSerialToIsoDate(serial: number): string {
  const days = Math.floor(serial) - (serial > 59 ? 1 : 0);
  const epoch = Date.UTC(1900, 0, 1);
  return new Date(epoch + (days - 1) * 86_400_000).toISOString().slice(0, 10);
}
