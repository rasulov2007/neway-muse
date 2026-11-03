import type { ReactNode } from 'react';
import { View } from 'react-native';

import { ApiError } from '@/api/client';
import { routes, type AuthAccount, type OfficeMe } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { BUSINESS_ZONE, now } from '@/lib/clock';
import { Text } from '@/ui/primitives';
import { t } from '@/i18n/core';
import { color, space, type StatusTone } from '@/ui/tokens';

/** GET /office/me: today roles, departments and the workspaces this person may open. */
export function useOfficeMe() {
  return useResource<OfficeMe>(routes.officeMe);
}

/** The person holds the code (an owner holds every one). The server checks again on every call. */
export function can(account: AuthAccount | null, permission: string): boolean {
  if (!account) return false;
  return account.isOwner || account.permissions.includes(permission);
}

/** "Mon, Apr 28, 2025" on the Eastern business clock. */
export function longDate(date: Date = now()): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_ZONE, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

export function severityTone(severity: string | null | undefined): StatusTone {
  if (severity === 'critical') return 'danger';
  if (severity === 'warning') return 'warning';
  return 'info';
}

/** Truck / driver words on the dispatch board (the server's status, shown with a family). */
export function unitStatus(status: string): { label: string; tone: StatusTone } {
  const s = status.toLowerCase();
  const label = t(s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
  if (['available', 'ready'].includes(s)) return { label, tone: 'success' };
  if (['active', 'in_transit', 'loaded', 'dispatched', 'on_load', 'enroute'].includes(s)) return { label, tone: 'moving' };
  if (['at_pickup', 'loading', 'at_delivery', 'unloading', 'idle_warning'].includes(s)) return { label, tone: 'warning' };
  if (['out_of_service', 'accident', 'in_shop', 'shop', 'down', 'inactive_hold'].includes(s)) return { label, tone: 'danger' };
  return { label, tone: 'neutral' };
}

/** The words a refused or failed write shows: the server's own detail. */
export function errorText(error: unknown, fallback = t('That did not go through.')): string {
  if (error instanceof ApiError) {
    if (error.kind === 'offline') return t('No connection. Try again when the phone is online.');
    if (error.kind === 'forbidden') return error.detail ?? t('Your role does not allow this.');
    return error.detail ?? error.title ?? fallback;
  }
  return (error as Error)?.message || fallback;
}

export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'conflict';
}

/** Label / value on a detail card (sheets 17, 20, 21): small gray label, value on the right. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', gap: space.md, paddingVertical: 4 }}>
      <Text variant="small" tint={color.text2} style={{ width: 120 }}>
        {label}
      </Text>
      <View style={{ flex: 1 }}>{typeof children === 'string' || typeof children === 'number' ? <Text variant="small">{children}</Text> : children}</View>
    </View>
  );
}

/** The `omitted` reasons an office route returns (a flag off, a permission missing). */
export function OmittedNotes({ omitted }: { omitted: Array<{ key: string; reason: string }> }) {
  if (!omitted.length) return null;
  return (
    <View style={{ marginTop: space.lg, gap: 2 }}>
      {omitted.map((o) => (
        <Text key={o.key} variant="caption" tint={color.text3}>
          {o.reason}
        </Text>
      ))}
    </View>
  );
}
