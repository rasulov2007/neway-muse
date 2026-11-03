/**
 * What an uploaded image really is, read from its first bytes (2026-10-08).
 *
 * The declared content type of an upload is whatever the browser or the caller says; the magic
 * bytes are what the file is. Paths that accept photos only (assignment pickup/drop photos) store
 * a file only when both agree it is one of the allowed image types.
 */
export type SniffedImage = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';

/** HEIF brands a phone camera writes (HEIC stills, image sequences, the generic MIAF brands). */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii(8, 12))) {
    return 'image/heic';
  }
  return null;
}

/** The declared type agrees with the sniffed one (HEIF is declared as image/heic or image/heif). */
export function declaredMatches(declared: string, sniffed: SniffedImage): boolean {
  const d = declared.toLowerCase().trim();
  if (d === sniffed) return true;
  if (sniffed === 'image/jpeg' && d === 'image/jpg') return true;
  if (sniffed === 'image/heic' && (d === 'image/heif' || d === 'image/heic-sequence')) return true;
  return false;
}
