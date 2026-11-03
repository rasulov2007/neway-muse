import { demoData } from './data';
import { nowIsoString } from './internals';
import { saveSoon } from './state-persist';
import type { Notification } from './types';

/**
 * A notification raised by something that happened, into the same list the bell reads.
 *
 * The seeded list was the only source until now; a walk-around putting a unit out of service
 * is the first event the product raises itself. It is addressed to a department, because that
 * is what the notification model carries; the person it concerns is named in the body.
 */
export function pushNotification(input: Omit<Notification, 'id' | 'at' | 'readAt'>): Notification {
  const row: Notification = {
    ...input,
    id: `ntf_${Date.now().toString(36)}_${demoData.notifications.length}`,
    at: nowIsoString(),
    readAt: null,
  };
  demoData.notifications.unshift(row);
  saveSoon();
  return row;
}
