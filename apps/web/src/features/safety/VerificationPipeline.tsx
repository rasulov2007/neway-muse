import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, ChevronRight, CircleAlert, Clock, Minus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type {
  VerificationCase,
  VerificationDecision,
  VerificationStage,
  VerificationStep,
} from '@neway/shared';
import { listVerificationCases, recordVerificationDecision, startVerificationReview } from './compliance-api';
import { Link } from '@tanstack/react-router';
import {
  Alert,
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusBadge,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { useHiringCases } from '@/features/hr/useHiring';
import { formatDate, formatDateTime } from '@/lib/format';
import { STAGE_LABEL, STAGE_ORDER } from './compliance-ui';
import { useInvalidateCompliance } from './useCompliance';

export interface VerificationPipelineProps {
  caseId: string | undefined;
  onOpenCase: (id: string | undefined) => void;
}

/**
 * Recruiting → documents → consent → screening → verification → safety review → decision →
 * active, with every case placed at the first stage it cannot clear and the exact step holding
 * it there. The point of the view is the word "stuck": nobody should have to open a file to learn
 * why a driver has not started.
 */
export function VerificationPipeline({ caseId, onOpenCase }: VerificationPipelineProps) {
  const cases = useQuery({
    queryKey: ['verification', 'all'],
    queryFn: () => listVerificationCases(),
  });
  const byStage = useMemo(() => {
    const map = new Map<VerificationStage, VerificationCase[]>(STAGE_ORDER.map((s) => [s, []]));
    for (const c of cases.data ?? []) map.get(c.stage)?.push(c);
    return map;
  }, [cases.data]);
  const open = (cases.data ?? []).find((c) => c.id === caseId) ?? null;

  if (cases.isError) {
    return (
      <ErrorState
        title="Verification cases couldn't be loaded"
        error={cases.error}
        onRetry={() => void cases.refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        padding="none"
        title="Pipeline"
        description="Where each driver in onboarding is, and how many are stuck at each stage."
      >
        <ol
          className="scroll-quiet flex overflow-x-auto px-(--card-padding) py-4"
          aria-label="Verification stages"
        >
          {STAGE_ORDER.map((stage, index) => {
            const list = byStage.get(stage) ?? [];
            const blocked = list.filter((c) =>
              c.steps.some((s) => s.stage === stage && s.status === 'blocked'),
            ).length;
            return (
              <li key={stage} className="flex items-center">
                <div
                  className={cn(
                    'min-w-36 rounded-lg border px-3 py-2.5',
                    list.length > 0
                      ? 'border-primary-border bg-primary-soft/40'
                      : 'border-line bg-surface',
                  )}
                >
                  <div className="eyebrow">
                    {STAGE_LABEL[stage]}
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span
                      className={cn(
                        'tabular text-xl font-semibold',
                        list.length > 0 ? 'text-ink' : 'text-faint',
                      )}
                    >
                      {list.length}
                    </span>
                    {blocked > 0 ? (
                      <span className="text-xs font-medium text-danger-text">
                        {blocked} blocked
                      </span>
                    ) : null}
                  </div>
                </div>
                {index < STAGE_ORDER.length - 1 ? (
                  <ChevronRight aria-hidden className="mx-1 size-4 shrink-0 text-faint" />
                ) : null}
              </li>
            );
          })}
        </ol>
      </Card>

      <Card
        padding="none"
        title="Drivers in verification"
        description={
          cases.data
            ? `${cases.data.filter((c) => c.stage !== 'active').length} open · ${cases.data.filter((c) => c.stage === 'active').length} activated`
            : undefined
        }
        data-testid="verification-cases"
      >
        {cases.isPending ? (
          <div className="p-(--card-padding)">
            <Skeleton variant="text" lines={6} />
          </div>
        ) : (cases.data ?? []).length === 0 ? (
          <EmptyState
            title="No drivers in verification"
            description="New hires appear here from recruiting."
          />
        ) : (
          <ul className="divide-y divide-line-soft">
            {[...(cases.data ?? [])]
              .sort(
                (a, b) =>
                  STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
                  b.daysInStage - a.daysInStage,
              )
              .map((c) => (
                <CaseRow key={c.id} item={c} onOpen={() => onOpenCase(c.id)} />
              ))}
          </ul>
        )}
      </Card>

      <CaseDrawer item={open} onClose={() => onOpenCase(undefined)} />
    </div>
  );
}

function stuckStep(c: VerificationCase): VerificationStep | undefined {
  return (
    c.steps.find((s) => s.status === 'blocked') ?? c.steps.find((s) => s.status === 'in_progress')
  );
}

function CaseRow({ item, onOpen }: { item: VerificationCase; onOpen: () => void }) {
  const stuck = stuckStep(item);
  return (
    <li className="grid grid-cols-1 gap-x-4 gap-y-1 px-(--card-padding) py-2.5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,2fr)_auto] md:items-center">
      <button type="button" onClick={onOpen} className="min-w-0 text-left">
        <span className="block truncate text-sm font-medium text-primary-text hover:underline">
          {item.driverName}
        </span>
        <span className="block text-xs text-muted">
          Opened {formatDate(item.openedAt)} · owner {item.ownerName}
        </span>
      </button>
      <div className="min-w-0">
        <Badge tone={item.stage === 'active' ? 'success' : 'info'} size="sm">
          {STAGE_LABEL[item.stage]}
        </Badge>
        <span
          className={cn(
            'ml-2 text-xs',
            item.daysInStage > 7 && item.stage !== 'active'
              ? 'font-medium text-warning-text'
              : 'text-muted',
          )}
        >
          {item.daysInStage}d in stage
        </span>
      </div>
      <div className="min-w-0 text-xs">
        {item.decision ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={item.decision} size="sm" />
            {item.conditions.length > 0 ? (
              <span className="text-secondary">{item.conditions.join('; ')}</span>
            ) : null}
          </span>
        ) : stuck ? (
          <span
            className={cn(
              'flex items-start gap-1.5',
              stuck.status === 'blocked' ? 'text-danger-text' : 'text-secondary',
            )}
          >
            {stuck.status === 'blocked' ? (
              <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <Clock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span>
              <span className="font-medium">{stuck.label}</span>
              {stuck.blocker ? ` — ${stuck.blocker}` : ' in progress'}
            </span>
          </span>
        ) : (
          <span className="text-muted">Ready for the next stage</span>
        )}
      </div>
      <Button variant="ghost" size="sm" iconRight={<ChevronRight />} onClick={onOpen}>
        Open
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------

function CaseDrawer({ item, onClose }: { item: VerificationCase | null; onClose: () => void }) {
  return (
    <Drawer
      open={item !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      title={item?.driverName ?? ''}
      description={
        item
          ? `Verification case ${item.id} · opened ${formatDate(item.openedAt)} · owner ${item.ownerName}`
          : undefined
      }
      headerExtra={
        item ? (
          <Badge tone={item.stage === 'active' ? 'success' : 'info'} size="sm">
            {STAGE_LABEL[item.stage]}
          </Badge>
        ) : null
      }
      bodyClassName="bg-app"
    >
      {item ? <CaseBody item={item} /> : null}
    </Drawer>
  );
}

const STEP_ICON: Record<VerificationStep['status'], ReactNode> = {
  complete: <Check aria-hidden className="size-3.5 text-success-text" />,
  in_progress: <Clock aria-hidden className="size-3.5 text-info-text" />,
  blocked: <CircleAlert aria-hidden className="size-3.5 text-danger-text" />,
  not_started: <Minus aria-hidden className="size-3.5 text-faint" />,
};

function CaseBody({ item }: { item: VerificationCase }) {
  const grouped = STAGE_ORDER.filter((s) => s !== 'active').map((stage) => ({
    stage,
    steps: item.steps.filter((s) => s.stage === stage),
  }));
  // The hiring case that wraps this one, when the candidate came through recruiting: the DOT
  // application, the recruiter and the funnel history live on their candidate record.
  const hiring = useHiringCases();
  const wrapper = (hiring.data ?? []).find((c) => c.verificationCaseId === item.id) ?? null;
  return (
    <div className="flex flex-col gap-4">
      {wrapper?.applicantId ? (
        <Alert
          tone="info"
          title="This driver is a recruiting candidate"
          description={`${wrapper.recruiterName ?? 'Recruiting'} owns the front of the funnel; the application, offer and ticket are on the candidate record.`}
          actions={
            <Link
              to="/hr/recruiting/$candidateId"
              params={{ candidateId: wrapper.applicantId }}
              className="text-sm font-medium text-primary-text hover:underline"
            >
              Open candidate record
            </Link>
          }
        />
      ) : null}
      {item.decision ? (
        <div
          className={cn(
            'rounded-lg border px-4 py-3 text-sm',
            item.decision === 'rejected'
              ? 'border-danger-border bg-danger-soft'
              : item.decision === 'conditional'
                ? 'border-warning-border bg-warning-soft'
                : 'border-success-border bg-success-soft',
          )}
        >
          <div className="flex items-center gap-2">
            <StatusBadge status={item.decision} size="sm" />
            <span className="text-ink">
              {item.decisionAt ? formatDateTime(item.decisionAt) : ''} by {item.decisionBy}
            </span>
          </div>
          {item.conditions.length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-secondary">
              {item.conditions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
          {item.decisionNote ? <p className="mt-1 text-secondary">{item.decisionNote}</p> : null}
        </div>
      ) : null}

      <section className="rounded-lg border border-line bg-surface">
        {grouped.map(({ stage, steps }) =>
          steps.length === 0 ? null : (
            <div key={stage} className="border-b border-line-soft last:border-b-0">
              <h3
                className={cn(
                  'eyebrow px-4 py-2',
                  stage === item.stage && 'bg-primary-soft/40 text-primary-text',
                )}
              >
                {STAGE_LABEL[stage]}
                {stage === item.stage ? ' · current' : ''}
              </h3>
              <ul className="divide-y divide-line-soft">
                {steps.map((step) => (
                  <li key={step.key} className="flex items-start gap-2.5 px-4 py-2">
                    <span className="mt-0.5 shrink-0">{STEP_ICON[step.status]}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            'text-sm',
                            step.status === 'not_started' ? 'text-muted' : 'text-ink',
                          )}
                        >
                          {step.label}
                        </span>
                        <StatusBadge status={step.status} size="sm" />
                      </div>
                      {step.blocker ? (
                        <p className="mt-0.5 text-xs text-danger-text">{step.blocker}</p>
                      ) : null}
                      {step.completedAt ? (
                        <p className="mt-0.5 text-xs text-muted">
                          Completed {formatDateTime(step.completedAt)}
                          {step.completedBy ? ` by ${step.completedBy}` : ''}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ),
        )}
      </section>

      {item.decision === null ? <DecisionForm item={item} /> : null}
    </div>
  );
}

/**
 * What the server will ask for before an approval (owner, 2026-10-02): every step before the
 * safety review complete, and the review started. A rejection never waits. The server refuses the
 * same thing with the same list; this only draws it before anyone presses the button.
 */
export function missingForApproval(item: VerificationCase): string[] {
  const missing = item.steps
    .filter((s) => s.stage !== 'safety_review' && s.stage !== 'decision' && s.status !== 'complete')
    .map((s) => (s.blocker ? `${s.label}: ${s.blocker}` : `${s.label} is not complete`));
  if (item.safetyReviewStatus === 'not_started') missing.push('Safety review has not been started');
  return missing;
}

function DecisionForm({ item }: { item: VerificationCase }) {
  const { toast } = useToast();
  const invalidate = useInvalidateCompliance();
  const [decision, setDecision] = useState<VerificationDecision>(() =>
    missingForApproval(item).length === 0 ? 'approved' : 'rejected',
  );
  const [conditions, setConditions] = useState('');
  const [note, setNote] = useState('');
  const missing = missingForApproval(item);
  const canApprove = missing.length === 0;
  const chosen: VerificationDecision = !canApprove && decision !== 'rejected' ? 'rejected' : decision;
  const failed = (error: unknown) =>
    toast({ tone: 'danger', title: 'Not recorded', description: error instanceof Error ? error.message : String(error) });
  const start = useMutation({
    mutationFn: () => startVerificationReview(item.id),
    onSuccess: async () => {
      await invalidate();
      toast({ tone: 'success', title: `Safety review started for ${item.driverName}` });
    },
    onError: failed,
  });
  const record = useMutation({
    mutationFn: () =>
      recordVerificationDecision(item.id, {
        decision: chosen,
        conditions: conditions
          .split('\n')
          .map((c) => c.trim())
          .filter(Boolean),
        note: note.trim() || null,
      }),
    onSuccess: async () => {
      await invalidate();
      toast({
        tone: chosen === 'rejected' ? 'warning' : 'success',
        title: `${item.driverName}: ${chosen}`,
      });
    },
    onError: failed,
  });
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-md font-bold text-ink">Safety decision</h3>
        {item.safetyReviewStatus === 'not_started' ? (
          <Button variant="primary" size="sm" loading={start.isPending} onClick={() => start.mutate()}>
            Start safety review
          </Button>
        ) : (
          <StatusBadge status="in_progress" label="Safety review in progress" size="sm" />
        )}
      </div>
      {!canApprove ? (
        <div className="mt-1 text-xs text-warning-text">
          <p>
            {missing.length} item{missing.length === 1 ? ' is' : 's are'} not ready. Approval (full or conditional) is
            disabled until every mandatory check is reviewed and accepted and the safety review is started; a rejection
            can be recorded at any time.
          </p>
          <ul className="mt-1 list-disc pl-5">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted">
          Every mandatory check is reviewed and accepted. Record the outcome with the conditions, if any.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {(['approved', 'conditional', 'rejected'] as const).map((d) => (
          <Button
            key={d}
            variant={chosen === d ? 'primary' : 'secondary'}
            size="sm"
            disabled={d !== 'rejected' && !canApprove}
            onClick={() => setDecision(d)}
            aria-pressed={chosen === d}
          >
            {d.charAt(0).toUpperCase() + d.slice(1)}
          </Button>
        ))}
      </div>
      {chosen === 'conditional' ? (
        <label className="mt-3 flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Conditions (one per line)</span>
          <Textarea
            rows={3}
            value={conditions}
            onChange={(e) => setConditions(e.target.value)}
            placeholder="e.g. Ride-along evaluation within the first 30 days"
          />
        </label>
      ) : null}
      <label className="mt-3 flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Note</span>
        <Textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional; recorded in the audit trail"
        />
      </label>
      <div className="mt-3 flex justify-end">
        <Button
          variant={chosen === 'rejected' ? 'danger' : 'primary'}
          loading={record.isPending}
          disabled={chosen === 'conditional' && conditions.trim().length === 0}
          onClick={() => record.mutate()}
        >
          Record decision
        </Button>
      </div>
    </section>
  );
}
