/**
 * Exports (§10). A spreadsheet treats a cell starting with `=`, `+`, `-`, `@` (or a tab/CR)
 * as a formula; a vendor named `=HYPERLINK(...)` would run in the reader's Excel. Every text
 * cell in a CSV or XLSX export goes through here first. Numbers are left alone, so the
 * financial columns stay numbers.
 */
export function safeCell(value: string | number | null | undefined): string | number {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  const text = String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** A file name that survives every OS: letters, digits, dot, dash, underscore. */
export function safeFileName(name: string, fallback = 'export'): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}
