import { z } from 'zod';

/**
 * Flagging a load (rule 1.10): "this one needs a person".
 *
 * A flag names what kind of trouble it is and says it in a sentence. It stays open - on the
 * Loads list, the Daily Board and in Notifications - until somebody closes it with a note
 * saying what was done. The kinds are for sorting, not for workflow: none of them changes the
 * load's status or blocks anything.
 */
export const LOAD_PROBLEM_KINDS = ['late', 'breakdown', 'paperwork', 'broker', 'driver', 'damage', 'other'] as const;
export type LoadProblemKind = (typeof LOAD_PROBLEM_KINDS)[number];

export const LOAD_PROBLEM_KIND_LABELS: Record<LoadProblemKind, string> = {
  late: 'Running late',
  breakdown: 'Breakdown',
  paperwork: 'Paperwork',
  broker: 'Broker issue',
  driver: 'Driver issue',
  damage: 'Damage or claim',
  other: 'Other',
};

export const FlagLoadSchema = z.object({
  kind: z.enum(LOAD_PROBLEM_KINDS),
  note: z.string().trim().min(3, 'Say what the problem is').max(1000),
});
export type FlagLoadInput = z.infer<typeof FlagLoadSchema>;

export const CloseLoadProblemSchema = z.object({
  note: z.string().trim().min(3, 'Say what was done').max(1000),
});
export type CloseLoadProblemInput = z.infer<typeof CloseLoadProblemSchema>;

export interface LoadProblem {
  id: string;
  loadId: string;
  loadNumber: string;
  kind: LoadProblemKind;
  note: string;
  openedById: string;
  openedByName: string;
  openedAt: string;
  closedById: string | null;
  closedByName: string | null;
  closedAt: string | null;
  closeNote: string | null;
}

/** The open flags among a list, newest first. */
export function openProblems(problems: readonly LoadProblem[]): LoadProblem[] {
  return problems.filter((p) => !p.closedAt).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}
