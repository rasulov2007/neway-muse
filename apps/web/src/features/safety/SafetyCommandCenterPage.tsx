import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { PermissionGate } from '@/features/admin/components/AdminKit';
import { usePermissionCheck } from '@/features/admin/useAdmin';
import {
  ArrowRight,
  Ban,
  CalendarClock,
  CircleAlert,
  FileWarning,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import type { ComplianceAuditEntry, ConsentRequest, VerificationCase } from '@neway/shared';
import { listComplianceAudit, listConsentRequests, listVerificationCases } from './compliance-api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  KpiSkeleton,
  PageHeader,
  Skeleton,
  StatusBadge,
  StatusSymbol,
  cn,
} from '@/design-system';
import { useGo } from '@/features/dashboard/links';
import { formatIsoDate, formatRelative } from '@/lib/format';
import { STAGE_LABEL, STAGE_ORDER } from './compliance-ui';
import { safetySearchSchema, type WorkbenchFocus } from './safety-search';
import { SafetyWorkbench, type WorkbenchState } from './SafetyWorkbench';
import { matchesFocus, scopeBreakdown, scopeBreakdownOfActions } from './safety-workbench';
import { useCompliance, type ComplianceBundle } from './useCompliance';

const COMPLIANCE = '/safety/compliance';
const AUDIT_PREVIEW = 8;

const OPEN_CONSENT: ReadonlyArray<ConsentRequest['status']> = ['draft', 'sent', 'viewed'];

/**
 * Safety command centre: what needs attention today, worst first. The six tiles are the filter
 * for the workbench under them, the workbench folds the engine's open items into one row per
 * requirement, and a selected record opens beside the list. Nothing here is decorative - every
 * figure is a count of rows the shared engine produced, and the same filter lists them.
 *
 * Gated on `compliance.view`. Without it the qualification file cannot be read, and the page
 * would otherwise render its tiles from nothing and say "no dispatch holds" - not a cautious
 * answer, a false one. A dispatcher who cannot see the file is told so.
 */
export function SafetyCommandCenterPage() {
  const check = usePermissionCheck('compliance.view');
  return (
    <PermissionGate check={check} permission="compliance.view" what="safety and compliance">
      <SafetyCommandCenterContent />
    </PermissionGate>
  );
}

function SafetyCommandCenterContent() {
  const go = useGo();
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => safetySearchSchema.parse(rawSearch), [rawSearch]);
  const state: WorkbenchState = {
    focus: search.focus ?? 'held',
    scope: search.scope ?? 'all',
    q: search.q ?? '',
    group: search.group ?? 'requirement',
    openRequirement: search.req ?? null,
    selectedKey: search.entity ?? null,
  };
  // Everything the workbench shows lives in the URL, so a number on the page is a link to its rows.
  const setState = (patch: Partial<WorkbenchState>) => {
    const next = { ...state, ...patch };
    void navigate({
      to: '/safety',
      search: () => {
        const out: Record<string, string> = {};
        if (next.focus !== 'held') out.focus = next.focus;
        if (next.scope !== 'all') out.scope = next.scope;
        if (next.q) out.q = next.q;
        if (next.group !== 'requirement') out.group = next.group;
        if (next.openRequirement) out.req = next.openRequirement;
        if (next.selectedKey) out.entity = next.selectedKey;
        return out;
      },
      replace: true,
      resetScroll: false,
    });
  };

  const compliance = useCompliance();
  const consents = useQuery({
    queryKey: ['consents', 'all'],
    queryFn: () => listConsentRequests(),
  });
  const cases = useQuery({
    queryKey: ['verification', 'all'],
    queryFn: () => listVerificationCases(),
  });
  const audit = useQuery({
    queryKey: ['compliance-audit', 'recent'],
    queryFn: () => listComplianceAudit({ limit: AUDIT_PREVIEW }),
  });

  const bundle = compliance.data;
  const complianceHref = `${COMPLIANCE}?tab=drivers${state.focus !== 'all' ? `&focus=${state.focus}` : ''}`;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Safety command center"
        description={
          bundle
            ? `As of ${formatIsoDate(bundle.today)} · ${bundle.byScope.driver.entities} drivers, ${bundle.byScope.truck.entities} units, ${bundle.byScope.trailer.entities} trailers under compliance`
            : 'Driver qualification, vehicle compliance and expirations, evaluated as of today.'
        }
        meta={
          bundle && bundle.summary.notDispatchable > 0 ? (
            <Badge tone="danger" size="sm">
              {bundle.summary.notDispatchable} cannot be dispatched
            </Badge>
          ) : bundle ? (
            <Badge tone="success" size="sm">
              No dispatch holds
            </Badge>
          ) : null
        }
        actions={
          <Button variant="secondary" iconRight={<ArrowRight />} onClick={() => go(complianceHref)}>
            Open compliance
          </Button>
        }
      />

      {compliance.isError ? (
        <ErrorState
          title="The compliance picture couldn't be loaded"
          description="Please try again."
          error={compliance.error}
          onRetry={() => void compliance.refetch()}
          retrying={compliance.isFetching}
        />
      ) : (
        <>
          {bundle ? (
            <AttentionStrip
              bundle={bundle}
              focus={state.focus}
              onFocus={(focus) => setState({ focus })}
            />
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6" aria-busy>
              {Array.from({ length: 6 }).map((_, i) => (
                <KpiSkeleton key={i} />
              ))}
            </div>
          )}

          {bundle ? (
            <SafetyWorkbench
              bundle={bundle}
              state={state}
              onChange={setState}
              onOpenCompliance={() => go(complianceHref)}
            />
          ) : (
            <Skeleton className="h-72" />
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
            <PipelineCard
              cases={cases.data}
              loading={cases.isPending}
              onOpen={() => go(`${COMPLIANCE}?tab=verification`)}
            />
            <ConsentCard
              consents={consents.data}
              loading={consents.isPending}
              onOpen={() => go(`${COMPLIANCE}?tab=consents`)}
            />
            <AuditCard entries={audit.data} loading={audit.isPending} />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

interface Tile {
  /** Stable selector id. Explicit, not derived from the label, so renaming copy cannot break it. */
  id: string;
  label: string;
  value: number;
  hint: string;
  /** The focus the tile switches the workbench to; none for a tile that is only a number. */
  focus: WorkbenchFocus | null;
  icon: ReactNode;
  tone?: 'urgent' | 'warning';
}

/**
 * Each tile is a saved filter on the workbench below it. The value is a count of the rows that
 * filter returns and the hint is the same rows broken down by scope, so the words under a
 * number always add up to it.
 */
function AttentionStrip({
  bundle,
  focus,
  onFocus,
}: {
  bundle: ComplianceBundle;
  focus: WorkbenchFocus;
  onFocus: (focus: WorkbenchFocus) => void;
}) {
  const s = bundle.summary;
  const d = bundle.byScope.driver;
  const held = bundle.entities.filter((e) => !e.dispatchable);
  // The same predicate the workbench filters by, so the hint's parts add up to the tile's number.
  const by = (focus: WorkbenchFocus) => bundle.actions.filter((a) => matchesFocus(a, focus));
  const tiles: Tile[] = [
    {
      id: 'held',
      label: 'Cannot be dispatched',
      value: held.length,
      hint: scopeBreakdown(held, () => true),
      focus: 'held',
      icon: <Ban />,
      tone: held.length > 0 ? 'urgent' : undefined,
    },
    {
      id: 'expiring',
      label: 'Expiring ≤ 30 days',
      value: s.expiringSoon,
      hint: scopeBreakdownOfActions(by('expiring')),
      focus: 'expiring',
      icon: <CalendarClock />,
      tone: s.expiringSoon > 0 ? 'warning' : undefined,
    },
    {
      id: 'expired',
      label: 'Expired',
      value: s.expired,
      hint: scopeBreakdownOfActions(by('expired')),
      focus: 'expired',
      icon: <CircleAlert />,
      tone: s.expired > 0 ? 'urgent' : undefined,
    },
    {
      id: 'missing',
      label: 'Missing documents',
      value: s.missing,
      hint: scopeBreakdownOfActions(by('missing')),
      focus: 'missing',
      icon: <FileWarning />,
      tone: s.missing > 0 ? 'urgent' : undefined,
    },
    {
      id: 'pending',
      label: 'Pending verification',
      value: s.pendingVerification,
      hint: `${scopeBreakdownOfActions(by('pending').filter((a) => a.item.status === 'pending_verification'))} · ${s.verificationFailed} rejected`,
      focus: 'pending',
      icon: <UserCheck />,
      tone: s.pendingVerification > 0 ? 'warning' : undefined,
    },
    {
      id: 'compliant',
      label: 'Drivers compliant',
      value: d.compliant,
      hint: `${d.atRisk} at risk · ${d.nonCompliant} non-compliant of ${d.entities}`,
      focus: null,
      icon: <ShieldCheck />,
    },
  ];
  return (
    <section
      aria-label="What needs attention"
      className="grid grid-cols-[repeat(auto-fit,minmax(178px,1fr))] gap-4"
    >
      {tiles.map((tile) => {
        const active = tile.focus !== null && tile.focus === focus;
        return (
          <button
            key={tile.id}
            type="button"
            data-testid={`tile-${tile.id}`}
            aria-pressed={tile.focus ? active : undefined}
            onClick={() => (tile.focus ? onFocus(tile.focus) : undefined)}
            className={cn(
              'flex flex-col gap-1.5 rounded-xl border border-nw-border bg-nw-panel p-4 text-left shadow-sm transition-colors hover:bg-nw-hover',
              tile.tone === 'urgent' && tile.value > 0 && 'border-nw-urgent-border',
              tile.tone === 'warning' && tile.value > 0 && 'border-nw-warning-border',
              active && 'border-nw-accent bg-nw-selected',
              tile.focus === null && 'cursor-default hover:bg-nw-panel',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-[7px] bg-nw-segment text-nw-text-2 [&_svg]:size-[15px]',
                  tile.tone === 'urgent' && tile.value > 0 && 'bg-nw-urgent-bg text-nw-urgent-icon',
                  tile.tone === 'warning' &&
                    tile.value > 0 &&
                    'bg-nw-warning-bg text-nw-warning-icon',
                )}
                aria-hidden
              >
                {tile.icon}
              </span>
              <span className="min-w-0 text-[11px] leading-[1.3] font-bold tracking-[.07em] text-nw-text-3 uppercase [text-wrap:pretty]">
                {tile.label}
              </span>
            </span>
            <span className="tabular text-[28px] leading-[1.15] font-bold tracking-[-0.02em] text-nw-text">
              {tile.value}
            </span>
            <span className="text-xs text-nw-text-3 [text-wrap:pretty]">{tile.hint}</span>
          </button>
        );
      })}
    </section>
  );
}

// ------------------------------------------------------------------------------- bottom row

function MiniRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <li
      className={cn(
        'flex items-center justify-between gap-2.5 border-b border-nw-border px-4 py-[7px] text-[13px] last:border-b-0',
        className,
      )}
    >
      {children}
    </li>
  );
}

function PipelineCard({
  cases,
  loading,
  onOpen,
}: {
  cases: VerificationCase[] | undefined;
  loading: boolean;
  onOpen: () => void;
}) {
  const counts = useMemo(() => {
    const map = new Map<VerificationCase['stage'], number>();
    for (const c of cases ?? []) map.set(c.stage, (map.get(c.stage) ?? 0) + 1);
    return map;
  }, [cases]);
  const stuck = (cases ?? []).filter(
    (c) => c.stage !== 'active' && c.steps.some((s) => s.status === 'blocked'),
  );
  return (
    <Card
      title="Where drivers are stuck"
      description={
        cases
          ? `${cases.filter((c) => c.stage !== 'active').length} in progress · ${stuck.length} blocked`
          : undefined
      }
      padding="none"
      footer={
        <button
          type="button"
          onClick={onOpen}
          className="text-sm font-semibold text-nw-accent-ink hover:underline"
        >
          Open verification pipeline →
        </button>
      }
    >
      {loading ? (
        <div className="p-(--card-padding)">
          <Skeleton variant="text" lines={5} />
        </div>
      ) : (
        <ul>
          {STAGE_ORDER.filter((s) => s !== 'active').map((stage) => {
            const n = counts.get(stage) ?? 0;
            return (
              <MiniRow key={stage}>
                <span className={n > 0 ? 'text-nw-text' : 'text-nw-text-3'}>
                  {STAGE_LABEL[stage]}
                </span>
                <span
                  className={cn('tabular font-semibold', n > 0 ? 'text-nw-text' : 'text-nw-text-3')}
                >
                  {n}
                </span>
              </MiniRow>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ConsentCard({
  consents,
  loading,
  onOpen,
}: {
  consents: ConsentRequest[] | undefined;
  loading: boolean;
  onOpen: () => void;
}) {
  const open = (consents ?? []).filter((c) => OPEN_CONSENT.includes(c.status));
  const declined = (consents ?? []).filter((c) => c.status === 'declined').length;
  const expired = (consents ?? []).filter((c) => c.status === 'expired').length;
  return (
    <Card
      title="Consent requests"
      description={consents ? `${open.length} awaiting signature` : undefined}
      padding="none"
      footer={
        <button
          type="button"
          onClick={onOpen}
          className="text-sm font-semibold text-nw-accent-ink hover:underline"
        >
          Open consent center →
        </button>
      }
    >
      {loading ? (
        <div className="p-(--card-padding)">
          <Skeleton variant="text" lines={4} />
        </div>
      ) : (
        <ul>
          {(['sent', 'viewed', 'draft'] as const).map((status) => {
            const n = open.filter((c) => c.status === status).length;
            return (
              <MiniRow key={status}>
                <StatusBadge status={status} size="sm" />
                <span className="tabular font-semibold text-nw-text">{n}</span>
              </MiniRow>
            );
          })}
          <MiniRow>
            <StatusBadge status="declined" size="sm" />
            <span
              className={cn(
                'tabular font-semibold',
                declined > 0 ? 'text-nw-urgent-text' : 'text-nw-text-3',
              )}
            >
              {declined}
            </span>
          </MiniRow>
          <MiniRow>
            <StatusBadge status="expired" size="sm" />
            <span
              className={cn(
                'tabular font-semibold',
                expired > 0 ? 'text-nw-warning-text' : 'text-nw-text-3',
              )}
            >
              {expired}
            </span>
          </MiniRow>
        </ul>
      )}
    </Card>
  );
}

function AuditCard({
  entries,
  loading,
}: {
  entries: ComplianceAuditEntry[] | undefined;
  loading: boolean;
}) {
  return (
    <Card title="Audit trail" description="Who changed what, most recent first" padding="none">
      {loading ? (
        <div className="p-(--card-padding)">
          <Skeleton variant="text" lines={6} />
        </div>
      ) : entries && entries.length > 0 ? (
        <ul>
          {entries.map((e) => {
            const family = auditFamily(e);
            return (
              <MiniRow key={e.id} className="items-start">
                <StatusSymbol
                  family={family}
                  size={13}
                  className={cn('mt-1 shrink-0', AUDIT_ICON[family])}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-nw-text">
                    {describeAudit(e)}
                  </span>
                  <span className="block truncate text-[11.5px] text-nw-text-3">
                    {e.entity.label}
                    {e.subject ? ` · ${e.subject}` : ''}
                    {e.reason ? ` — ${e.reason}` : ''}
                    {e.actorName ? ` · ${e.actorName}` : ''}
                  </span>
                </span>
                <span className="text-[11.5px] whitespace-nowrap text-nw-text-3">
                  {formatRelative(e.at)}
                </span>
              </MiniRow>
            );
          })}
        </ul>
      ) : (
        <EmptyState size="sm" title="No safety activity yet" />
      )}
    </Card>
  );
}

const AUDIT_ICON = {
  done: 'text-nw-done-icon',
  urgent: 'text-nw-urgent-icon',
  warning: 'text-nw-warning-icon',
  info: 'text-nw-neutral-icon',
} as const;

function describeAudit(e: ComplianceAuditEntry): string {
  switch (e.action) {
    case 'document_verified':
      return 'Document verified';
    case 'document_rejected':
      return 'Document rejected';
    case 'document_uploaded':
      return 'Document uploaded';
    case 'document_deleted':
      return 'Document deleted';
    case 'item_waived':
      return 'Requirement waived';
    case 'item_updated':
      return 'Requirement updated';
    case 'hold_placed':
      return 'Hold placed';
    case 'hold_released':
      return 'Hold released';
    case 'consent_sent':
      return 'Consent sent';
    case 'consent_signed':
      return 'Consent signed';
    case 'consent_declined':
      return 'Consent declined';
    case 'verification_advanced':
      return 'Verification advanced';
    case 'decision_recorded':
      return 'Decision recorded';
    default:
      return e.action;
  }
}

function auditFamily(e: ComplianceAuditEntry): keyof typeof AUDIT_ICON {
  if (
    e.action === 'document_verified' ||
    e.action === 'consent_signed' ||
    e.action === 'hold_released'
  )
    return 'done';
  if (
    e.action === 'document_rejected' ||
    e.action === 'consent_declined' ||
    e.action === 'hold_placed'
  )
    return 'urgent';
  if (e.action === 'item_waived') return 'warning';
  return 'info';
}
