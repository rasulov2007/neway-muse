/**
 * Corrective actions.
 *
 * A corrective action is **not a new record type**. It is a task in the safety department bound to
 * the thing that caused it — a defect, a violation or an accident — and it uses the same `tasks`
 * table, the same assignee, the same priority and the same four stored statuses as every other task
 * in the system. Building a second task system here would give a safety manager two inboxes and
 * the carrier two answers to "what is outstanding".
 *
 * The lifecycle a safety manager talks about has six words where the stored model has four. The
 * two extra — `assigned` and `overdue` — are facts already present in the row (is there an
 * assignee; is the due date past), so they are derived rather than stored. A stored `overdue` is a
 * value that is wrong every night at midnight until something writes to it.
 */

/** `tasks.status`. */
export const TASK_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CORRECTIVE_ACTION_STATES = [
  'open',
  'assigned',
  'in_progress',
  'overdue',
  'completed',
  'cancelled',
] as const;
export type CorrectiveActionState = (typeof CORRECTIVE_ACTION_STATES)[number];

/** What a corrective action can be raised against. */
export const CORRECTIVE_ACTION_SUBJECTS = [
  'inspection',
  'defect',
  'violation',
  'accident',
  'driver',
  'truck',
] as const;
export type CorrectiveActionSubject = (typeof CORRECTIVE_ACTION_SUBJECTS)[number];

export interface CorrectiveActionInput {
  status: TaskStatus;
  /** Who owns it. Null means nobody does yet, which is a state worth showing. */
  assigneeId: string | null;
  dueAt: string;
  completedAt?: string | null;
}

export interface CorrectiveActionStateResult {
  state: CorrectiveActionState;
  /** True when someone still has to do something. */
  outstanding: boolean;
  /** Whole days past due; negative when still in hand. Null once completed or cancelled. */
  daysLate: number | null;
  reasons: string[];
}

const MS_PER_DAY = 86_400_000;

export function correctiveActionState(
  input: CorrectiveActionInput,
  nowIso: string,
): CorrectiveActionStateResult {
  if (input.status === 'cancelled') {
    return { state: 'cancelled', outstanding: false, daysLate: null, reasons: ['Cancelled'] };
  }
  if (input.status === 'completed') {
    return {
      state: 'completed',
      outstanding: false,
      daysLate: null,
      reasons: input.completedAt ? [`Completed ${input.completedAt.slice(0, 10)}`] : ['Completed'],
    };
  }

  const now = Date.parse(nowIso);
  const due = Date.parse(input.dueAt);
  const daysLate = Number.isNaN(due) ? null : Math.floor((now - due) / MS_PER_DAY);

  if (daysLate !== null && daysLate > 0) {
    return {
      state: 'overdue',
      outstanding: true,
      daysLate,
      reasons: [
        `${daysLate} day${daysLate === 1 ? '' : 's'} past its due date`,
        input.assigneeId ? 'Assigned' : 'Nobody is assigned to it',
      ],
    };
  }

  if (input.status === 'in_progress') {
    return { state: 'in_progress', outstanding: true, daysLate, reasons: ['Under way'] };
  }

  if (input.assigneeId) {
    return {
      state: 'assigned',
      outstanding: true,
      daysLate,
      reasons: ['Assigned and not yet started'],
    };
  }

  return {
    state: 'open',
    outstanding: true,
    daysLate,
    reasons: ['Raised, with nobody assigned to it yet'],
  };
}

export const CORRECTIVE_ACTION_ORDER: readonly CorrectiveActionState[] = [
  'overdue',
  'open',
  'assigned',
  'in_progress',
  'completed',
  'cancelled',
];

export function correctiveActionRank(state: CorrectiveActionState): number {
  const index = CORRECTIVE_ACTION_ORDER.indexOf(state);
  return index === -1 ? CORRECTIVE_ACTION_ORDER.length : index;
}

/**
 * How long a corrective action gets, by how bad the thing that caused it is.
 *
 * These are working defaults a carrier would set in policy, not regulation. They exist so that a
 * "Create corrective action" button can propose a due date instead of making someone invent one,
 * and every one of them is editable before it is saved.
 */
export const DEFAULT_DUE_DAYS: Record<string, number> = {
  critical: 1,
  high: 7,
  medium: 14,
  low: 30,
};

export function proposeDueDate(severity: string, today: string): string {
  const days = DEFAULT_DUE_DAYS[severity] ?? 14;
  const base = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  const due = new Date(base + days * MS_PER_DAY);
  return due.toISOString().slice(0, 10);
}
