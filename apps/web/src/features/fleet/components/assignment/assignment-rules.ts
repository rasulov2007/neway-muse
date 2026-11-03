import { formatIsoDate } from '@/lib/format';

/**
 * The date rules the assignment dialogs check before sending (the server checks the same and is
 * the one that decides). Dates are `YYYY-MM-DD`; `today` is the company's (US Eastern) today.
 */

/** Why an assigned date cannot be used, or null. */
export function assignedDateProblem(assignedOn: string, today: string): string | null {
  if (!assignedOn) return 'Pick the assigned date.';
  if (assignedOn > today) return 'The assigned date cannot be in the future.';
  return null;
}

/**
 * Why a drop date cannot be used, or null: not before the driver's assigned date, not in the
 * future and — when somebody else takes the unit — not after the new driver's assigned date.
 */
export function dropDateProblem(
  endedOn: string,
  assignedOn: string,
  today: string,
  takenOverOn?: string,
): string | null {
  if (!endedOn) return 'Pick the drop date.';
  if (endedOn < assignedOn) return `The drop date cannot be before ${formatIsoDate(assignedOn)}, the day this driver took the unit.`;
  if (endedOn > today) return 'The drop date cannot be in the future.';
  if (takenOverOn && endedOn > takenOverOn) {
    return 'The unit cannot come back after the new driver took it.';
  }
  return null;
}
