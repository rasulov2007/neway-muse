import { describe, expect, it } from 'vitest';
import { rowsFromGrid } from './sheet';
import { excelSerialToIsoDate, readXlsx } from './xlsx-lite';

/** A stored (uncompressed) zip, enough to be a workbook: local headers, central directory, end record. */
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

const WORKBOOK = zip({
  '[Content_Types].xml': '<Types/>',
  'xl/workbook.xml': '<workbook><sheets><sheet name="PM" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/sharedStrings.xml':
    '<sst><si><t>#</t></si><si><t>UNIT</t></si><si><t>GROUP</t></si><si><t>LAST PM DATE</t></si><si><t>LAST PM MILEAGE</t></si><si><t>CURRENT MILEAGE</t></si><si><t>TOTAL RUNNING</t></si><si><t>PM EVERY</t></si><si><t>NEXT SERVICE</t></si><si><t>MILES LEFT</t></si><si><t>AMOUNT</t></si><si><t>SHOP</t></si><si><t>NWF</t></si><si><r><t>1402 E Main St, </t></r><r><t>Duncan, SC 29334</t></r></si></sst>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c><c r="G1" t="s"><v>6</v></c><c r="H1" t="s"><v>7</v></c><c r="I1" t="s"><v>8</v></c><c r="J1" t="s"><v>9</v></c><c r="K1" t="s"><v>10</v></c><c r="L1" t="s"><v>11</v></c></row>' +
    '<row r="2"><c r="A2"><v>61</v></c><c r="B2" t="inlineStr"><is><t>0026</t></is></c><c r="C2" t="s"><v>12</v></c><c r="D2"><v>46210</v></c><c r="E2"><v>400937</v></c><c r="F2"><v>436158</v></c><c r="G2"><v>35221</v></c><c r="H2"><v>30000</v></c><c r="I2"><v>430937</v></c><c r="J2"><v>-5221</v></c><c r="K2"><v>501.97</v></c><c r="L2" t="s"><v>13</v></c></row>' +
    '</sheetData></worksheet>',
});

describe('the workbook reader', () => {
  it('reads shared strings, rich text, inline strings and numbers from the first sheet', () => {
    const grid = readXlsx(WORKBOOK);
    expect(grid[0]?.slice(0, 3)).toEqual(['#', 'UNIT', 'GROUP']);
    expect(grid[1]).toEqual(['61', '0026', 'NWF', '46210', '400937', '436158', '35221', '30000', '430937', '-5221', '501.97', '1402 E Main St, Duncan, SC 29334']);
  });

  it('turns an Excel serial date into the day it means', () => {
    expect(excelSerialToIsoDate(46210)).toBe('2026-07-07');
    expect(excelSerialToIsoDate(45658)).toBe('2025-01-01');
    const { rows } = rowsFromGrid(readXlsx(WORKBOOK));
    expect(rows[0]).toMatchObject({ unit: '0026', lastPmDate: '2026-07-07', lastPmDateFormat: 'serial', amount: 501.97, shop: '1402 E Main St, Duncan, SC 29334' });
  });
});
