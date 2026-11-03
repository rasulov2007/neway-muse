import { createHash } from 'node:crypto';
import {
  DRIVER_CARE_MAX_FILE_BYTES,
  DRIVER_CARE_MAX_TOTAL_BYTES,
  type DriverCareFileType,
} from '@neway/shared';
import { AppError } from '../../common/errors/app-error';

export interface Receipt {
  fileName: string;
  contentType: DriverCareFileType;
  bytes: Buffer;
  sha256: string;
}

const EXTENSION: Record<DriverCareFileType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};

export function extensionFor(type: DriverCareFileType): string {
  return EXTENSION[type];
}

/** HEIF brands a phone camera writes (iPhone: heic / mif1). */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/**
 * What the bytes are, by their first bytes alone. The browser's type and the file name are never
 * trusted; anything that is not a JPEG, PNG, HEIC photo or a PDF is refused.
 */
export function sniff(bytes: Buffer): DriverCareFileType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp' && HEIF_BRANDS.has(bytes.subarray(8, 12).toString('latin1'))) {
    return 'image/heic';
  }
  return null;
}

/** A file name safe to keep and to show: no path, no control characters, bounded. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|]+/g, '').replace(/\s+/g, ' ').trim();
  return (clean || 'receipt').slice(0, 120);
}

function fileError(index: number, message: string, status = 422): AppError {
  return new AppError({
    status,
    title: status === 413 ? 'Payload Too Large' : 'Unprocessable Entity',
    detail: message,
    extensions: { errors: [{ path: `attachments.${index}`, message, code: 'custom' }] },
  });
}

/** Decodes, measures and identifies every receipt, or refuses the whole submission. */
export function decodeReceipts(files: { fileName: string; content: string }[]): Receipt[] {
  let total = 0;
  return files.map((file, index) => {
    const raw = file.content.startsWith('data:') ? file.content.slice(file.content.indexOf(',') + 1) : file.content;
    if (!/^[A-Za-z0-9+/=\s]*$/.test(raw)) throw fileError(index, 'That file could not be read. Attach it again.');
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length === 0) throw fileError(index, 'That file is empty.');
    if (bytes.length > DRIVER_CARE_MAX_FILE_BYTES) throw fileError(index, 'Each file can be up to 10 MB.', 413);
    total += bytes.length;
    if (total > DRIVER_CARE_MAX_TOTAL_BYTES) throw fileError(index, 'All files together can be up to 20 MB.', 413);
    const contentType = sniff(bytes);
    if (!contentType) throw fileError(index, 'Attach a photo (JPG, PNG, HEIC) or a PDF.');
    return {
      fileName: cleanFileName(file.fileName),
      contentType,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}
