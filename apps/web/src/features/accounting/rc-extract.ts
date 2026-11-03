import { fetchFileBlob, type FileRef } from '@/lib/files';

/**
 * Reading the broker reference off a rate confirmation (corrective brief, section 6).
 *
 * A digital PDF gives up its text directly (pdf.js); a scan or a photo goes through OCR
 * (tesseract.js, in the browser - the file never leaves the machine to be read). Either way the
 * result is *offered* with its evidence and confidence, never accepted on its own: the person
 * sees the line the number was found on and records it, and the comparison runs on the server.
 */
export interface RcExtraction {
  reference: string | null;
  confidence: 'extracted' | 'uncertain';
  method: 'pdf_text' | 'ocr' | 'none';
  /** The line the reference was read from, so the person can check it against the page. */
  evidence: string | null;
  /** Other numbers that looked like a reference, offered when the first is wrong. */
  candidates: string[];
  detail: string;
}

const LABEL = /\b(?:rate\s*conf(?:irmation)?|confirmation|load|order|ref(?:erence)?|po|pro|shipment|booking|trip)\s*(?:#|no\.?|number|id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})/gi;
const STOP = new Set(['DATE', 'RATE', 'TOTAL', 'PAGE', 'PHONE', 'FAX', 'EMAIL', 'CARRIER', 'BROKER']);

function candidatesIn(text: string, expected: string | null): { reference: string | null; evidence: string | null; candidates: string[]; sure: boolean } {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const found: Array<{ value: string; line: string; score: number }> = [];
  for (const line of lines) {
    for (const m of line.matchAll(LABEL)) {
      const value = m[1]!.toUpperCase().replace(/[^A-Z0-9-]/g, '');
      if (STOP.has(value) || value.length < 4 || !/\d/.test(value)) continue;
      const score = (/load|rate|conf/i.test(m[0]) ? 2 : 1) + (expected && value === expected.toUpperCase() ? 10 : 0);
      found.push({ value, line, score });
    }
  }
  if (expected) {
    const norm = expected.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    for (const line of lines) if (norm && line.toUpperCase().replace(/[^A-Z0-9-]/g, '').includes(norm)) found.push({ value: norm, line, score: 20 });
  }
  found.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const unique = found.filter((f) => (seen.has(f.value) ? false : (seen.add(f.value), true)));
  const best = unique[0] ?? null;
  return { reference: best?.value ?? null, evidence: best?.line ?? null, candidates: unique.slice(1, 6).map((f) => f.value), sure: Boolean(best && (best.score >= 10 || unique.length === 1)) };
}

async function pdfText(blob: Blob): Promise<{ text: string; pages: number; firstPage: HTMLCanvasElement | null }> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  let text = '';
  for (let i = 1; i <= Math.min(doc.numPages, 5); i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY: number | null = null;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform[5] as number;
      if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n';
      text += `${item.str} `;
      lastY = y;
    }
    text += '\n';
  }
  let firstPage: HTMLCanvasElement | null = null;
  if (text.trim().length < 40) {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
    firstPage = canvas;
  }
  return { text, pages: doc.numPages, firstPage };
}

async function ocr(image: Blob | HTMLCanvasElement): Promise<string> {
  const { recognize } = await import('tesseract.js');
  const result = await recognize(image, 'eng');
  return result.data.text;
}

export async function extractRcReference(doc: FileRef, expected: string | null): Promise<RcExtraction> {
  const blob = await fetchFileBlob(doc);
  const isPdf = (doc.mimeType ?? blob.type).includes('pdf') || (doc.fileName ?? '').toLowerCase().endsWith('.pdf');
  let text = '';
  let method: RcExtraction['method'] = 'none';
  let detail = '';
  if (isPdf) {
    const pdf = await pdfText(blob);
    if (pdf.text.trim().length >= 40) {
      text = pdf.text;
      method = 'pdf_text';
      detail = `Text read from ${Math.min(pdf.pages, 5)} of ${pdf.pages} page(s).`;
    } else if (pdf.firstPage) {
      text = await ocr(pdf.firstPage);
      method = 'ocr';
      detail = 'The PDF has no text layer (a scan); the first page was read by OCR.';
    }
  } else if (blob.type.startsWith('image/')) {
    text = await ocr(blob);
    method = 'ocr';
    detail = 'Image read by OCR.';
  } else {
    return { reference: null, confidence: 'uncertain', method: 'none', evidence: null, candidates: [], detail: `Cannot read a ${blob.type || 'file of unknown type'}; open it and type the reference.` };
  }
  const c = candidatesIn(text, expected);
  return { reference: c.reference, confidence: c.sure && method === 'pdf_text' ? 'extracted' : 'uncertain', method, evidence: c.evidence, candidates: c.candidates, detail: c.reference ? detail : `${detail} No reference-looking number was found; open the document and type it.` };
}
