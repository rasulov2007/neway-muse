import type { FollowUpState, RecruitScope } from '@neway/shared';
import type { HrSearch } from '../hr-search';

/** The external driver application (external-driver-application). Its intake is not connected yet. */
export const EXTERNAL_APPLICATION_URL = 'https://driver-application.example.com';

/**
 * All leads first (owner, 2026-10-09): for someone allowed to see everyone, All leads is the
 * default and My leads is chosen with ?tab=my-leads. Old links (all-leads, leads) still land on All.
 * A recruiter without that permission always gets My leads (decided by the caller).
 */
export function scopeOf(search: HrSearch): RecruitScope {
  return search.tab === 'my-leads' ? 'mine' : 'all';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Business dates are calendar days (formatted as such); instants are shown on the Eastern clock. */
const SHORT_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const SHORT_EASTERN = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
const LONG_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const LONG_EASTERN = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
const SHORT_EASTERN_TIME = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
const LONG_EASTERN_TIME = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' });

/**
 * How long ago a lead came in (owner, 2026-10-09): "just now", "25 min ago", "1 hour ago",
 * "3 days ago"; older than 30 days shows the date. `now` is passed so the list can tick.
 */
export function ageLabel(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const minutes = Math.max(0, Math.floor((now - t) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return days === 1 ? '1 day ago' : `${days} days ago`;
  return shortDate(iso);
}

/** "Oct 8, 3:22 PM" in Eastern time: when a lead came in, for the list. */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : SHORT_EASTERN_TIME.format(new Date(t));
}

/** "Oct 8, 2026, 3:22 PM EDT": when a lead came in, for the candidate header. */
export function longDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : LONG_EASTERN_TIME.format(new Date(t));
}

/** "Today", "Tomorrow", "Overdue · Oct 6", "Oct 9" — against the server's (Eastern) today. */
export function followUpLabel(on: string | null, state: FollowUpState | null, today: string | undefined): string {
  if (!on || !state) return '—';
  const date = SHORT_DAY.format(new Date(`${on}T12:00:00Z`));
  if (state === 'today') return 'Today';
  if (state === 'overdue') return `Overdue · ${date}`;
  if (today) {
    const next = new Date(`${today}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    if (next.toISOString().slice(0, 10) === on) return 'Tomorrow';
  }
  return date;
}

/** "Oct 9". */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return ISO_DATE.test(iso) ? SHORT_DAY.format(new Date(`${iso}T12:00:00Z`)) : SHORT_EASTERN.format(new Date(iso));
}

/** "Aug 20, 2027"; a masked value (not a date) passes through as it is. */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  if (ISO_DATE.test(iso)) return LONG_DAY.format(new Date(`${iso}T12:00:00Z`));
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : LONG_EASTERN.format(new Date(t));
}

/** Saves a file the API serves to a signed-in caller (the bearer token goes with the request). */
export async function downloadAuthed(fileUrl: string, fileName: string): Promise<void> {
  const { fetchFileBlob } = await import('@/lib/files');
  const blob = await fetchFileBlob({ fileUrl });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
