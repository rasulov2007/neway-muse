// Quick accident report (SPEC §1.3, §7.10) — the live-check probe and the "Do now" prompts that become tasks on
// submit. Ported from docs/accidents/prototype/src/screens/Report.tsx (`probe`, `prompts`) and store.tsx
// (`opSaveReport`: the standard tasks). P0 deferred this to P1 (IMPLEMENTATION-PLAN §11 deviation 10).
// The server recomputes the prompts from the stored facts on submit; the client's list is only a preview and its
// create/done choices are matched by `key`.
import { dotRecordable, suggestedSeverity, testing, type RuleOptions } from './rules.js';
import { resolveSettings } from './settings.js';
import { HOUR, fmtDate, fmtTime, rulesNow } from './time.js';
import type { AccidentCase, CargoState, Dept, Severity, Tri } from './types.js';

/** The facts the report form collects (everything optional except the zone; null/undefined = not answered). */
export interface ReportFacts {
  occurredAt?: string | null;
  tz: string;
  publicRoad?: Tri;
  city?: string | null;
  state?: string | null;
  injuries?: Tri;
  treatedAway?: number | null;
  fatalities?: number | null;
  ourDriverInjured?: Tri;
  towAway?: Tri;
  truckCondition?: 'drivable' | 'not_drivable' | 'unknown';
  cargo?: CargoState['status'];
  hazmat?: Tri;
  police?: Tri;
  citation?: Tri;
  citationAt?: string | null;
  excludedOccurrence?: AccidentCase['excludedOccurrence'] | null;
  initialEstimateCents?: number | null;
  loadId?: string | null;
  /** Broker or customer named in the Dispatch prompt ("Notify Lakeshore Freight Brokerage …"). */
  loadParty?: string | null;
  testing?: AccidentCase['testing'];
}

export const PROMPT_KEYS = ['ems', 'hazmat', 'test', 'tow', 'load', 'cargo', 'video', 'statement', 'police', 'insurer'] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];

export interface ReportPrompt {
  key: PromptKey;
  label: string;
  why: string;
  dept: Dept;
  /** Hours from now until the task is due. */
  dueInHours: number;
  tone?: 'urgent';
}

/** A minimal case built from the report facts, for the live check (same functions as the server). */
export function reportProbe(f: ReportFacts, now?: number): AccidentCase {
  const nowIso = new Date(rulesNow(now)).toISOString();
  const injuries = f.injuries ?? null;
  return {
    id: 'probe',
    number: 'PROBE',
    stage: 'draft',
    createdAt: nowIso,
    createdBy: '',
    updatedAt: nowIso,
    version: 1,
    isTest: false,
    occurredAt: f.occurredAt || nowIso,
    tz: f.tz,
    timeProvenance: 'driver',
    location: { city: f.city ?? '', state: f.state ?? '', publicRoad: f.publicRoad ?? null },
    locationProvenance: 'driver',
    type: 'Other',
    description: '',
    descriptionProvenance: 'driver',
    severity: 'minor',
    injuries: {
      status: injuries,
      // When injuries = no both counts are 0 (SPEC §7.1); otherwise blank stays unknown.
      treatedAway: injuries === 'no' ? 0 : (f.treatedAway ?? null),
      fatalities: injuries === 'no' ? 0 : (f.fatalities ?? null),
      ourDriver: f.ourDriverInjured ?? null,
      provenance: 'driver',
    },
    towAway: f.towAway ?? null,
    towProvenance: 'driver',
    citation: { status: f.citation ?? null, ...(f.citationAt ? { issuedAt: f.citationAt } : {}) },
    hazmat: f.hazmat ?? null,
    ...(f.excludedOccurrence ? { excludedOccurrence: f.excludedOccurrence } : {}),
    police: { responded: f.police ?? null },
    conditions: {},
    vehicles: [],
    witnesses: [],
    equipment: { truck: { condition: f.truckCondition ?? 'unknown', status: 'at_scene', damage: '' } },
    cargo: { status: f.cargo ?? 'unknown' },
    immediate: [],
    investigation: { status: 'not_started', facts: [], questions: [], statements: [], checklist: [], factors: [] },
    determinations: {
      fault: { value: 'not_determined' },
      preventability: { value: 'not_determined' },
      cpdp: { value: 'not_applicable' },
      legal: { value: 'unknown' },
    },
    correctiveActions: [],
    testing: f.testing ?? { alcohol: { substance: 'alcohol', decision: 'auto' }, drug: { substance: 'drug', decision: 'auto' } },
    ownerId: '',
    initialEstimateCents: f.initialEstimateCents ?? 0,
  };
}

/** Live check for the report rail (SPEC §1.3 side rail). */
export function reportLiveCheck(f: ReportFacts, opts: RuleOptions = {}) {
  const probe = reportProbe(f, opts.now);
  return { dotRecordable: dotRecordable(probe), testing: testing(probe, opts), suggestedSeverity: suggestedSeverity(probe, opts) };
}

/** SPEC §7.10 — contextual prompts, in the prototype's order. Every one becomes a task on submit unless unticked. */
export function reportPrompts(f: ReportFacts, opts: RuleOptions = {}): ReportPrompt[] {
  const nowMs = rulesNow(opts.now);
  const probe = reportProbe(f, nowMs);
  const tt = testing(probe, { ...opts, now: nowMs });
  const P: ReportPrompt[] = [];
  const injuries = f.injuries ?? null;
  const inj = injuries !== 'no';
  const cond = f.truckCondition ?? 'unknown';
  const cargo = f.cargo ?? 'unknown';
  if (inj)
    P.push({ key: 'ems', label: 'Confirm everyone is safe and EMS was called if needed', why: injuries === 'yes' ? 'Injuries reported' : 'Injury status not confirmed', dept: 'Safety', dueInHours: 0.5, tone: 'urgent' });
  if (f.hazmat === 'yes')
    P.push({ key: 'hazmat', label: 'Hazmat release — confirm notice requirements with the Safety Manager now (49 CFR 171.15)', why: 'Hazmat released', dept: 'Safety', dueInHours: 1, tone: 'urgent' });
  if ([tt.alcohol, tt.drug].some((x) => x.required !== 'no') && f.occurredAt)
    P.push({
      key: 'test',
      label: `Post-accident testing decision — alcohol by ${fmtTime(tt.alcohol.deadline, f.tz)}, drug by ${fmtDate(tt.drug.deadline, f.tz, false)} ${fmtTime(tt.drug.deadline, f.tz)}`,
      why: tt.alcohol.required === 'yes' ? 'Testing required' : 'Depends on injury, tow-away and citation',
      dept: 'Safety',
      dueInHours: Math.max(0.5, (Date.parse(tt.alcohol.promptBy || tt.alcohol.deadline) - nowMs) / HOUR),
      tone: 'urgent',
    });
  if (f.towAway === 'yes' || cond === 'not_drivable')
    P.push({ key: 'tow', label: 'Arrange tow and recovery; record the tow company and destination', why: cond === 'not_drivable' ? 'Truck not drivable' : 'Tow-away', dept: 'Fleet', dueInHours: 2 });
  if (f.loadId && (cond !== 'drivable' || cargo === 'damaged' || cargo === 'unknown'))
    P.push({ key: 'load', label: `Notify ${f.loadParty || 'the customer'} and plan the load (repower / transload)`, why: 'Active load affected', dept: 'Dispatch', dueInHours: 2 });
  if (cargo === 'damaged')
    P.push({ key: 'cargo', label: 'Photograph cargo damage and hold damaged freight — do not dispose', why: 'Cargo damaged', dept: 'Dispatch', dueInHours: 6 });
  if (inj || f.towAway === 'yes')
    P.push({ key: 'video', label: 'Save dashcam video and ECM data before they are overwritten', why: 'Injury or tow-away possible', dept: 'Safety', dueInHours: 4 });
  P.push({ key: 'statement', label: 'Collect the driver’s written statement', why: 'Every case', dept: 'Safety', dueInHours: 24 });
  if (f.police === 'yes')
    P.push({ key: 'police', label: 'Get the police report number and request the report', why: 'Police at the scene', dept: 'Safety', dueInHours: 24 });
  if (f.towAway === 'yes' || injuries === 'yes' || cond === 'not_drivable')
    P.push({ key: 'insurer', label: 'Report to the insurer (first notice of loss)', why: 'Likely claim', dept: 'Claims', dueInHours: 24 });
  return P;
}

/** The tasks every submitted case gets besides the prompts (store.tsx opSaveReport). */
export interface StandardTask {
  title: string;
  dept: Dept;
  dueInHours: number;
  priority: 'normal' | 'high';
  autoRule: string;
}
export const CONFIRM_FACTS_TASK = 'Confirm the facts and assign an investigator';
export const MANAGEMENT_REVIEW_TASK = 'Management review of serious incident';

export function standardTasks(severity: Severity, opts: RuleOptions = {}): StandardTask[] {
  const set = resolveSettings(opts.settings);
  const out: StandardTask[] = [{ title: CONFIRM_FACTS_TASK, dept: 'Safety', dueInHours: 24, priority: 'normal', autoRule: 'Every new case' }];
  if (set.managementReviewSeverities.includes(severity))
    out.push({ title: MANAGEMENT_REVIEW_TASK, dept: 'Management', dueInHours: 72, priority: 'high', autoRule: `Severity: ${severity}` });
  return out;
}

/** Quick-report prompt tasks due within 8 hours are high priority (SPEC §11 shortcut 7). */
export const promptPriority = (dueInHours: number): 'high' | 'normal' => (dueInHours <= 8 ? 'high' : 'normal');

/* ------------------------------------------------------------------ post-accident testing at intake (owner, 2026-10-24) */
/** The question the quick report asks, word for word. */
export const POST_ACCIDENT_TEST_QUESTION = 'Post-accident alcohol and drug test required?';

/** What the person answered on the report. The answer is theirs; the 49 CFR 382.303 rule (`testing`) still runs on the
 *  facts, and a legally required test is never switched off by answering "No". */
export interface PostAccidentIntake {
  required: 'yes' | 'no' | null;
  /** A test record (lab result / custody form) is attached. */
  submitted: boolean;
  /** Required but not submitted: why the test was not done (49 CFR 382.303(d)). */
  notDoneReason?: string | null;
}

/** Shortest reason the report accepts for a required test that was not submitted. */
export const NOT_DONE_REASON_MIN = 5;

/**
 * Field problems with the intake answer (paths as the API reports them). On submit the question must be answered, and a
 * required test that is not submitted needs a reason why it was not done. A draft may leave everything open.
 */
export function postAccidentIntakeIssues(a: PostAccidentIntake | null | undefined, opts: { submit: boolean }): { path: string; message: string }[] {
  if (!opts.submit) return [];
  if (!a || a.required === null) return [{ path: 'postAccidentTest.required', message: `Answer: ${POST_ACCIDENT_TEST_QUESTION}` }];
  if (a.required === 'yes' && !a.submitted && (a.notDoneReason ?? '').trim().length < NOT_DONE_REASON_MIN)
    return [{ path: 'postAccidentTest.notDoneReason', message: 'The test is required but nothing is submitted — record why it was not done' }];
  return [];
}

type RuleAnswer = { required: 'yes' | 'no' | 'pending'; reason: string };

/** The 382.303 hint beside the question: what the facts say, and a conflict flag when "No" meets a required test. */
export function postAccidentIntakeHint(
  rule: { alcohol: RuleAnswer; drug: RuleAnswer },
  answer: 'yes' | 'no' | null,
): { suggested: 'yes' | 'no' | null; text: string; conflict: boolean } {
  const anyYes = rule.alcohol.required === 'yes' || rule.drug.required === 'yes';
  const suggested = anyYes ? 'yes' : rule.alcohol.required === 'no' && rule.drug.required === 'no' ? 'no' : null;
  const reason = anyYes && rule.alcohol.required !== 'yes' ? rule.drug.reason : rule.alcohol.reason;
  const verdict = suggested === 'yes' ? 'required' : suggested === 'no' ? 'not required' : 'not decided yet';
  return { suggested, text: `49 CFR 382.303: ${verdict} — ${reason}`, conflict: suggested === 'yes' && answer === 'no' };
}
