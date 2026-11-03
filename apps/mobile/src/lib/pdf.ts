/**
 * A multi-page scan becomes ONE PDF (docs/mobile/API.md: "a multi-page paper is one file"). The
 * pages are already JPEGs, and a PDF can carry a JPEG as it is (DCTDecode), so this writes the
 * file by hand — no native module, the same bytes on iOS, Android and the web build.
 */
export interface PdfPage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

const LETTER = { width: 612, height: 792 };
const MARGIN = 18;

const encoder = { encode: (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff) };

export function buildPdf(pages: PdfPage[]): Uint8Array {
  if (pages.length === 0) throw new Error('A PDF needs at least one page.');
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: Uint8Array | string) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: () => void) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    body();
    push('\nendobj\n');
  };

  // 1 catalog, 2 pages, then per page: page, image, content.
  const pageIds = pages.map((_, i) => 3 + i * 3);
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () => push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`));

  pages.forEach((page, i) => {
    const pageId = pageIds[i]!;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const landscape = page.width > page.height;
    const box = landscape ? { width: LETTER.height, height: LETTER.width } : LETTER;
    const scale = Math.min((box.width - MARGIN * 2) / page.width, (box.height - MARGIN * 2) / page.height);
    const w = +(page.width * scale).toFixed(2);
    const h = +(page.height * scale).toFixed(2);
    const x = +((box.width - w) / 2).toFixed(2);
    const y = +((box.height - h) / 2).toFixed(2);
    const content = `q ${w} 0 0 ${h} ${x} ${y} cm /Im0 Do Q`;

    object(pageId, () =>
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${box.width} ${box.height}] ` +
          `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    object(imageId, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      );
      push(page.jpeg);
      push('\nendstream');
    });
    object(contentId, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  });

  const count = 3 + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 (optionally a data: URL) to bytes, without relying on atob. */
export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/^data:[^,]*,/, '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const ch of clean) {
    buffer = (buffer << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }
  return out.slice(0, at);
}
