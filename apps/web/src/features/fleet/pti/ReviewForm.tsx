import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  canTransition,
  screenshotRequired,
  type DefectDisposition,
  type PtiBoardRow,
  type PtiDefect,
  type PtiDefectSeverity,
  type PtiInspection,
  type Screenshot,
} from '@neway/shared';
import {
  conditionsFor,
  listPtiComponents,
  rateComponentsForUnit,
  type PtiComponentDef,
} from '@/demo';
import { pushNotification } from '@/demo/notifications-api';
import { ensureRoster } from '@/demo/roster-api';
import { Alert, Badge, Button, DatePicker, Input, Select, cn, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet } from '@/lib/api-client';
import { now as serverNow, today as companyToday } from '@/lib/clock';
import { formatDate, formatIsoDate } from '@/lib/format';
import { weekRangeLabel } from '../pti-week-label';
import {
  ptiKeys,
  uploadScreenshot,
  useLockInspection,
  usePtiUnitHistory,
  useReceiveInspection,
  useReviewInspection,
  useTransitionDefect,
} from './api';
import { statusPill } from './board-view';
import { DriverSubmissionCard } from './DriverSubmissionCard';
import {
  emptyDraft,
  newIssue,
  planReview,
  type Assignee,
  type IssueDraft,
  type ReviewContext,
  type ReviewDraft,
} from './review-plan';

/** What a component gets on the clean path: fine, replace soon, replace now, or nobody looked. */
type Mark = 'good' | 'soon' | 'now' | 'na';
const MARKS: { value: Mark; label: string; aria: string }[] = [
  { value: 'good', label: 'Good', aria: 'Good' },
  { value: 'soon', label: 'Soon', aria: 'Soon' },
  { value: 'now', label: 'Now', aria: 'Now' },
  { value: 'na', label: '—', aria: 'not seen' },
];

/** The urgency words on the issue path, and the severity each one is. */
type Urgency = 'watch' | 'soon' | 'urgent';
const URGENCY: Record<Urgency, { label: string; note: string; severity: PtiDefectSeverity }> = {
  watch: {
    label: 'Watch',
    note: 'Keep an eye on it. Review in 30 days. Truck keeps running.',
    severity: 'monitor',
  },
  soon: {
    label: 'Soon',
    note: 'Fix within 14 days. Truck keeps running.',
    severity: 'replace_soon',
  },
  urgent: {
    label: 'Urgent',
    note: 'Truck goes on hold today until this is confirmed repaired.',
    severity: 'oos_risk',
  },
};
const URGENCY_FOR: Partial<Record<PtiDefectSeverity, Urgency>> = {
  monitor: 'watch',
  replace_soon: 'soon',
  oos_risk: 'urgent',
};

type Disposition = DefectDisposition;
const DISPOSITIONS: { value: Disposition; label: string }[] = [
  { value: 'still_present', label: 'Still there' },
  { value: 'looks_fixed', label: 'Looks fixed' },
  { value: 'not_visible', label: "Couldn't see" },
];

/**
 * The review form, as the owner drew it (2026-09-22): unit, driver, week and reviewer fill in
 * by themselves; No issues or Issue found; on the clean path every component starts at Good and
 * the reviewer taps only what isn't (Soon and Now open a tracked issue, "—" records that nobody
 * looked); on the issue path a component, one line and an urgency add an issue. Save, or Save &
 * next. The rules that decide whether it can be saved are the server's - `planReview` repeats
 * them early so the footer can say so before the round trip.
 */
export function ReviewForm({
  row,
  week,
  onCancel,
  onSavedNext,
  onSaved,
}: {
  row: PtiBoardRow;
  week: string;
  onCancel: () => void;
  onSavedNext: (() => void) | null;
  /** After a save: closing no longer asks "Leave without saving?". */
  onSaved?: () => void;
}) {
  const account = useAccount();
  const reviewer = { id: account?.userId ?? 'unknown', name: account?.name ?? 'Unknown' };
  const canWrite =
    account?.permissions.some((p) => p === 'maintenance.edit' || p === 'safety.manage') ?? false;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const inspection = row.inspection;
  const openDefects = row.openDefects;
  const reviewed = inspection.reviewState === 'reviewed';
  const received = inspection.receivedAt !== null;
  // A saved review can be opened again (owner, 2026-10-19: All good was pressed, but there was an
  // issue). Saving replaces the result; the audit keeps the old one beside the new.
  const [editingSaved, setEditingSaved] = useState(false);
  const locked = (reviewed && !editingSaved) || !canWrite;

  const assignees = useQuery({
    queryKey: ['pti', 'assignees'],
    queryFn: () => apiGet<Assignee[]>('/fleet/pti/assignees'),
  });
  const catalog = useQuery({
    queryKey: ['pti', 'drawer-catalog', inspection.unitId, inspection.weekStart],
    queryFn: async () => {
      await ensureRoster();
      return {
        components: listPtiComponents(),
        conditions: conditionsFor(inspection.unitId, inspection.weekStart),
      };
    },
  });
  const history = usePtiUnitHistory(inspection.unitId);
  const receive = useReceiveInspection();
  const review = useReviewInspection();
  const lock = useLockInspection();
  const transition = useTransitionDefect();

  // A repair the shop proposed as fixed: safety confirms it here, with their name on it.
  const confirmRepair = async (d: PtiDefect) => {
    try {
      await transition.mutateAsync({
        id: d.id,
        version: d.version,
        to: 'verified',
        fixedVia: null,
        note: null,
        reason: null,
        workOrderId: null,
        workOrderNumber: null,
        ownerId: null,
      });
      await queryClient.invalidateQueries({ queryKey: ptiKeys.all });
      toast({ tone: 'success', title: `${d.defectNumber} confirmed repaired and cleared` });
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'Not confirmed',
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  /*
   * Fixed, right here in the drawer (owner, 2026-10-18): the reviewer who sees the issue is gone
   * marks it. Safety's Fixed also clears it; a shop person's waits for safety to confirm.
   */
  const canClear = account?.permissions.some((p) => p === 'safety.manage' || p === 'pti.verify') ?? false;
  const [fixingId, setFixingId] = useState<string | null>(null);
  const markFixed = async (d: PtiDefect) => {
    setFixingId(d.id);
    try {
      const fixed = await transition.mutateAsync({
        id: d.id,
        version: d.version,
        to: 'fixed_pending_verify',
        fixedVia: 'yard',
        note: `Marked fixed in the PTI review (week of ${week})`,
        reason: null,
        workOrderId: null,
        workOrderNumber: null,
        ownerId: null,
      });
      if (canClear) {
        await transition.mutateAsync({
          id: d.id,
          version: fixed.version,
          to: 'verified',
          fixedVia: null,
          note: null,
          reason: null,
          workOrderId: null,
          workOrderNumber: null,
          ownerId: null,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ptiKeys.all });
      toast({
        tone: 'success',
        title: canClear ? `${d.defectNumber} fixed and cleared` : `${d.defectNumber} marked fixed`,
        description: canClear ? undefined : 'Safety confirms it to clear it.',
      });
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'Not marked fixed',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setFixingId(null);
    }
  };

  // --- the form's own state
  const [path, setPath] = useState<'clean' | 'issue'>('clean');
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [shots, setShots] = useState<Record<string, Screenshot[]>>({});
  const [issues, setIssues] = useState<IssueDraft[]>([]);
  const [dispositions, setDispositions] = useState<Record<string, Disposition>>({});
  const [receipt, setReceipt] = useState<'received' | 'missing'>(received ? 'received' : 'missing');
  const [receivedOn, setReceivedOn] = useState<string>(
    inspection.receivedAt ? inspection.receivedAt.slice(0, 10) : companyToday(),
  );
  const [saving, setSaving] = useState<'save' | 'next' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string[] | null>(null);
  // the add-an-issue row
  const [addComponent, setAddComponent] = useState('');
  const [addProblem, setAddProblem] = useState('');
  const [addUrgency, setAddUrgency] = useState<Urgency>('soon');
  const [addShots, setAddShots] = useState<Screenshot[]>([]);
  const [addError, setAddError] = useState<string | null>(null);

  // The soft lock: "Elena is reviewing this". Taken on open, given back on close; never enforced.
  const lockedByOther = inspection.inReviewBy !== null && inspection.inReviewBy !== reviewer.id;
  useEffect(() => {
    if (!canWrite || reviewed || lockedByOther || inspection.inReviewBy === reviewer.id) return;
    const { id, version } = inspection;
    lock.mutate({ id, version, on: true });
    return () => {
      lock.mutate({ id, version: version + 1, on: false });
    };
    // Once per inspection: the lock is about the row, not about re-renders of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspection.id]);

  const ctx: ReviewContext | null = useMemo(() => {
    if (!catalog.data || !assignees.data) return null;
    return {
      inspection,
      openDefects,
      components: catalog.data.components,
      conditions: catalog.data.conditions,
      assignees: assignees.data,
      reviewerName: reviewer.name,
      now: serverNow(),
    };
  }, [catalog.data, assignees.data, inspection, openDefects, reviewer.name]);
  const components = ctx?.components ?? [];
  const markOf = (c: PtiComponentDef): Mark => marks[c.id] ?? 'good';

  // The draft the rules read, built from what the form shows.
  const draft: ReviewDraft = useMemo(() => {
    const base = { ...emptyDraft(), dispositions };
    if (!ctx) return base;
    if (path === 'issue') return { ...base, result: 'issues_found', issues };
    const ratings: ReviewDraft['ratings'] = {};
    const fromMarks: IssueDraft[] = [];
    for (const c of components) {
      const mark = markOf(c);
      if (mark === 'good') ratings[c.id] = 'good';
      if (mark === 'soon' || mark === 'now') {
        const severity: PtiDefectSeverity = mark === 'soon' ? 'replace_soon' : 'replace_now';
        fromMarks.push({
          ...newIssue(c.key ?? null, ctx, severity),
          key: `mark_${c.id}`,
          description: `${c.name} — replace ${mark === 'soon' ? 'soon' : 'now'} (walk-around checklist)`,
          screenshots: shots[c.id] ?? [],
        });
      }
    }
    return {
      ...base,
      result: fromMarks.length > 0 ? 'issues_found' : 'no_issues',
      ratings,
      issues: fromMarks,
    };
    // marks/shots/issues/dispositions are the inputs; ctx brings the catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, path, marks, shots, issues, dispositions]);
  const plan = ctx ? planReview(draft, ctx) : null;
  const videoIn = received || receipt === 'received';
  const canSave = Boolean(plan?.canSave) && videoIn && !locked && saving === null;

  const tally = useMemo(() => {
    const c = { good: 0, soon: 0, now: 0, na: 0 };
    for (const comp of components) c[markOf(comp)] += 1;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [components, marks]);

  const addIssue = () => {
    if (!ctx) return;
    const component = ctx.components.find((c) => c.id === addComponent);
    if (!component) return setAddError('Choose the component.');
    if (addProblem.trim().length < 8) return setAddError('Say what is wrong in a short line.');
    const severity = URGENCY[addUrgency].severity;
    if (screenshotRequired(severity) && addShots.length === 0)
      return setAddError('An urgent issue needs a screenshot from the video.');
    setAddError(null);
    setIssues((list) => [
      ...list,
      {
        ...newIssue(component.key ?? null, ctx, severity),
        description: addProblem.trim(),
        screenshots: addShots,
      },
    ]);
    setAddProblem('');
    setAddShots([]);
    setSavedNote(null);
  };

  async function save(andNext: boolean) {
    if (!ctx || !plan || !plan.canSave || !videoIn) return;
    setSaving(andNext ? 'next' : 'save');
    setSaveError(null);
    try {
      let current: PtiInspection = inspection;
      if (plan.receipt) {
        current = await receive.mutateAsync({
          id: current.id,
          version: current.version,
          receivedAt: new Date(`${receivedOn}T12:00:00`).toISOString(),
          source: null,
        });
      }
      const result = draft.result ?? 'no_issues';
      const saved = await review.mutateAsync({
        id: current.id,
        version: current.version,
        result,
        receivedAt: null,
        dispositions: plan.dispositions,
        defects: plan.defects.map((defect) => ({
          component: defect.component,
          description: defect.description,
          quickPick: defect.quickPick,
          severity: defect.severity,
          evidence: {
            clipTime: defect.evidence.clipTime,
            screenshots: defect.evidence.screenshots,
          },
          ownerId: defect.ownerId,
          dueAt: defect.dueAt,
        })),
      });
      if (plan.ratings.length > 0) {
        await rateComponentsForUnit(
          { truckId: inspection.unitId, weekStart: inspection.weekStart },
          plan.ratings,
          reviewer,
        );
      }
      if (plan.notifiesDispatch) {
        const worst = saved.defects.reduce<PtiDefect | null>(
          (acc, d) => (acc === null || d.severity === 'oos_risk' ? d : acc),
          null,
        );
        pushNotification({
          kind: 'fleet',
          severity: worst?.severity === 'oos_risk' ? 'critical' : 'warning',
          title:
            worst?.severity === 'oos_risk'
              ? `Unit ${inspection.unitNumber} is out of service`
              : `Unit ${inspection.unitNumber} is restricted`,
          body: `${worst?.defectNumber ?? 'A defect'} on the walk-around of the week of ${formatIsoDate(inspection.weekStart)}${inspection.dispatcherName ? ` — for ${inspection.dispatcherName}` : ''}. Released when safety verifies the repair.`,
          department: 'dispatch',
          entity: { type: 'truck', id: inspection.unitId, label: `Unit ${inspection.unitNumber}` },
          source: 'user',
          actionRequired: true,
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ptiKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['fleet'] }),
      ]);
      const holds = saved.defects.some((d) => d.severity === 'oos_risk');
      const lines =
        result === 'no_issues'
          ? [`Saved — reviewed, ${tally.good} of ${components.length} good.`]
          : [
              `Saved — ${saved.defects.length} issue${saved.defects.length === 1 ? '' : 's'} recorded.`,
              ...saved.defects.map((d) => `${d.componentName} — ${d.description}`),
            ];
      lines.push(holds ? `Unit ${inspection.unitNumber} goes on hold.` : 'Truck keeps running.');
      if (openDefects.length > 0) lines.push('The open issue is untouched.');
      setSavedNote(lines);
      toast({ tone: 'success', title: lines[0] ?? 'Saved' });
      onSaved?.();
      if (andNext && onSavedNext) onSavedNext();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The review could not be saved.');
    } finally {
      setSaving(null);
    }
  }

  const pill = statusPill(row);
  const flagged = tally.soon + tally.now;

  return (
    <div
      className="flex flex-col gap-3.5"
      role="region"
      aria-label={`Review unit ${inspection.unitNumber}`}
    >
      <section className="overflow-hidden rounded-xl border border-nw-border bg-nw-panel">
        {/* Head: everything that fills in by itself */}
        <div className="border-b border-nw-border px-[18px] pt-[15px] pb-[13px]">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-[19px] font-extrabold tracking-[-.022em] text-nw-text">
              Pre-trip inspection
            </h2>
            <Badge tone={pill.tone} size="sm" className="uppercase tracking-[.05em]">
              {pill.label}
            </Badge>
          </div>
          <p className="mt-1.5 text-[11.5px] leading-[1.65] text-nw-text-3">
            Unit <b className="font-semibold text-nw-text-2">{inspection.unitNumber}</b> · Driver{' '}
            <b className="font-semibold text-nw-text-2">
              {inspection.driverName ?? 'none assigned'}
            </b>{' '}
            · Dispatcher{' '}
            <b className="font-semibold text-nw-text-2">{inspection.dispatcherName ?? '—'}</b>
            <br />
            Week <b className="font-semibold text-nw-text-2">{weekRangeLabel(week)}</b> ·{' '}
            {reviewed ? (
              <>
                Reviewed by{' '}
                <b className="font-semibold text-nw-text-2">{inspection.reviewerName ?? '—'}</b>{' '}
                {inspection.reviewedAt ? formatDate(inspection.reviewedAt) : ''}
              </>
            ) : (
              <>
                Reviewed by <b className="font-semibold text-nw-text-2">{reviewer.name}</b> today
              </>
            )}
          </p>
        </div>

        <div className="flex flex-col gap-3.5 px-[18px] py-[15px]">
          {lockedByOther ? (
            <Alert
              tone="info"
              title={`${inspection.inReviewByName ?? 'Somebody'} is reviewing this`}
              description="You can still save; the last save wins and both are on the record."
            />
          ) : null}

          {/* What the driver sent from the app, and Request correction (mobile, 2026-10-27). */}
          <DriverSubmissionCard inspection={inspection} canWrite={canWrite} />

          {/* The video: received or not. Nothing can be reviewed before it arrives. */}
          {!received && !reviewed ? (
            <div className="flex flex-wrap items-center gap-2 rounded-[9px] border border-nw-border bg-nw-subtle px-3 py-2.5">
              <span className="text-xs font-bold text-nw-text-2">Video</span>
              <div
                className="flex gap-1 rounded-md bg-nw-segment p-0.5"
                role="group"
                aria-label="Video"
              >
                {(['received', 'missing'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={receipt === v}
                    disabled={locked}
                    onClick={() => setReceipt(v)}
                    className={cn(
                      'h-7 rounded px-2.5 text-xs font-semibold',
                      receipt === v
                        ? v === 'received'
                          ? 'bg-nw-done-bg text-nw-done-text'
                          : 'bg-nw-urgent-bg text-nw-urgent-text'
                        : 'text-nw-text-3 hover:bg-nw-panel',
                    )}
                  >
                    {v === 'received' ? 'Received' : 'Missing'}
                  </button>
                ))}
              </div>
              {receipt === 'received' ? (
                <div className="w-40">
                  <DatePicker
                    aria-label="Received date"
                    value={receivedOn}
                    disabled={locked}
                    onIsoChange={(iso) => setReceivedOn(iso ?? companyToday())}
                  />
                </div>
              ) : (
                <span className="text-[11.5px] text-nw-text-3">
                  Nothing to review until the video comes.
                </span>
              )}
            </div>
          ) : null}

          {/* Open issues stay open whatever is recorded here; on a clean review each is answered. */}
          {openDefects.length > 0 ? (
            <div className="rounded-[9px] border border-nw-urgent-border bg-nw-urgent-bg px-3 py-2.5">
              <p className="text-[12.5px] font-bold text-nw-urgent-text">
                {openDefects.length === 1
                  ? '1 issue still open on this truck'
                  : `${openDefects.length} issues still open on this truck`}
              </p>
              <ul className="mt-1 flex flex-col gap-1.5">
                {openDefects.map((d) => (
                  <li
                    key={d.id}
                    className="flex flex-wrap items-center gap-2 text-[11.5px] text-nw-text-2"
                  >
                    <span className="min-w-0 flex-1">
                      {d.componentName} — {d.description}
                      {d.state === 'fixed_pending_verify'
                        ? ' · marked fixed, waiting for safety to confirm'
                        : ' · stays open until it is marked fixed'}
                    </span>
                    {canWrite && canTransition(d.state, 'fixed_pending_verify') ? (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={fixingId === d.id}
                        disabled={fixingId !== null && fixingId !== d.id}
                        onClick={() => void markFixed(d)}
                      >
                        Fixed
                      </Button>
                    ) : null}
                    {d.state === 'fixed_pending_verify' && canClear ? (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={transition.isPending}
                        onClick={() => void confirmRepair(d)}
                      >
                        Confirm & clear
                      </Button>
                    ) : !locked && path === 'clean' ? (
                      <span
                        className="flex gap-1"
                        role="group"
                        aria-label={`${d.defectNumber} in this video`}
                      >
                        {DISPOSITIONS.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            aria-pressed={dispositions[d.id] === opt.value}
                            onClick={() => setDispositions((m) => ({ ...m, [d.id]: opt.value }))}
                            className={cn(
                              'h-6 rounded-md border px-2 text-[11px] font-semibold',
                              dispositions[d.id] === opt.value
                                ? 'border-nw-border-strong bg-nw-panel text-nw-text'
                                : 'border-transparent text-nw-text-3 hover:bg-nw-panel',
                            )}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Result */}
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Result">
            <button
              type="button"
              aria-pressed={path === 'clean'}
              disabled={locked}
              onClick={() => {
                setPath('clean');
                setSavedNote(null);
              }}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded-[10px] border px-2.5 py-[15px] text-[14.5px] leading-[1.3] font-bold',
                path === 'clean'
                  ? 'border-nw-done-icon bg-nw-done-bg text-nw-done-text shadow-[inset_0_0_0_1px_var(--color-nw-done-icon)]'
                  : 'border-nw-border-strong bg-nw-panel text-nw-text-2 hover:bg-nw-hover',
              )}
            >
              No issues
              <span
                className={cn(
                  'text-[11px] font-semibold',
                  path === 'clean' ? 'text-nw-done-text/85' : 'text-nw-text-3',
                )}
              >
                Check each part below
              </span>
            </button>
            <button
              type="button"
              aria-pressed={path === 'issue'}
              disabled={locked}
              onClick={() => {
                setPath('issue');
                setSavedNote(null);
              }}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded-[10px] border px-2.5 py-[15px] text-[14.5px] leading-[1.3] font-bold',
                path === 'issue'
                  ? 'border-nw-urgent-icon bg-nw-urgent-bg text-nw-urgent-text shadow-[inset_0_0_0_1px_var(--color-nw-urgent-icon)]'
                  : 'border-nw-border-strong bg-nw-panel text-nw-text-2 hover:bg-nw-hover',
              )}
            >
              Issue found
              <span
                className={cn(
                  'text-[11px] font-semibold',
                  path === 'issue' ? 'text-nw-urgent-text/85' : 'text-nw-text-3',
                )}
              >
                Something needs fixing
              </span>
            </button>
          </div>

          {path === 'clean' ? (
            <>
              <div className="overflow-hidden rounded-[10px] border border-nw-border">
                <div className="flex flex-wrap items-center gap-2 border-b border-nw-border bg-nw-subtle px-3 py-2">
                  <span className="min-w-[150px] flex-1 text-xs font-bold" aria-live="polite">
                    {!ctx ? (
                      <span className="text-nw-text-3">Loading…</span>
                    ) : (
                      [
                        tally.good ? (
                          <span key="g" className="text-nw-done-text">
                            {tally.good} good
                          </span>
                        ) : null,
                        tally.soon ? (
                          <span key="s" className="text-nw-warning-text">
                            {tally.soon} soon
                          </span>
                        ) : null,
                        tally.now ? (
                          <span key="n" className="text-nw-urgent-text">
                            {tally.now} now
                          </span>
                        ) : null,
                        tally.na ? (
                          <span key="a" className="text-nw-text-3">
                            {tally.na} not seen
                          </span>
                        ) : null,
                      ]
                        .filter(Boolean)
                        .reduce<React.ReactNode[]>(
                          (acc, el, i) => (i === 0 ? [el] : [...acc, ' · ', el]),
                          [],
                        )
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={locked}
                    onClick={() => {
                      setMarks({});
                      setSavedNote(null);
                    }}
                  >
                    Mark all good
                  </Button>
                </div>
                {components.map((c) => {
                  const mark = markOf(c);
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        'flex flex-wrap items-center gap-2.5 border-b border-nw-border px-3 py-[7px] last:border-b-0',
                        mark === 'soon' && 'bg-nw-warning-bg',
                        mark === 'now' && 'bg-nw-urgent-bg',
                      )}
                    >
                      <span
                        className={cn(
                          'min-w-0 flex-1 text-[12.5px] font-semibold',
                          mark === 'na' ? 'text-nw-text-3' : 'text-nw-text',
                        )}
                      >
                        {c.name}
                      </span>
                      <div
                        className="grid w-[196px] flex-none grid-cols-4 gap-[3px] rounded-[7px] bg-nw-subtle p-0.5"
                        role="group"
                        aria-label={c.name}
                      >
                        {MARKS.map((m) => (
                          <button
                            key={m.value}
                            type="button"
                            aria-pressed={mark === m.value}
                            aria-label={`${c.name} ${m.aria}`}
                            disabled={locked}
                            onClick={() => {
                              setMarks((all) => ({ ...all, [c.id]: m.value }));
                              setSavedNote(null);
                            }}
                            className={cn(
                              'rounded-[5px] border border-transparent px-0.5 py-[5px] text-[11px] leading-[1.2] font-bold text-nw-text-3 hover:bg-nw-panel',
                              mark === m.value && MARK_ON[m.value],
                            )}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                      {mark === 'now' ? (
                        <ShotRow
                          shots={shots[c.id] ?? []}
                          uploadedBy={reviewer.name}
                          disabled={locked}
                          onChange={(next) => setShots((all) => ({ ...all, [c.id]: next }))}
                        />
                      ) : null}
                    </div>
                  );
                })}
                <p className="border-t border-nw-border bg-nw-subtle px-3 py-2 text-[11px] leading-[1.6] text-nw-text-3">
                  <b className="font-bold text-nw-text-2">Good</b> — fine ·{' '}
                  <b className="font-bold text-nw-text-2">Soon</b> — replace within 2 weeks ·{' '}
                  <b className="font-bold text-nw-text-2">Now</b> — replace before the next load ·{' '}
                  <b className="font-bold text-nw-text-2">—</b> couldn&apos;t see it
                  <br />
                  Anything not Good becomes a tracked issue. &ldquo;—&rdquo; records that nobody
                  looked; it never counts as healthy.
                </p>
              </div>
              <p className="rounded-lg border border-nw-border bg-nw-subtle px-3 py-2.5 text-xs leading-[1.55] text-nw-text-2">
                Saves this week as <b className="font-bold text-nw-text">reviewed</b> for unit{' '}
                {inspection.unitNumber}, with all {components.length} components recorded against{' '}
                {reviewer.name}&rsquo;s name.
                {flagged > 0 ? (
                  <>
                    {' '}
                    <b className="font-bold text-nw-text">
                      {flagged} component{flagged === 1 ? '' : 's'}
                    </b>{' '}
                    will open a tracked issue
                    {tally.now ? ' — the truck stays on hold.' : ', and the truck keeps running.'}
                  </>
                ) : null}
                {tally.na > 0 ? (
                  <>
                    {' '}
                    <b className="font-bold text-nw-text">{tally.na}</b> recorded as not seen —
                    shown as unknown on the truck, never as healthy.
                  </>
                ) : null}
                {openDefects.length > 0 ? ' The open issue is untouched.' : null}
              </p>
            </>
          ) : (
            <div className="flex flex-col gap-3.5">
              <Field label="Component">
                <Select
                  aria-label="Component"
                  value={addComponent}
                  placeholder="Choose…"
                  disabled={locked}
                  onValueChange={setAddComponent}
                  options={components.map((c) => ({ value: c.id, label: c.name }))}
                />
              </Field>
              <Field label="What's wrong">
                <Input
                  aria-label="What's wrong"
                  value={addProblem}
                  disabled={locked}
                  onChange={(e) => setAddProblem(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addIssue();
                    }
                  }}
                  placeholder="One short line — e.g. axle 1 left, out of stroke"
                />
              </Field>
              <Field label="Urgency">
                <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Urgency">
                  {(Object.keys(URGENCY) as Urgency[]).map((u) => (
                    <button
                      key={u}
                      type="button"
                      aria-pressed={addUrgency === u}
                      disabled={locked}
                      onClick={() => setAddUrgency(u)}
                      className={cn(
                        'rounded-lg border px-1 py-2.5 text-[13px] font-bold',
                        addUrgency === u
                          ? URGENCY_ON[u]
                          : 'border-nw-border-strong bg-nw-panel text-nw-text-2 hover:bg-nw-hover',
                      )}
                    >
                      {URGENCY[u].label}
                    </button>
                  ))}
                </div>
                <p className="mt-0.5 text-[11.5px] text-nw-text-2">{URGENCY[addUrgency].note}</p>
              </Field>
              {screenshotRequired(URGENCY[addUrgency].severity) ? (
                <Field label="Screenshot from the video (required for Urgent)">
                  <ShotRow
                    shots={addShots}
                    uploadedBy={reviewer.name}
                    disabled={locked}
                    onChange={setAddShots}
                  />
                </Field>
              ) : null}
              {addError ? (
                <p role="alert" className="text-xs text-nw-urgent-text">
                  {addError}
                </p>
              ) : null}
              <Button variant="secondary" disabled={locked || !ctx} onClick={addIssue}>
                Add this issue
              </Button>

              {issues.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-[11.5px] font-bold text-nw-text-2">
                    Added this inspection
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {issues.map((issue) => {
                      const component = components.find((c) => c.key === issue.component);
                      const urgency = URGENCY_FOR[issue.severity] ?? 'soon';
                      return (
                        <li
                          key={issue.key}
                          className="flex items-start gap-2.5 rounded-[9px] border border-nw-border bg-nw-subtle px-2.5 py-2"
                        >
                          <span
                            className={cn(
                              'w-[3px] min-h-[26px] self-stretch rounded-sm',
                              URGENCY_BAR[urgency],
                            )}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[12.5px] font-bold text-nw-text">
                              {component?.name ?? issue.component}
                            </span>
                            <span className="block text-[11px] text-nw-text-3">
                              {issue.description} · {URGENCY[urgency].label}
                            </span>
                          </span>
                          {!locked ? (
                            <button
                              type="button"
                              aria-label={`Remove ${component?.name ?? 'issue'}`}
                              onClick={() =>
                                setIssues((list) => list.filter((i) => i.key !== issue.key))
                              }
                              className="rounded-md px-1 text-[15px] leading-none text-nw-text-3 hover:bg-nw-hover hover:text-nw-urgent-text"
                            >
                              <X className="size-3.5" aria-hidden />
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
          )}

          {plan && plan.problems.length > 0 && !locked ? (
            <ul
              className="flex flex-col gap-0.5 text-xs text-nw-warning-text"
              aria-label="Before saving"
            >
              {plan.problems.map((problem) => (
                <li key={problem}>! {problem}</li>
              ))}
            </ul>
          ) : null}
          {saveError ? <Alert tone="danger" title="Not saved" description={saveError} /> : null}
          {savedNote ? (
            <div className="rounded-[9px] border border-nw-done-border bg-nw-done-bg px-3 py-2.5 text-[12.5px] leading-[1.6] text-nw-text-2">
              {savedNote.map((line, i) => (
                <span key={line} className={cn('block', i === 0 && 'font-bold text-nw-done-text')}>
                  {line}
                </span>
              ))}
            </div>
          ) : null}
          {reviewed && !savedNote && !editingSaved ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11.5px] text-nw-text-3">This week is reviewed and on the record.</p>
              {canWrite ? (
                <Button size="sm" variant="outline" onClick={() => setEditingSaved(true)} data-testid="pti-edit-review">
                  Edit review
                </Button>
              ) : null}
            </div>
          ) : null}
          {reviewed && editingSaved && !savedNote ? (
            <Alert tone="warning" title="Editing a saved review" description={`Saving replaces the result ${inspection.reviewerName ?? 'the reviewer'} saved; both stay in the history.`} />
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-nw-border bg-nw-subtle px-[18px] py-[13px]">
          <Button variant="secondary" onClick={onCancel} disabled={saving !== null}>
            Cancel
          </Button>
          <span className="flex-1" />
          {/* One Save, no Save & next: the owner reviews a truck and stays on it (2026-10-05). */}
          <Button
            variant="primary"
            size="lg"
            loading={saving === 'save'}
            disabled={!canSave}
            onClick={() => void save(false)}
          >
            Save
          </Button>
        </div>
      </section>

      {/* History: the last four weeks of this unit */}
      <section
        className="overflow-hidden rounded-xl border border-nw-border bg-nw-panel"
        aria-label="Inspection history"
      >
        <div className="flex items-center gap-2 border-b border-nw-border px-[18px] py-[13px]">
          <h3 className="flex-1 text-[13.5px] font-bold text-nw-text">Inspection history</h3>
          <span className="text-[10px] font-extrabold tracking-[.09em] text-nw-text-3 uppercase">
            Last 4 weeks
          </span>
        </div>
        {history.isPending ? (
          <p className="px-[18px] py-3 text-xs text-nw-text-3">Loading…</p>
        ) : (history.data ?? []).length === 0 ? (
          <p className="px-[18px] py-3 text-xs text-nw-text-3">No earlier weeks on record.</p>
        ) : (
          (history.data ?? []).map((h) => {
            const receivedPill =
              h.receiptStatus === 'received' || h.receiptStatus === 'late'
                ? { tone: 'success' as const, label: 'Received' }
                : h.receiptStatus === 'missing'
                  ? { tone: 'danger' as const, label: 'Missing' }
                  : h.receiptStatus === 'exempt_in_shop'
                    ? { tone: 'neutral' as const, label: 'In shop' }
                    : { tone: 'neutral' as const, label: 'Awaiting' };
            const resultPill =
              h.reviewState === 'reviewed'
                ? h.reviewResult === 'issues_found'
                  ? {
                      tone: 'danger' as const,
                      label: `${h.defectCount || 1} issue${h.defectCount === 1 ? '' : 's'}`,
                    }
                  : { tone: 'neutral' as const, label: 'No issues' }
                : h.receiptStatus === 'received' || h.receiptStatus === 'late'
                  ? { tone: 'info' as const, label: 'Not reviewed' }
                  : null;
            return (
              <div
                key={h.id}
                className="flex items-center gap-2.5 border-b border-nw-border px-[18px] py-[11px] text-[12.5px] last:border-b-0 hover:bg-nw-hover"
              >
                <span className="tabular w-24 flex-none font-bold text-nw-text-2">
                  {formatIsoDate(h.weekStart)}
                </span>
                <Badge tone={receivedPill.tone} size="sm" className="uppercase tracking-[.05em]">
                  {receivedPill.label}
                </Badge>
                {resultPill ? (
                  <Badge tone={resultPill.tone} size="sm" className="uppercase tracking-[.05em]">
                    {resultPill.label}
                  </Badge>
                ) : null}
                <span className="ml-auto text-[11.5px] text-nw-text-3">
                  {h.reviewerName ?? (h.receiptStatus === 'missing' ? 'never sent' : '—')}
                </span>
              </div>
            );
          })
        )}
      </section>

      <p className="text-[11.5px] leading-[1.7] text-nw-text-3">
        Unit, driver, week, reviewer and date fill in automatically. Everything starts at{' '}
        <b className="font-bold text-nw-text-2">Good</b> — you only tap what isn&apos;t.
        <br />
        <b className="font-bold text-nw-text-2">
          &ldquo;No issues&rdquo; never closes an older open issue
        </b>{' '}
        — that happens on the truck, with a person&apos;s name on it.
      </p>
    </div>
  );
}

const MARK_ON: Record<Mark, string> = {
  good: 'border-nw-done-icon bg-nw-done-bg text-nw-done-text',
  soon: 'border-nw-warning-icon bg-nw-warning-bg text-nw-warning-text',
  now: 'border-nw-urgent-icon bg-nw-urgent-bg text-nw-urgent-text',
  na: 'border-nw-neutral-border bg-nw-neutral-bg text-nw-text-2',
};
const URGENCY_ON: Record<Urgency, string> = {
  watch: 'border-nw-moving-icon bg-nw-moving-bg text-nw-moving-text',
  soon: 'border-nw-warning-icon bg-nw-warning-bg text-nw-warning-text',
  urgent: 'border-nw-urgent-icon bg-nw-urgent-bg text-nw-urgent-text',
};
const URGENCY_BAR: Record<Urgency, string> = {
  watch: 'bg-nw-moving-icon',
  soon: 'bg-nw-warning-icon',
  urgent: 'bg-nw-urgent-icon',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-bold text-nw-text-2">{label}</span>
      {children}
    </div>
  );
}

/** Screenshots from the video, where the severity demands one. */
function ShotRow({
  shots,
  uploadedBy,
  disabled,
  onChange,
}: {
  shots: Screenshot[];
  uploadedBy: string;
  disabled: boolean;
  onChange: (next: Screenshot[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex w-full flex-wrap items-center gap-1.5 text-[11px]">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        aria-label="Screenshot"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            onChange([...shots, await uploadScreenshot(file, uploadedBy)]);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'The screenshot could not be uploaded.');
          } finally {
            setBusy(false);
          }
        }}
      />
      {shots.map((s) => (
        <span
          key={s.fileId}
          className="inline-flex items-center gap-1 rounded-md border border-nw-border bg-nw-panel px-1.5 py-0.5 text-nw-text-2"
        >
          {s.fileName}
          {!disabled ? (
            <button
              type="button"
              aria-label={`Remove ${s.fileName}`}
              onClick={() => onChange(shots.filter((x) => x.fileId !== s.fileId))}
            >
              <X className="size-3" aria-hidden />
            </button>
          ) : null}
        </span>
      ))}
      <Button
        size="sm"
        variant="secondary"
        icon={<ImagePlus />}
        loading={busy}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {shots.length ? 'Add another' : 'Add screenshot'}
      </Button>
      {error ? <span className="text-nw-urgent-text">{error}</span> : null}
    </span>
  );
}
