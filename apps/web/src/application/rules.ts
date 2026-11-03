import {
  dotAppMissing,
  dotAppVisibleSteps,
  type DotAppAnswers,
  type DotAppConsentLink,
  type DotAppContext,
  type DotAppMissingItem,
  type DotAppStepId,
} from '@neway/shared';
import { shortId } from './paths';

/**
 * Step navigation rules for the driver page. What is "still needed" is the shared rule
 * (`dotAppMissing`), the same one the server applies on Submit; this file only decides which of
 * those items stop Continue on a step, and where a returning driver lands.
 */

/**
 * Answers that sit inside a legal document's card (their question wording is the document's own).
 * While that document awaits the company's approved version the card shows only the "Awaiting"
 * note, so these fields are not shown and cannot stop Continue (Submit still lists the document).
 */
export const DOC_FIELD_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  violations_cert: ['cov.'],
  prev_da: ['prevda.'],
  onduty: ['onduty.'],
  other_work: ['otherwork.'],
};

export interface RuleInputs {
  today: string;
  signatures: Iterable<string>;
  uploads: Iterable<string>;
  approvedDocs: Iterable<string>;
  consentLinks: Iterable<DotAppConsentLink>;
  ssnOnFile: boolean;
  bankOnFile?: boolean;
  templateContent?: DotAppContext['templateContent'];
}

export function ruleContext(i: RuleInputs): DotAppContext {
  return {
    today: i.today,
    signatures: new Set(i.signatures),
    uploads: new Set(i.uploads),
    approvedDocs: new Set(i.approvedDocs),
    consentLinks: new Set(i.consentLinks),
    ssnOnFile: i.ssnOnFile,
    bankOnFile: Boolean(i.bankOnFile),
    ...(i.templateContent ? { templateContent: i.templateContent } : {}),
  };
}

export function allMissing(a: DotAppAnswers, ctx: DotAppContext): DotAppMissingItem[] {
  return dotAppMissing(a, ctx);
}

/** The items that stop Continue on one step (awaiting documents never do: the driver cannot fix them). */
export function stepErrors(step: DotAppStepId, missing: readonly DotAppMissingItem[], awaiting: ReadonlySet<string>): DotAppMissingItem[] {
  const hidden = [...awaiting].flatMap((k) => DOC_FIELD_PREFIXES[k] ?? []);
  return missing.filter((m) => m.step === step && m.kind !== 'document' && !hidden.some((p) => m.key.startsWith(p)));
}

export function stepComplete(step: DotAppStepId, missing: readonly DotAppMissingItem[], awaiting: ReadonlySet<string>): boolean {
  return stepErrors(step, missing, awaiting).length === 0;
}

/**
 * Where the page opens. A fresh application starts at step 1. A returning driver lands on the first
 * step that still needs something (every step before it is complete, so it can be revisited). A
 * change request opens the first section Safety asked about, with every step reachable.
 */
export function initialPosition(
  steps: readonly DotAppStepId[],
  missing: readonly DotAppMissingItem[],
  awaiting: ReadonlySet<string>,
  changeSections: readonly DotAppStepId[] | null,
): { step: number; maxStep: number } {
  const last = steps.length - 1;
  if (changeSections && changeSections.length) {
    const i = steps.findIndex((s) => changeSections.includes(s));
    return { step: i >= 0 ? i : 0, maxStep: last };
  }
  const firstOpen = steps.findIndex((s) => s !== 'review' && !stepComplete(s, missing, awaiting));
  const at = firstOpen < 0 ? last : firstOpen;
  return { step: at, maxStep: at };
}

/** The steps shown for these answers (Contractor forms only for contractor positions). */
export function visibleSteps(a: DotAppAnswers): DotAppStepId[] {
  return dotAppVisibleSteps(a);
}

/** Keep the current step on the same section when the visible list changes (e.g. position changed). */
export function reindex(prev: readonly DotAppStepId[], next: readonly DotAppStepId[], index: number): number {
  const id = prev[index];
  const i = id ? next.indexOf(id) : -1;
  if (i >= 0) return i;
  return Math.min(index, next.length - 1);
}

/** The step list may jump only to a step already reached. */
export function canJump(i: number, maxStep: number): boolean {
  return i >= 0 && i <= maxStep;
}

/** Continue: move on only when the step has nothing left (prototype goNext). */
export function continueFrom(
  index: number,
  maxStep: number,
  errors: readonly DotAppMissingItem[],
  total: number,
): { step: number; maxStep: number; blocked: boolean } {
  if (errors.length) return { step: index, maxStep, blocked: true };
  const step = Math.min(index + 1, total - 1);
  return { step, maxStep: Math.max(maxStep, step), blocked: false };
}

export function attentionToast(n: number): string {
  return `${n} item${n > 1 ? 's' : ''} need${n > 1 ? '' : 's'} attention`;
}

/** YYYY-MM-DD plus n days. */
function plusDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * First open: a first employer and license row, every employer and trucking school with its stable
 * id, and the single Clearinghouse query period prefilled (today → today + 30 days, editable).
 */
export function withDefaults(a: DotAppAnswers, today?: string): { answers: DotAppAnswers; changed: boolean } {
  let out = { ...a };
  let changed = false;
  if (!out.employers?.length) out = { ...out, employers: [{ id: shortId(), address: { country: 'United States' } }] };
  else if (out.employers.some((e) => !e.id)) {
    out = { ...out, employers: out.employers.map((e) => (e.id ? e : { ...e, id: shortId() })) };
    changed = true;
  }
  if (out.schools?.some((s) => !s.id)) {
    out = { ...out, schools: out.schools.map((s) => (s.id ? s : { ...s, id: shortId() })) };
    changed = true;
  }
  if (today && !out.chs?.from && !out.chs?.to) {
    out = { ...out, chs: { from: today, to: plusDays(today, 30) } };
    changed = true;
  }
  if (!out.licenses?.length) out = { ...out, licenses: [{ country: 'United States', cls: 'Class A', current: 'Yes', cdl: 'Yes' }] };
  return { answers: out, changed };
}
