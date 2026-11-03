import { RECRUIT_PROGRESS, type RecruitCandidate, type RecruitProgress } from '@neway/shared';

/** What the status menu offers from where a candidate is now (shared by the candidate page and the list). */
export type StatusAction =
  | 'no-answer'
  | 'contacted'
  | 'prequalify'
  | 'consent'
  | 'link'
  | 'safety'
  | 'review'
  | 'onboarding'
  | 'hire'
  | 'close-lead'
  | 'close-case';

export interface StatusRow {
  progress: RecruitProgress;
  enabled: boolean;
  hint: string;
  action?: StatusAction;
  label?: string;
}

const ORDER: readonly RecruitProgress[] = RECRUIT_PROGRESS.filter((p) => p !== 'closed');

/**
 * What each step on the badge's menu would honestly do from where the candidate is now (the
 * journey, owner brief 2026-10-11). A row is enabled only when it is a real transition an existing,
 * audited service performs; the others say why not. Nothing here writes a stored state directly —
 * steps the driver or Safety completes are read from their records.
 */
export function statusRows(c: RecruitCandidate, canDropCase: boolean): StatusRow[] {
  const at = c.progress;
  const j = c.journeyState;
  const before = (p: RecruitProgress) => ORDER.indexOf(at) < ORDER.indexOf(p);
  const rows: StatusRow[] = ORDER.map((p) => ({ progress: p, enabled: false, hint: before(p) ? '' : at === p ? 'Current step' : 'Done' }));
  const row = (p: RecruitProgress) => rows.find((r) => r.progress === p) as StatusRow;
  const leadOnly = Boolean(c.leadId && !c.caseId);
  const open = at !== 'hired' && at !== 'closed';

  row('new').hint = at === 'new' ? 'Current step' : 'Where every lead starts';
  if ((at === 'new' || at === 'no_answer') && leadOnly) {
    Object.assign(row('no_answer'), { enabled: true, action: 'no-answer', hint: at === 'no_answer' ? 'Called again — still no answer' : 'Called, nobody answered' });
    Object.assign(row('contacted'), { enabled: true, action: 'contacted', hint: 'Records the first contact' });
  } else if (before('no_answer')) row('no_answer').hint = 'If a call goes unanswered';
  if ((at === 'new' || at === 'no_answer' || at === 'contacted') && leadOnly && !c.lead?.prequalified) {
    Object.assign(row('prequalified'), { enabled: true, action: 'prequalify', label: 'Prequalified · Record answers…', hint: 'Optional: record the prequalification answers' });
  }
  if (open && j.consent !== 'received' && before('consent_received')) {
    Object.assign(row('consent_sent'), { enabled: true, action: 'consent', hint: j.consent === 'sent' ? 'Resend or copy the consent link' : 'Makes the consent link' });
  }
  if (before('consent_received')) row('consent_received').hint = 'Set when the driver signs';
  if (at === 'consent_received') Object.assign(row('safety_review'), { enabled: true, action: 'safety', hint: 'Send to Safety' });
  else if (before('safety_review')) row('safety_review').hint = 'After the consent is signed';
  if (before('application_sent')) {
    Object.assign(
      row('application_sent'),
      j.safety === 'approved' || !j.consentFirst ? { enabled: open, action: 'link', hint: 'Sends the application link' } : { hint: 'After Safety approves' },
    );
  } else if (at === 'application_sent') Object.assign(row('application_sent'), { enabled: true, action: 'link', hint: 'Resend or copy the application link' });
  if (before('application_received')) row('application_received').hint = 'Set when the driver submits';
  if (at === 'application_received') {
    Object.assign(
      row('onboarding'),
      j.applicationReviewed ? { enabled: true, action: 'onboarding', hint: 'Start onboarding' } : { enabled: true, action: 'review', label: 'Onboarding · Review the application first', hint: 'Opens the application' },
    );
  } else if (before('onboarding')) row('onboarding').hint = 'After the application is reviewed';
  if (before('ready_to_hire')) row('ready_to_hire').hint = 'Read from the Ready-to-hire checklist';
  if (at !== 'hired') {
    Object.assign(
      row('hired'),
      at === 'ready_to_hire' ? { enabled: true, action: 'hire', hint: 'Opens Hire driver' } : { hint: 'When every prerequisite is met' },
    );
  }
  const closed: StatusRow =
    at === 'closed'
      ? { progress: 'closed', enabled: false, hint: 'Current step' }
      : leadOnly && c.lead?.status !== 'dead'
        ? { progress: 'closed', enabled: true, action: 'close-lead', label: 'Closed · Disqualify…', hint: 'Needs a reason; kept and audited' }
        : canDropCase
          ? { progress: 'closed', enabled: true, action: 'close-case', label: 'Closed · Withdraw…', hint: 'Needs a reason; kept and audited' }
          : { progress: 'closed', enabled: false, hint: at === 'hired' ? 'A hired driver leaves through the roster' : 'Safety declines in the Safety review' };
  return [...rows, closed];
}
