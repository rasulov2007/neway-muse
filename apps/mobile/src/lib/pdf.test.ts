import { base64ToBytes, buildPdf } from './pdf';

const text = (bytes: Uint8Array) => String.fromCharCode(...bytes);

describe('buildPdf', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

  it('writes one page per scan with valid xref offsets', () => {
    const pdf = buildPdf([
      { jpeg, width: 1200, height: 1600 },
      { jpeg, width: 1600, height: 1200 },
    ]);
    const s = text(pdf);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toContain('/Count 2');
    expect(s.match(/\/Type \/Page /g)).toHaveLength(2);
    expect(s).toContain('/MediaBox [0 0 792 612]'); // landscape page turned
    // every xref entry points at "<id> 0 obj"
    const xrefAt = Number(/startxref\n(\d+)/.exec(s)![1]);
    const entries = s.slice(xrefAt).split('\n').slice(3, 3 + 8);
    entries.forEach((line, i) => {
      const offset = Number(line.slice(0, 10));
      expect(s.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    // the JPEG is embedded byte for byte
    expect(s).toContain(text(jpeg));
  });

  it('refuses an empty document', () => {
    expect(() => buildPdf([])).toThrow();
  });
});

describe('base64ToBytes', () => {
  it('decodes plain and data-URL base64', () => {
    expect(Array.from(base64ToBytes('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(base64ToBytes('data:image/jpeg;base64,/9j/'))).toEqual([0xff, 0xd8, 0xff]);
    expect(text(base64ToBytes('aGVsbG8='))).toBe('hello');
  });
});
