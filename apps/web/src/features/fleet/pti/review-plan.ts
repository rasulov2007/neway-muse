import {
  DEFECT_DUE_HOURS,
  PTI_DEFECT_SEVERITY_LABEL,
  defectDueAt,
  describeDescriptionProblem,
  isTelegramMessageUrl,
  screenshotRequired,
  type DefectDisposition,
  type OpenDefectDisposition,
  type PtiDefect,
  type PtiDefectSeverity,
  type PtiInspection,
  type PtiReviewResult,
  type Screenshot,
} from '@neway/shared';
import type { ComponentCondition, PtiComponentDef, PtiRating, RatingEntry } from '@/demo';
import { formatDate, formatIsoDate } from '@/lib/format';

/**
 * What the review drawer is about to do, worked out before the click (§6.2 "On save").
 *
 * The drawer keeps a draft; this module turns the draft into (a) the problems that stop it
 * saving, in the reviewer's words, and (b) every side effect the save would have, named. The
 * rules are the server's - a description has to be one, a screenshot from `replace_now`, every
 * open defect dispositioned before a clean review - repeated here only so the footer can say so
 * before the round trip, never instead of it.
 */

export type NextAction = 'assign' | 'work_order' | 'yard' | 'already_fixed';

export const NEXT_ACTION_LABEL: Record<NextAction, string> = {
  assign: 'Assign only',
  work_order: 'Open a work order',
  yard: 'Schedule at the yard',
  already_fixed: 'Already fixed',
};

export interface Assignee {
  id: string;
  name: string;
  roles: string[];
}

export interface IssueDraft {
  /** Local, for React keys and collapse state. */
  key: string;
  /** Catalog key; null until chosen. */
  component: string | null;
  description: string;
  quickPick: string | null;
  severity: PtiDefectSeverity;
  clipTime: string;
  screenshots: Screenshot[];
  ownerId: string | null;
  ownerName: string | null;
  /** True once the reviewer chose the owner by hand; the routing rule stops touching it. */
  ownerEdited: boolean;
  nextAction: NextAction;
  vendorName: string;
  /** ISO datetime; null means "derive from severity". */
  dueAt: string | null;
  dueEdited: boolean;
}

export interface SourceDraft {
  messageUrl: string;
  chatTitle: string;
  senderName: string;
}

export interface ReviewDraft {
  result: PtiReviewResult | null;
  dispositions: Record<string, DefectDisposition>;
  issues: IssueDraft[];
  /** STEP 4 / "Mark all Good": every component not covered by an issue or an explicit rating. */
  othersGood: boolean;
  /** Explicit per-component ratings from the expanded list, by catalog id. */
  ratings: Record<string, PtiRating>;
  /** The Telegram source, when the inspection has none yet. */
  source: SourceDraft;
}

export interface ReviewContext {
  inspection: PtiInspection;
  openDefects: PtiDefect[];
  /** Active catalog entries, keys present, in catalog order. */
  components: PtiComponentDef[];
  conditions: ComponentCondition[];
  assignees: Assignee[];
  reviewerName: string;
  now: Date;
}

export interface ReviewPlan {
  problems: string[];
  canSave: boolean;
  effects: string[];
  /** The defects the review creates, in the server's shape. */
  defects: {
    component: string;
    description: string;
    quickPick: string | null;
    severity: PtiDefectSeverity;
    evidence: { clipTime: string | null; screenshots: Screenshot[] };
    ownerId: string | null;
    dueAt: string | null;
    /** Carried beside the defect for the drawer's follow-up writes; not a server field. */
    nextAction: NextAction;
    vendorName: string;
  }[];
  dispositions: OpenDefectDisposition[];
  ratings: RatingEntry[];
  /** The receipt the save records first, when the inspection had none. */
  receipt: SourceDraft | null;
  /** True when a hold or a restriction is placed, so dispatch is told. */
  notifiesDispatch: boolean;
}

/** The roles that make somebody "the shop" for the routing rule. */
const SHOP_ROLES = ['maintenance', 'fleet_manager'];

/** Ratings the issue card writes for its component, from the severity. */
export function ratingForSeverity(severity: PtiDefectSeverity): PtiRating {
  switch (severity) {
    case 'oos_risk':
    case 'replace_now':
      return 'replace_now';
    case 'replace_soon':
      return 'replace_soon';
    default:
      return 'monitor';
  }
}

/** The severity an explicit rating implies when it flips the result to Issue found. */
export function severityForRating(rating: PtiRating): PtiDefectSeverity | null {
  switch (rating) {
    case 'replace_now':
      return 'replace_now';
    case 'replace_soon':
      return 'replace_soon';
    default:
      return null;
  }
}

/** The default window a Replace soon rating gets when the reviewer did not say. */
export const DEFAULT_REPLACE_SOON_WEEKS = 2;

/**
 * §6.3's routing rule: oos_risk and replace_now go to the shop, the rest to the unit's
 * dispatcher. Null when nobody fits, which leaves the field for the reviewer.
 */
export function routeOwner(severity: PtiDefectSeverity, ctx: Pick<ReviewContext, 'assignees' | 'inspection'>): Assignee | null {
  if (severity === 'oos_risk' || severity === 'replace_now') {
    return ctx.assignees.find((a) => a.roles.some((r) => SHOP_ROLES.includes(r))) ?? null;
  }
  const dispatcher = ctx.inspection.dispatcherId ? ctx.assignees.find((a) => a.id === ctx.inspection.dispatcherId) : null;
  return dispatcher ?? null;
}

let issueSequence = 0;

/** A fresh issue card with every default filled in (§6.3). */
export function newIssue(component: string | null, ctx: ReviewContext, severity: PtiDefectSeverity = 'monitor'): IssueDraft {
  const owner = routeOwner(severity, ctx);
  issueSequence += 1;
  return {
    key: `issue_${issueSequence}`,
    component,
    description: '',
    quickPick: null,
    severity,
    clipTime: '',
    screenshots: [],
    ownerId: owner?.id ?? null,
    ownerName: owner?.name ?? null,
    ownerEdited: false,
    nextAction: 'assign',
    vendorName: '',
    dueAt: null,
    dueEdited: false,
  };
}

/** Severity changed: the owner and the due date follow unless the reviewer set them by hand. */
export function withSeverity(issue: IssueDraft, severity: PtiDefectSeverity, ctx: ReviewContext): IssueDraft {
  const owner = issue.ownerEdited ? null : routeOwner(severity, ctx);
  return {
    ...issue,
    severity,
    ownerId: issue.ownerEdited ? issue.ownerId : (owner?.id ?? null),
    ownerName: issue.ownerEdited ? issue.ownerName : (owner?.name ?? null),
    dueAt: issue.dueEdited ? issue.dueAt : null,
  };
}

export function emptyDraft(): ReviewDraft {
  return {
    result: null,
    dispositions: {},
    issues: [],
    othersGood: false,
    ratings: {},
    source: { messageUrl: '', chatTitle: '', senderName: '' },
  };
}

/** "+48 h" / "same day" / "+14 days": what a severity implies, beside the control. */
export function dueOffsetLabel(severity: PtiDefectSeverity): string {
  const hours = DEFECT_DUE_HOURS[severity];
  if (hours === 0) return 'same day';
  if (hours < 72) return `+${hours} h`;
  return `+${hours / 24} days`;
}

export function effectiveDueAt(issue: IssueDraft, now: Date): string {
  return issue.dueAt ?? defectDueAt(issue.severity, now).toISOString();
}

/** "was Good · Aug 24" for the component field, or null when never rated. */
export function previousRatingLabel(componentId: string, conditions: ComponentCondition[], labels: Record<PtiRating, string>): string | null {
  const condition = conditions.find((c) => c.component.id === componentId);
  if (!condition?.rating || !condition.source) return null;
  return `was ${labels[condition.rating]} · ${formatIsoDate(condition.source.ratedAt.slice(0, 10))}`;
}

function received(inspection: PtiInspection): boolean {
  return inspection.receivedAt !== null;
}

export function planReview(draft: ReviewDraft, ctx: ReviewContext): ReviewPlan {
  const problems: string[] = [];
  const effects: string[] = [];
  const byKey = new Map(ctx.components.map((c) => [c.key ?? '', c]));
  const unit = ctx.inspection.unitNumber;

  // -- receipt
  let receipt: SourceDraft | null = null;
  if (!received(ctx.inspection)) {
    // The link is where the video is; welcome but not demanded — the owner's 2026-09-21 form marks
    // a video Received with a date and nothing else.
    const url = draft.source.messageUrl.trim();
    if (url && !isTelegramMessageUrl(url)) problems.push('The source has to be a t.me message link');
    else {
      receipt = { messageUrl: url, chatTitle: url ? draft.source.chatTitle.trim() || 'Telegram' : '', senderName: draft.source.senderName.trim() };
      effects.push(url ? `Marks the video received from ${receipt.chatTitle}${receipt.senderName ? ` (${receipt.senderName})` : ''}` : 'Marks the video received');
    }
  }

  // -- result
  if (draft.result === null) problems.push('Choose No issues or Issue found');
  // WP7: a clean result cannot sit beside a component rated Replace soon or worse. The drawer
  // flips the result and opens a card when that rating is made; this is the rule behind it.
  if (draft.result === 'no_issues') {
    const contradicting = Object.entries(draft.ratings).filter(([, rating]) => severityForRating(rating) !== null);
    for (const [componentId] of contradicting) {
      const component = ctx.components.find((c) => c.id === componentId);
      problems.push(`${component?.name ?? componentId} is rated for replacement; this is an issue, not a clean review`);
    }
  }

  // -- dispositions (both paths: an open defect is answered whatever the video showed)
  const dispositions: OpenDefectDisposition[] = [];
  for (const defect of ctx.openDefects) {
    const seen = draft.dispositions[defect.id];
    if (!seen) {
      if (draft.result === 'no_issues') problems.push(`Say what this video showed for ${defect.defectNumber}`);
      continue;
    }
    dispositions.push({ defectId: defect.id, seen });
    effects.push(
      seen === 'looks_fixed'
        ? `${defect.defectNumber}: looks fixed — proposed for verification; the hold stays until safety verifies`
        : seen === 'still_present'
          ? `${defect.defectNumber}: still present — stays open`
          : `${defect.defectNumber}: not visible in this video — stays open`,
    );
  }

  // -- issues
  const defects: ReviewPlan['defects'] = [];
  let notifiesDispatch = false;
  if (draft.result === 'issues_found') {
    if (draft.issues.length === 0) problems.push('Add at least one issue, or choose No issues');
    draft.issues.forEach((issue, index) => {
      const label = `Issue ${index + 1}`;
      const component = issue.component ? byKey.get(issue.component) : undefined;
      if (!component) {
        problems.push(`${label}: choose the component`);
        return;
      }
      const description = issue.description.trim();
      const descriptionProblem = describeDescriptionProblem(description);
      if (descriptionProblem) problems.push(`${label} (${component.name}): ${descriptionProblem}`);
      if (screenshotRequired(issue.severity) && issue.screenshots.length === 0) {
        problems.push(`${label} (${component.name}): needs a screenshot from the video at ${PTI_DEFECT_SEVERITY_LABEL[issue.severity].toLowerCase()}`);
      }
      const dueAt = effectiveDueAt(issue, ctx.now);
      defects.push({
        component: component.key ?? issue.component ?? '',
        description,
        quickPick: issue.quickPick,
        severity: issue.severity,
        evidence: { clipTime: issue.clipTime.trim() || null, screenshots: issue.screenshots },
        ownerId: issue.ownerId,
        dueAt,
        nextAction: issue.nextAction,
        vendorName: issue.vendorName.trim(),
      });
      const parts = [
        `Creates a defect on ${component.name} (${PTI_DEFECT_SEVERITY_LABEL[issue.severity].toLowerCase()})`,
        `due ${formatDate(dueAt)}`,
        issue.ownerName ? `owner ${issue.ownerName}` : 'no owner yet',
      ];
      if (issue.nextAction === 'work_order') parts.push(`opens a work order${issue.vendorName.trim() ? ` at ${issue.vendorName.trim()}` : ''}`);
      if (issue.nextAction === 'yard') parts.push('scheduled at the yard');
      if (issue.nextAction === 'already_fixed') parts.push('marked fixed — proposed for verification, not released');
      effects.push(parts.join(' · '));
      if (issue.severity === 'oos_risk') {
        effects.push(`Puts unit ${unit} out of service — dispatch is blocked until the defect is verified`);
        notifiesDispatch = true;
      } else if (issue.severity === 'replace_now') {
        effects.push(`Restricts unit ${unit} until the defect is verified`);
        notifiesDispatch = true;
      }
    });
  }

  // -- ratings: a component is rated once, by the first rule that names it
  const ratings: RatingEntry[] = [];
  const rated = new Set<string>();
  const summary: string[] = [];
  for (const defect of defects) {
    const component = byKey.get(defect.component);
    if (!component || rated.has(component.id)) continue;
    rated.add(component.id);
    const rating = ratingForSeverity(defect.severity);
    ratings.push(ratingEntry(component.id, rating));
    summary.push(`${component.name} → ${RATING_WORD[rating]}`);
  }
  for (const [componentId, rating] of Object.entries(draft.ratings)) {
    const component = ctx.components.find((c) => c.id === componentId);
    if (!component || rated.has(component.id)) continue;
    rated.add(component.id);
    ratings.push(ratingEntry(component.id, rating));
    summary.push(`${component.name} → ${RATING_WORD[rating]}`);
  }
  if (draft.othersGood) {
    const others = ctx.components.filter((c) => !rated.has(c.id));
    for (const component of others) {
      rated.add(component.id);
      ratings.push(ratingEntry(component.id, 'good'));
    }
    if (others.length > 0) summary.push(`${others.length} other${others.length === 1 ? '' : 's'} → Good`);
  }
  effects.push(ratings.length === 0 ? 'Leaves every component rating untouched, with its original date' : `Rates ${ratings.length} component${ratings.length === 1 ? '' : 's'}: ${summary.join(', ')}`);

  if (notifiesDispatch) {
    effects.push(`Notifies dispatch${ctx.inspection.dispatcherName ? ` (${ctx.inspection.dispatcherName})` : ''}`);
  }
  effects.push(`Records the review under ${ctx.reviewerName}, checked ${formatDate(ctx.now)}`);

  return { problems, canSave: problems.length === 0, effects, defects, dispositions, ratings, receipt, notifiesDispatch };
}

const RATING_WORD: Record<PtiRating, string> = {
  good: 'Good',
  monitor: 'Monitor',
  replace_soon: 'Replace soon',
  replace_now: 'Replace now',
};

function ratingEntry(componentId: string, rating: PtiRating): RatingEntry {
  return {
    componentId,
    rating,
    windowValue: rating === 'replace_soon' ? DEFAULT_REPLACE_SOON_WEEKS : null,
    windowUnit: rating === 'replace_soon' ? 'weeks' : null,
  };
}
