import { format } from 'date-fns';

export function toDate(at: Date | string): Date {
  return at instanceof Date ? at : new Date(at);
}

/** "2:14 PM" */
export function formatTimelineTime(date: Date): string {
  return format(date, 'h:mm a');
}
