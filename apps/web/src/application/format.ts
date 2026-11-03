/** Display helpers. Every date and time on the page is US Eastern (owner rule); calendar dates are shown as they are. */
export const idOf = (p: string) => 'f_' + p.replace(/[^a-z0-9]/gi, '_');
export const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (m && d.length === 10) return `${m[2]}/${m[3]}/${m[1]}`;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'America/New_York' });
};
export const fmtDT = (d: string | null | undefined) =>
  d ? `${new Date(d).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET` : '—';
export const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

/** YYYY-MM-DD plus n days (UTC arithmetic on a calendar date). */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const maskSsn = (last4: string | null | undefined) => (last4 ? `•••-••-${last4}` : '');
