import { AppError } from '../errors/app-error';

/**
 * A small, bounded multipart/form-data reader for one public route (the personal driver
 * application). The body arrives whole, already capped by the route's content-type parser; this
 * splits it on the boundary and refuses anything outside the limits instead of guessing.
 *
 * Deliberately narrow: `Content-Disposition: form-data; name="…"[; filename="…"]`, an optional
 * `Content-Type`, no nested multipart, no transfer encodings. Field values are UTF-8.
 */
export interface MultipartFile {
  field: string;
  fileName: string;
  declaredType: string | null;
  bytes: Buffer;
}

export interface MultipartBody {
  fields: Map<string, string[]>;
  files: Map<string, MultipartFile[]>;
}

export interface MultipartLimits {
  maxParts: number;
  maxFieldBytes: number;
  /** Per-field overrides of maxFieldBytes (e.g. a JSON field that carries signature images). */
  fieldBytes?: Record<string, number>;
  maxFileBytes: number;
  maxHeaderBytes: number;
}

function bad(detail: string, status = 422): AppError {
  return new AppError({ status, title: status === 413 ? 'Payload Too Large' : 'Unprocessable Entity', detail });
}

/** The boundary from a Content-Type header, or null when it is not multipart/form-data. */
export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const [type, ...params] = contentType.split(';').map((p) => p.trim());
  if (type?.toLowerCase() !== 'multipart/form-data') return null;
  for (const p of params) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq).trim().toLowerCase() !== 'boundary') continue;
    let value = p.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // RFC 2046: 1 to 70 characters.
    if (value.length < 1 || value.length > 70) return null;
    return value;
  }
  return null;
}

function headerParam(header: string, name: string): string | null {
  // name="value" with \" escapes, or name=token.
  const re = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))`, 'i');
  const m = re.exec(header);
  if (!m) return null;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? null);
}

export function parseMultipart(body: Buffer, boundary: string, limits: MultipartLimits): MultipartBody {
  const fields = new Map<string, string[]>();
  const files = new Map<string, MultipartFile[]>();
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const CRLF = Buffer.from('\r\n', 'latin1');
  const HEADER_END = Buffer.from('\r\n\r\n', 'latin1');

  let pos = body.indexOf(delimiter);
  if (pos < 0) throw bad('The form could not be read. Please try again.', 400);
  let parts = 0;
  for (;;) {
    pos += delimiter.length;
    // The closing delimiter: "--boundary--".
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (!body.subarray(pos, pos + 2).equals(CRLF)) throw bad('The form could not be read. Please try again.', 400);
    pos += 2;
    parts += 1;
    if (parts > limits.maxParts) throw bad('The form has too many parts.', 413);

    const headerEnd = body.indexOf(HEADER_END, pos);
    if (headerEnd < 0 || headerEnd - pos > limits.maxHeaderBytes) throw bad('The form could not be read. Please try again.', 400);
    const headers = body.subarray(pos, headerEnd).toString('utf8').split('\r\n');
    pos = headerEnd + 4;

    const next = body.indexOf(Buffer.concat([CRLF, delimiter]), pos);
    if (next < 0) throw bad('The form could not be read. Please try again.', 400);
    const content = body.subarray(pos, next);
    pos = next + 2;

    let disposition = '';
    let declaredType: string | null = null;
    for (const line of headers) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === 'content-disposition') disposition = value;
      else if (key === 'content-type') declaredType = value.slice(0, 100);
    }
    if (!/^form-data\b/i.test(disposition)) throw bad('The form could not be read. Please try again.', 400);
    const name = headerParam(disposition, 'name');
    if (!name || name.length > 64) throw bad('The form could not be read. Please try again.', 400);
    const fileName = headerParam(disposition, 'filename');

    if (fileName !== null) {
      // A file input left empty still sends a part with an empty file name and no bytes.
      if (fileName === '' && content.length === 0) continue;
      if (content.length > limits.maxFileBytes) throw bad('Each file must be 8 MB or smaller.', 413);
      const list = files.get(name) ?? [];
      list.push({ field: name, fileName, declaredType, bytes: Buffer.from(content) });
      files.set(name, list);
    } else {
      const max = limits.fieldBytes?.[name] ?? limits.maxFieldBytes;
      if (content.length > max) throw bad('One of the answers is too long.', 413);
      const list = fields.get(name) ?? [];
      list.push(content.toString('utf8'));
      fields.set(name, list);
    }
  }
  return { fields, files };
}
