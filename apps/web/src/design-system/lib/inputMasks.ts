/**
 * What a field writes for the person while they type (owner, 2026-10-13): a US phone as
 * (555) 010-1431, a date as 08/09/2029 with the slashes put in, money as 500.00.
 */

/** A US number as (555) 010-1431 while it is typed; anything starting with + is left as typed. */
export function formatUsPhone(value: string): string {
  if (value.trim().startsWith('+')) return value;
  let digits = value.replace(/\D/g, '');
  // A leading country code 1 on an 11-digit number is dropped: the form is US.
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length > 10 || /[^\d\s()+-]/.test(value)) return value;
  if (digits.length === 0) return '';
  if (digits.length < 4) return `(${digits}`;
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * MM/DD/YYYY with the slashes added as the digits arrive: 08 → "08/", 0809 → "08/09/".
 * Only while typing forward, and only when any slash already there is where the mask puts it,
 * so "8/9/2029" typed by hand and backspacing over a slash both behave.
 */
export function maskDateTyping(previous: string, next: string): string {
  if (next.length <= previous.length) return next;
  // A slash typed right after the one the mask already put in is the same slash.
  if (previous.endsWith('/') && next === `${previous}/`) return previous;
  if (!/^[\d/]*$/.test(next)) return next;
  for (let i = 0; i < next.length; i += 1) {
    if (next[i] === '/' && i !== 2 && i !== 5) return next;
  }
  const digits = next.replace(/\D/g, '').slice(0, 8);
  // Only a real month and day get their slash: 2031-01-31 typed as a year is left alone.
  const month = Number(digits.slice(0, 2));
  if (digits.length >= 2 && (month < 1 || month > 12)) return next;
  const day = Number(digits.slice(2, 4));
  if (digits.length >= 4 && (day < 1 || day > 31)) return next;
  let out = digits.slice(0, 2);
  if (digits.length >= 2) out += '/';
  out += digits.slice(2, 4);
  if (digits.length >= 4) out += '/';
  out += digits.slice(4, 8);
  return out;
}

/** "500" → "500.00", "1,250.5" → "1250.50"; anything that is not a plain amount is left alone. */
export function formatMoneyInput(value: string): string {
  const clean = value.replace(/[$,\s]/g, '');
  if (clean === '' || !/^-?\d*\.?\d*$/.test(clean) || clean === '.' || clean === '-') return value;
  const n = Number(clean);
  if (!Number.isFinite(n)) return value;
  return n.toFixed(2);
}
