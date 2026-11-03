import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Plus, SkipForward, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  DEFECT_DISPOSITIONS,
  DEFECT_DISPOSITION_LABEL,
  PTI_DEFECT_SEVERITY_LABEL,
  type DefectDisposition,
  type PtiBoardRow,
  type PtiDefect,
  type PtiInspection,
} from '@neway/shared';
import {
  conditionsFor,
  demoData,
  listPtiComponents,
  rateComponentsForUnit,
  type PtiComponentDef,
} from '@/demo';
import { pushNotification } from '@/demo/notifications-api';
import { ensureRoster } from '@/demo/roster-api';
import {
  Alert,
  Button,
  ConfirmDialog,
  Drawer,
  FormField,
  Input,
  StatusBadge,
  StatusSymbol,
  cn,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { now as serverNow, nowIso } from '@/lib/clock';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import {
  openWorkOrderForDefect,
  usePtiBoard,
  useReceiveInspection,
  useReviewInspection,
  useTransitionDefect,
  useLockInspection,
  ptiKeys,
} from './api';
import { IssueCard } from './IssueCard';
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
import { apiGet } from '@/lib/api-client';
import { isEnabled } from '@/lib/feature-flags';

/**
 * Update PTI, as a drawer over the board (§6).
 *
 * Queue processing: 520 px on the right, the board still readable behind it, `?review=<unitId>`
 * in the URL so a row is a link. Two clicks for a clean video; one card per issue for the rest,
 * with the truck, the driver, the week and the Telegram link inherited rather than typed again.
 * The footer says everything the save will do before it is clicked, and the rules that decide
 * whether it can are the server's - this screen only repeats them early.
 */
export function ReviewDrawer({
  unitId,
  week,
  onClose,
  onNavigate,
  inline = false,
}: {
  unitId: string;
  week?: string;
  onClose: () => void;
  /** Move the drawer to another unit (Skip, Save & next). */
  onNavigate: (unitId: string) => void;
  /** Render as a column beside the board (the owner's 2026-09-20 layout) rather than over it. */
  inline?: boolean;
}) {
  const account = useAccount();
  const board = usePtiBoard(week);
  const rows = useMemo(() => board.data?.rows ?? [], [board.data]);
  const row = rows.find((r) => r.inspection.unitId === unitId) ?? null;

  // The review queue, in board order; the unit's place in it is what the header counts.
  const queue = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.inspection.reviewState !== 'reviewed' &&
          !['exempt_in_shop', 'not_due'].includes(r.inspection.receiptStatus),
      ),
    [rows],
  );
  const position = queue.findIndex((r) => r.inspection.unitId === unitId);
  const next = position >= 0 ? (queue[position + 1] ?? null) : (queue[0] ?? null);

  // Esc, the X, Cancel and a click outside all ask before leaving: the review is a record in
  // progress until it is saved (owner's ask, 2026-09-21). Moving to the next unit asks only
  // when a draft would be lost (§6.1).
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => setConfirmClose(true);
  const requestNavigate = (to: string) => (dirty ? setConfirmClose(true) : onNavigate(to));

  const body = row ? (
    <ReviewBody
      key={row.inspection.id}
      row={row}
      reviewer={{ id: account?.userId ?? 'unknown', name: account?.name ?? 'Unknown' }}
      canWrite={
        account?.permissions.some((p) => p === 'maintenance.edit' || p === 'safety.manage') ?? false
      }
      onDirtyChange={setDirty}
      onCancel={requestClose}
      onSaved={onClose}
      onSavedNext={
        next && next.inspection.unitId !== unitId ? () => onNavigate(next.inspection.unitId) : null
      }
    />
  ) : board.isPending ? (
    <p className="px-5 py-4 text-sm text-muted">Loading…</p>
  ) : (
    <p className="px-5 py-4 text-sm text-muted">Nothing to review here.</p>
  );
  const confirm = (
    <ConfirmDialog
      open={confirmClose}
      onOpenChange={setConfirmClose}
      title="Leave without saving?"
      description="What you entered on this unit is not saved and will be gone."
      confirmLabel="Leave"
      tone="danger"
      onConfirm={() => onClose()}
    />
  );

  if (inline) {
    return (
      <aside
        className="sticky top-4 flex max-h-[calc(100vh-2rem)] min-w-0 flex-col overflow-hidden rounded-[10px] border border-nw-border bg-nw-panel"
        aria-label={row ? `Review unit ${row.inspection.unitNumber}` : 'Review'}
      >
        <div className="flex items-start justify-between gap-3 border-b border-nw-border px-4 pt-3.5 pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg leading-tight font-bold text-nw-text">
                {row ? `Unit ${row.inspection.unitNumber}` : 'Update PTI'}
              </h2>
              {row ? <StatusBadge status={row.verdict.status} size="sm" /> : null}
            </div>
            <p className="mt-0.5 truncate text-[12.5px] text-nw-text-3">
              {row ? (
                <HeaderLine row={row} />
              ) : board.isPending ? (
                'Loading…'
              ) : (
                'That unit is not on this week’s board'
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={requestClose}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-nw-text-2 hover:bg-nw-hover"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="border-b border-nw-border px-4">
          <QueueStrip
            position={position}
            total={queue.length}
            canSkip={next !== null && next.inspection.unitId !== unitId}
            onSkip={() => next && requestNavigate(next.inspection.unitId)}
          />
        </div>
        {body}
        {confirm}
      </aside>
    );
  }

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      backdrop="clear"
      className="md:w-130"
      title={row ? `Unit ${row.inspection.unitNumber}` : 'Update PTI'}
      description={
        row ? (
          <HeaderLine row={row} />
        ) : board.isPending ? (
          'Loading…'
        ) : (
          'That unit is not on this week’s board'
        )
      }
      headerExtra={row ? <StatusBadge status={row.verdict.status} /> : null}
      tabs={
        <QueueStrip
          position={position}
          total={queue.length}
          canSkip={next !== null && next.inspection.unitId !== unitId}
          onSkip={() => next && requestNavigate(next.inspection.unitId)}
        />
      }
      bodyClassName="px-0 py-0"
      footer={null}
    >
      {body}
      {confirm}
    </Drawer>
  );
}

function HeaderLine({ row }: { row: PtiBoardRow }) {
  const truck = useQuery({
    queryKey: ['roster', 'truck', row.inspection.unitId],
    queryFn: async () => {
      await ensureRoster();
      return demoData.trucks.find((t) => t.id === row.inspection.unitId) ?? null;
    },
  });
  const model = truck.data ? `${truck.data.year} ${truck.data.make} ${truck.data.model}` : null;
  return (
    <>
      {[
        model,
        row.inspection.driverName ?? 'no driver',
        row.inspection.dispatcherName ? `dispatch ${row.inspection.dispatcherName}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}
    </>
  );
}

function QueueStrip({
  position,
  total,
  canSkip,
  onSkip,
}: {
  position: number;
  total: number;
  canSkip: boolean;
  onSkip: () => void;
}) {
  const done = position >= 0 ? position : total;
  return (
    <div className="flex items-center gap-3 py-2 text-xs text-muted">
      <span className="tabular">
        {position >= 0 ? `${position + 1} of ${total}` : `${total} in the queue`}
      </span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-nw-track" aria-hidden>
        <span
          className="block h-full rounded-full bg-nw-accent"
          style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }}
        />
      </span>
      <Button size="sm" variant="ghost" icon={<SkipForward />} disabled={!canSkip} onClick={onSkip}>
        Skip
      </Button>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------

function ReviewBody({
  row,
  reviewer,
  canWrite,
  onDirtyChange,
  onCancel,
  onSaved,
  onSavedNext,
}: {
  row: PtiBoardRow;
  reviewer: { id: string; name: string };
  canWrite: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
  onSavedNext: (() => void) | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const inspection = row.inspection;
  const openDefects = row.openDefects;
  const reviewed = inspection.reviewState === 'reviewed';

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

  const receive = useReceiveInspection();
  const review = useReviewInspection();
  const transition = useTransitionDefect();
  const lock = useLockInspection();
  // The odometer the video was taken at, as the PM engine last saw it; a fact, not an input.
  const odometer = useQuery({
    queryKey: ['pm', 'status', inspection.unitId],
    queryFn: () =>
      apiGet<{ readingOdometer: number | null }>(`/fleet/pm/status/${inspection.unitId}`),
    enabled: isEnabled('pm_module'),
  });

  const [draft, setDraft] = useState<ReviewDraft>(emptyDraft);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [receiptChoice, setReceiptChoice] = useState<'sent' | 'late' | 'none'>('none');
  const [saving, setSaving] = useState<'save' | 'next' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty =
    draft.issues.length > 0 ||
    draft.othersGood ||
    Object.keys(draft.ratings).length > 0 ||
    draft.source.messageUrl.trim() !== '';
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

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

  const derivedResult: ReviewDraft['result'] =
    draft.issues.length > 0
      ? 'issues_found'
      : draft.othersGood || Object.values(draft.ratings).some((r) => r === 'good')
        ? 'no_issues'
        : null;
  const effective: ReviewDraft =
    derivedResult === draft.result ? draft : { ...draft, result: derivedResult };
  const plan = ctx ? planReview(effective, ctx) : null;

  // The issue cards: one open at a time is the default; the rest are one-line summaries.
  const update = (key: string, next: IssueDraft) =>
    setDraft((d) => ({ ...d, issues: d.issues.map((i) => (i.key === key ? next : i)) }));
  const addIssue = (component: string | null, severity?: Parameters<typeof newIssue>[2]) => {
    if (!ctx) return;
    const issue = newIssue(component, ctx, severity);
    setDraft((d) => ({ ...d, result: 'issues_found', issues: [...d.issues, issue] }));
    setCollapsed((c) => new Set([...c, ...draft.issues.map((i) => i.key)]));
    return issue;
  };

  async function save(andNext: boolean) {
    if (!ctx || !plan || !plan.canSave) return;
    setSaving(andNext ? 'next' : 'save');
    setSaveError(null);
    try {
      let current: PtiInspection = inspection;
      if (plan.receipt) {
        current = await receive.mutateAsync({
          id: current.id,
          version: current.version,
          receivedAt: nowIso(),
          source: plan.receipt.messageUrl
            ? {
                chatTitle: plan.receipt.chatTitle,
                messageUrl: plan.receipt.messageUrl,
                senderName: plan.receipt.senderName || null,
              }
            : null,
        });
      }
      const result = effective.result ?? 'no_issues';
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

      // Follow-ups per defect, from the card's next action. None of them releases anything.
      for (const [index, defect] of saved.defects.entries()) {
        const planned = plan.defects[index];
        if (!planned) continue;
        await followUp(defect, planned.nextAction, planned.vendorName, ctx);
      }

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
      toast({
        tone: 'success',
        title:
          result === 'no_issues'
            ? `Unit ${inspection.unitNumber}: clean walk-around`
            : `Unit ${inspection.unitNumber}: ${saved.defects.length} defect${saved.defects.length === 1 ? '' : 's'} recorded`,
        description: saved.defects.map((d) => d.defectNumber).join(', ') || undefined,
      });
      // Saved: the draft is on the record, so leaving is not losing it.
      onDirtyChange(false);
      if (andNext && onSavedNext) onSavedNext();
      else onSaved();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The review could not be saved.');
    } finally {
      setSaving(null);
    }
  }

  async function followUp(
    defect: PtiDefect,
    action: IssueDraft['nextAction'],
    vendorName: string,
    context: ReviewContext,
  ) {
    const base = {
      id: defect.id,
      version: defect.version,
      note: null,
      reason: null,
      fixedVia: null,
      workOrderId: null,
      workOrderNumber: null,
      ownerId: null,
    } as const;
    if (action === 'already_fixed') {
      await transition.mutateAsync({
        ...base,
        to: 'fixed_pending_verify',
        fixedVia: 'yard',
        note: 'Already fixed when reviewed; proposed for verification',
      });
    } else if (action === 'yard') {
      await transition.mutateAsync({ ...base, to: 'scheduled', note: 'Scheduled at the yard' });
    } else if (action === 'work_order') {
      // The shop's own register, pre-linked: the server writes the link both ways and moves the
      // defect into repair. The sentence in the notes is for a person; the field is the link.
      await openWorkOrderForDefect(defect, {
        vendorName,
        notes: `Raised from the walk-around of the week of ${formatIsoDate(inspection.weekStart)}${inspection.source ? ` · ${inspection.source.messageUrl}` : ''}`,
      });
      void context;
    }
  }

  const received = inspection.receivedAt !== null;
  const showSource = !received && receiptChoice !== 'none';

  /** Good on the table: an explicit rating, and no issue for the component any more. */
  const markGood = (component: PtiComponentDef) => {
    setDraft((d) => ({
      ...d,
      issues: d.issues.filter((i) => i.component !== component.key),
      ratings: { ...d.ratings, [component.id]: 'good' },
    }));
  };
  /** Issue on the table: a finding card opens for the component in step 3. */
  const markIssue = (component: PtiComponentDef) => {
    if (draft.issues.some((i) => i.component === component.key)) return;
    setDraft((d) => {
      const ratings = { ...d.ratings };
      delete ratings[component.id];
      return { ...d, ratings };
    });
    addIssue(component.key ?? null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        {lockedByOther ? (
          <Alert
            tone="info"
            title={`${inspection.inReviewByName ?? 'Somebody'} is reviewing this`}
            description="You can still save; the last save wins and both are on the record."
          />
        ) : null}
        {reviewed ? (
          <Alert
            tone="info"
            title={`Reviewed ${inspection.reviewedAt ? formatDateTime(inspection.reviewedAt) : ''} by ${inspection.reviewerName ?? 'somebody'}`}
            description={
              inspection.reviewResult === 'no_issues'
                ? 'No issues on this video. A new finding goes on the truck page, not here.'
                : 'Issues were recorded; they live under the truck and on the board.'
            }
          />
        ) : null}

        <DriverSubmissionCard inspection={inspection} canWrite={canWrite} />

        {/* STEP 1 · Video receipt */}
        <section className="flex flex-col gap-2.5" aria-label="Video receipt">
          <StepLabel n={1} title="Video receipt" />
          <div
            className="grid grid-cols-3 gap-0.5 rounded-[9px] bg-nw-segment p-0.5"
            role="group"
            aria-label="Receipt"
          >
            {(
              [
                ['sent', 'Sent'],
                ['late', 'Late'],
                ['none', 'Not received'],
              ] as const
            ).map(([value, label]) => {
              const active = received
                ? inspection.receiptStatus === 'late'
                  ? value === 'late'
                  : value === 'sent'
                : receiptChoice === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  disabled={received || reviewed || !canWrite}
                  onClick={() => setReceiptChoice(value)}
                  className={cn(
                    'h-7 rounded-md text-[12.5px] font-semibold text-nw-text-2 disabled:cursor-default',
                    active &&
                      (value === 'none'
                        ? 'bg-nw-panel text-nw-text shadow-segment'
                        : 'bg-nw-accent text-nw-on-accent'),
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-lg border border-nw-border bg-nw-subtle px-3 py-2">
            <Fact
              label="Arrived"
              value={
                inspection.receivedAt ? formatIsoDate(inspection.receivedAt.slice(0, 10)) : '—'
              }
            />
            <Fact
              label="Odometer"
              value={
                odometer.data?.readingOdometer != null
                  ? `${odometer.data.readingOdometer.toLocaleString('en-US')} mi`
                  : odometer.isPending && isEnabled('pm_module')
                    ? 'Loading…'
                    : '—'
              }
            />
            <Fact label="Reviewer" value={inspection.reviewerName ?? reviewer.name} />
          </div>
          {received && inspection.source ? (
            <a
              href={inspection.source.messageUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-nw-accent-ink hover:underline"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              Open the video in Telegram · {inspection.source.chatTitle}
            </a>
          ) : null}
          {showSource ? (
            <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
              <FormField
                label="Telegram message link"
                required
                description="Paste the t.me link of the message the video came in on. Nothing is fetched from it."
              >
                <Input
                  aria-label="Telegram message link"
                  value={draft.source.messageUrl}
                  onChange={(event) =>
                    setDraft((d) => ({
                      ...d,
                      source: { ...d.source, messageUrl: event.target.value },
                    }))
                  }
                  placeholder="https://t.me/c/…"
                />
              </FormField>
              <div className="grid grid-cols-2 gap-2">
                <FormField label="Chat">
                  <Input
                    aria-label="Chat title"
                    value={draft.source.chatTitle}
                    onChange={(event) =>
                      setDraft((d) => ({
                        ...d,
                        source: { ...d.source, chatTitle: event.target.value },
                      }))
                    }
                    placeholder="NWF Drivers"
                  />
                </FormField>
                <FormField label="Sender">
                  <Input
                    aria-label="Sender"
                    value={draft.source.senderName}
                    onChange={(event) =>
                      setDraft((d) => ({
                        ...d,
                        source: { ...d.source, senderName: event.target.value },
                      }))
                    }
                    placeholder={inspection.driverName ?? 'Driver'}
                  />
                </FormField>
              </div>
            </div>
          ) : null}
          {openDefects.map((defect) => (
            <div
              key={defect.id}
              className="flex flex-col gap-1 rounded-lg border border-nw-urgent-border bg-nw-urgent-bg px-3 py-2 text-[12.5px]"
            >
              <span className="flex items-center gap-1.5 font-semibold text-nw-urgent-text">
                <StatusSymbol family="urgent" size={13} className="text-nw-urgent-icon" />
                {defect.componentName} · Open {row.ageDays} {row.ageDays === 1 ? 'day' : 'days'}
              </span>
              <span className="text-nw-urgent-text/80">
                {[...defect.history].reverse().find((h) => h.note)?.note ?? 'No action recorded.'}
              </span>
            </div>
          ))}
        </section>

        {/* STEP 2 · Component review: Good or Issue per catalog component */}
        {ctx ? (
          <section className="flex flex-col gap-2" aria-label="Component review">
            <StepLabel n={2} title="Component review" />
            <div className="overflow-hidden rounded-lg border border-nw-border">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-nw-border bg-nw-subtle text-left text-[11px] font-bold tracking-[.06em] text-nw-text-2 uppercase">
                    <th className="px-3 py-1.5">Category</th>
                    <th className="w-24 px-2 py-1.5 text-center">Good</th>
                    <th className="w-24 px-2 py-1.5 text-center">Issue</th>
                  </tr>
                </thead>
                <tbody>
                  {ctx.components.map((component) => {
                    const issue = draft.issues.some((i) => i.component === component.key);
                    const good =
                      !issue &&
                      (draft.ratings[component.id] === 'good' ||
                        (draft.othersGood && !(component.id in draft.ratings)));
                    return (
                      <tr key={component.id} className="border-b border-nw-border last:border-b-0">
                        <td className="px-3 py-1.5 font-medium text-nw-text">{component.name}</td>
                        <td className="px-2 py-1.5 text-center">
                          <Choice
                            on={good}
                            family="done"
                            label="Good"
                            disabled={reviewed || !canWrite}
                            onClick={() => markGood(component)}
                          />
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <Choice
                            on={issue}
                            family="urgent"
                            label="Issue"
                            disabled={reviewed || !canWrite}
                            onClick={() => markIssue(component)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <label className="flex items-center gap-2 border-t border-nw-border bg-nw-subtle px-3 py-2 text-xs text-nw-text-2">
                <input
                  type="checkbox"
                  checked={draft.othersGood}
                  disabled={reviewed || !canWrite}
                  onChange={(e) => setDraft((d) => ({ ...d, othersGood: e.target.checked }))}
                  className="accent-nw-accent"
                />
                Mark every unrated component Good
              </label>
            </div>
            {openDefects.length > 0 && derivedResult !== null ? (
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-muted">
                  {openDefects.length} open defect{openDefects.length === 1 ? '' : 's'} on this unit
                  — what did this video show?
                </h3>
                {openDefects.map((defect) => (
                  <DispositionPrompt
                    key={defect.id}
                    defect={defect}
                    value={draft.dispositions[defect.id] ?? null}
                    onChange={(seen) =>
                      setDraft((d) => ({
                        ...d,
                        dispositions: { ...d.dispositions, [defect.id]: seen },
                      }))
                    }
                  />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* STEP 3 · Finding & follow-up: one card per issue, with the action that follows */}
        {ctx ? (
          <section className="flex flex-col gap-3" aria-label="Finding and follow-up">
            <StepLabel n={3} title="Finding & follow-up" />
            {draft.issues.length === 0 ? (
              <p className="text-xs text-nw-text-3">
                Mark a component as Issue above to record a finding. An open finding stays
                unresolved until an action is recorded.
              </p>
            ) : null}
            {draft.issues.map((issue, index) => (
              <IssueCard
                key={issue.key}
                issue={issue}
                index={index}
                ctx={ctx}
                collapsed={collapsed.has(issue.key)}
                onToggle={() =>
                  setCollapsed((c) => {
                    const nextSet = new Set(c);
                    if (nextSet.has(issue.key)) nextSet.delete(issue.key);
                    else nextSet.add(issue.key);
                    return nextSet;
                  })
                }
                onChange={(next) => update(issue.key, next)}
                onRemove={() =>
                  setDraft((d) => ({ ...d, issues: d.issues.filter((i) => i.key !== issue.key) }))
                }
                uploadedBy={reviewer.name}
              />
            ))}
            {!reviewed && canWrite ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus />}
                onClick={() => addIssue(null)}
                className="self-start"
              >
                {draft.issues.length === 0 ? 'Add a finding' : 'Add another finding'}
              </Button>
            ) : null}
          </section>
        ) : null}
      </div>

      {/* FOOTER · On save */}
      <div className="flex flex-col gap-3 border-t border-nw-border bg-nw-raised px-5 py-3">
        {plan ? (
          <div className="flex flex-col gap-1 text-xs">
            <span className="font-semibold text-muted">On save</span>
            {derivedResult === null ? (
              <span className="text-muted">Rate the components to see what saving will do.</span>
            ) : (
              <ul className="flex flex-col gap-0.5 text-ink">
                {plan.effects.map((effect) => (
                  <li key={effect}>· {effect}</li>
                ))}
              </ul>
            )}
            {derivedResult !== null && plan.problems.length > 0 ? (
              <ul
                className="mt-1 flex flex-col gap-0.5 text-nw-warning-text"
                aria-label="Before saving"
              >
                {plan.problems.map((problem) => (
                  <li key={problem}>! {problem}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {saveError ? <Alert tone="danger" title="Not saved" description={saveError} /> : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={saving !== null}>
            Cancel
          </Button>
          {/* One Save, no Save & next (owner, 2026-10-05). */}
          <Button
            variant="primary"
            onClick={() => void save(false)}
            loading={saving === 'save'}
            disabled={!plan?.canSave || !canWrite || reviewed || saving !== null}
          >
            Save review
          </Button>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-[11px] text-nw-text-3">{label}</span>
      <span className="block truncate text-[13px] font-semibold text-nw-text">{value}</span>
    </span>
  );
}

function Choice({
  on,
  family,
  label,
  disabled,
  onClick,
}: {
  on: boolean;
  family: 'done' | 'urgent';
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] font-semibold text-nw-text-3 hover:bg-nw-hover disabled:cursor-default',
        on && family === 'done' && 'bg-nw-done-bg text-nw-done-text',
        on && family === 'urgent' && 'bg-nw-urgent-bg text-nw-urgent-text',
      )}
    >
      <StatusSymbol
        family={on ? family : 'neutral'}
        size={12}
        className={
          on
            ? family === 'done'
              ? 'text-nw-done-icon'
              : 'text-nw-urgent-icon'
            : 'text-nw-neutral-icon'
        }
      />
      {label}
    </button>
  );
}

function StepLabel({
  n,
  title,
  optional = false,
}: {
  n: number;
  title: string;
  optional?: boolean;
}) {
  return (
    <h3 className="flex items-center gap-2 text-xs font-semibold text-muted">
      <span className="inline-flex size-5 items-center justify-center rounded-full bg-nw-segment text-[11px] text-ink">
        {n}
      </span>
      {title}
      {optional ? <span className="font-normal">· optional</span> : null}
    </h3>
  );
}

function DispositionPrompt({
  defect,
  value,
  onChange,
}: {
  defect: PtiDefect;
  value: DefectDisposition | null;
  onChange: (seen: DefectDisposition) => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
      role="group"
      aria-label={defect.defectNumber}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-ink">{defect.defectNumber}</span>
        <span className="text-ink">{defect.componentName}</span>
        <StatusBadge
          status={defect.severity}
          label={PTI_DEFECT_SEVERITY_LABEL[defect.severity]}
          size="sm"
        />
        <StatusBadge status={defect.state} size="sm" />
      </div>
      <p className="text-xs text-muted">{defect.description}</p>
      <div className="grid grid-cols-3 gap-1">
        {DEFECT_DISPOSITIONS.map((seen) => {
          const on = value === seen;
          return (
            <button
              key={seen}
              type="button"
              aria-pressed={on}
              className={cn(
                'h-8 rounded-md border px-1 text-xs font-semibold transition-colors',
                on
                  ? 'border-nw-accent bg-nw-selected text-ink'
                  : 'border-line bg-surface text-secondary hover:bg-nw-hover',
              )}
              onClick={() => onChange(seen)}
            >
              {DEFECT_DISPOSITION_LABEL[seen].replace(' — propose for verify', '')}
            </button>
          );
        })}
      </div>
      {value === 'looks_fixed' ? (
        <p className="text-xs text-muted">
          Proposed for verification; the hold stays until safety verifies.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The condition matrix, never a grid: one button for the components no issue covers, and a
 * single-column list with a per-component control when the reviewer wants to say more (§6.4).
 */
