import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The text inside a PDF, laid out as it prints (poppler's `pdftotext -layout`).
 *
 * Broker RCs are almost always generated PDFs with a text layer; a scan or a phone photo has
 * none, and this returns an empty string for it.
 */
export async function pdfText(bytes: Buffer, timeoutMs = 20_000): Promise<string> {
  // pdftotext reads a file, not stdin, on every build we run (Windows' one exits 99 on "-").
  const dir = await mkdtemp(join(tmpdir(), 'rc-'));
  const file = join(dir, 'rc.pdf');
  try {
    await writeFile(file, bytes);
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
        else reject(new Error(`pdftotext exited with ${code}`));
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The text a small model reads: column gaps shortened to a marker, blank lines dropped, form feeds
 * and the repeated legal pages cut once the page count passes `maxChars`. A 3B model on CPU pays
 * for every token, and layout spaces are most of them.
 */
export function compactRcText(text: string, maxChars = 7000): string {
  const lines = text
    .replace(/\f/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[^\S\n]{3,}/g, ' | ').replace(/[^\x20-\x7E|]/g, ' ').trim())
    .filter((l) => l.length > 0 && !/^[|\s]*$/.test(l));
  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > maxChars) break;
    out += `${l}\n`;
  }
  return out;
}

/** True when the PDF carried enough text to read without OCR. */
export function hasTextLayer(text: string): boolean {
  return text.replace(/\s/g, '').length > 200;
}

/**
 * The text the fine-tuned `neway-rc-v2` model reads (owner, 2026-10-02: an RC in about 30 s on the
 * 2-vCPU server). It must stay byte-for-byte what the model was trained on - `compact()` in
 * rctrain/build_text_v2.py: column gaps to " | ", non-ASCII to spaces, runs of spaces collapsed,
 * legal prose (12+ words without a digit) dropped, capped at 4,500 characters.
 */
export function compactRcTextV2(text: string, maxChars = 4500): string {
  let out = '';
  for (const raw of text.replace(/\f/g, '\n').split('\n')) {
    const line = raw
      .replace(/[^\S\n]{3,}/g, ' | ')
      .replace(/[^\x20-\x7E|]/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
    if (!line || /^[|\s.\-_=*]*$/.test(line)) continue;
    if (line.split(/\s+/).filter(Boolean).length >= 12 && !/\d/.test(line)) continue;
    if (out.length + line.length + 1 > maxChars) break;
    out += `${line}\n`;
  }
  return out;
}

function run(cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env });
    const out: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`${cmd} exited with ${code}`));
    });
  });
}

/**
 * A scan's text, by OCR (poppler + tesseract): the first four pages at 300 dpi in grey, pages
 * joined by form feeds - the same settings the v2 model's scan examples were made with. Pages run
 * one at a time (each tesseract takes ~440 MB at 300 dpi) with two threads; a 4-page scan takes
 * about a minute and a half on the 2-vCPU server.
 */
export async function pdfOcrText(bytes: Buffer, timeoutMs = 240_000): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rc-ocr-'));
  const file = join(dir, 'rc.pdf');
  const deadline = Date.now() + timeoutMs;
  try {
    await writeFile(file, bytes);
    await run('pdftoppm', ['-r', '300', '-gray', '-l', '4', '-png', file, join(dir, 'p')], timeoutMs);
    const pages = (await readdir(dir)).filter((f) => /^p-?\d+\.png$/.test(f)).sort();
    const texts: string[] = new Array(pages.length).fill('');
    const env = { ...process.env, OMP_THREAD_LIMIT: '2' };
    let next = 0;
    const worker = async () => {
      while (next < pages.length) {
        const i = next++;
        texts[i] = await run('tesseract', [join(dir, pages[i]!), 'stdout', '-c', 'preserve_interword_spaces=1'], Math.max(1_000, deadline - Date.now()), env);
      }
    };
    // One page at a time: a 300 dpi page costs tesseract ~440 MB, and two at once ran the api
    // container out of memory (2026-10-02).
    await worker();
    return texts.map((t) => `${t}\f`).join('');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
