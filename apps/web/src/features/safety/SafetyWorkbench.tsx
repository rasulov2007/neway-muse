import type {
  ComplianceAction,
  ComplianceScope,
  EntityCompliance,
  EvaluatedItem,
} from '@neway/shared';
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Container,
  Search,
  Truck,
  Upload,
  User,
  X,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Modal,
  Select,
  StatusBadge,
  StatusSymbol,
  cn,
  type StatusSymbolFamily,
} from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import {
  ROLE_LABEL,
  SCOPE_LABEL,
  daysLabel,
  deadlineDays,
  entityKey,
  openItems,
} from './compliance-ui';
import { WaiveDialog } from './EntityComplianceDrawer';
import type { WorkbenchFocus, WorkbenchGroup, WorkbenchScope } from './safety-search';
import {
  EXPIRING_WITHIN_DAYS,
  EXTRA_FOCUS_LABEL,
  FOCUS_SEGMENTS,
  complianceFamily,
  entitiesOf,
  filterActions,
  focusCounts,
  groupByRequirement,
  type RequirementGroup,
} from './safety-workbench';
import { UploadDocumentDialog } from './UploadDocumentDialog';
import type { ComplianceBundle } from './useCompliance';

const CHIP_CAP = 14;

const SCOPE_ICON: Record<ComplianceScope, ReactNode> = {
  driver: <User className="size-3.5" aria-hidden />,
  truck: <Truck className="size-3.5" aria-hidden />,
  trailer: <Container className="size-3.5" aria-hidden />,
  company: <Container className="size-3.5" aria-hidden />,
};

export interface WorkbenchState {
  focus: WorkbenchFocus;
  scope: WorkbenchScope;
  q: string;
  group: WorkbenchGroup;
  openRequirement: string | null;
  selectedKey: string | null;
}

export interface SafetyWorkbenchProps {
  bundle: ComplianceBundle;
  state: WorkbenchState;
  onChange: (patch: Partial<WorkbenchState>) => void;
  /** The compliance page for the current focus, for the header link. */
  onOpenCompliance: () => void;
}

/**
 * The workbench (handoff §2–§3): one panel where the focus, the scope and the search narrow the
 * engine's action queue, shown either folded into one row per requirement - the fix for 150 rows
 * that say the same six things - or one row per record with the record's file beside it.
 *
 * Every count is a count of the rows the same filter produces; the segments, the list and the
 * tiles above cannot disagree.
 */
export function SafetyWorkbench({
  bundle,
  state,
  onChange,
  onOpenCompliance,
}: SafetyWorkbenchProps) {
  const filtered = useMemo(
    () => filterActions(bundle.actions, { focus: state.focus, scope: state.scope, q: state.q }),
    [bundle.actions, state.focus, state.scope, state.q],
  );
  const counts = useMemo(
    () => focusCounts(bundle.actions, state.scope, state.q),
    [bundle.actions, state.scope, state.q],
  );
  const groups = useMemo(
    () => groupByRequirement(filtered, bundle.entities, bundle.requirements, bundle.today),
    [filtered, bundle.entities, bundle.requirements, bundle.today],
  );
  const entities = useMemo(() => entitiesOf(filtered, bundle.byKey), [filtered, bundle.byKey]);
  const selected = state.selectedKey ? (bundle.byKey.get(state.selectedKey) ?? null) : null;
  const extraFocus = EXTRA_FOCUS_LABEL[state.focus];

  return (
    <section
      aria-label="Workbench"
      data-testid="action-queue"
      className="min-w-0 rounded-[10px] border border-nw-border bg-nw-panel"
    >
      {/* Toolbar: focus segments, search, scope, group-by */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nw-border px-3 py-2.5">
        <div
          className="flex gap-0.5 rounded-[9px] bg-nw-segment p-0.5"
          role="group"
          aria-label="Focus"
        >
          {FOCUS_SEGMENTS.map(({ focus, label }) => (
            <Segment
              key={focus}
              active={state.focus === focus}
              onClick={() => onChange({ focus })}
              count={counts[focus]}
            >
              {label}
            </Segment>
          ))}
          {extraFocus ? (
            <Segment active onClick={() => undefined} count={counts[state.focus]}>
              {extraFocus}
            </Segment>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-9 w-[220px] items-center gap-2 rounded-lg border border-nw-border-strong bg-nw-field px-2.5 text-[13.5px] text-nw-text-3 focus-within:border-nw-accent">
            <Search className="size-3.5 shrink-0" aria-hidden />
            <input
              type="search"
              aria-label="Search driver, unit or requirement"
              placeholder="Driver, unit or requirement"
              value={state.q}
              onChange={(e) => onChange({ q: e.target.value })}
              className="w-full min-w-0 bg-transparent text-nw-text outline-none placeholder:text-nw-text-3"
            />
          </label>
          <Select
            aria-label="Scope"
            className="w-32"
            options={[
              { value: 'all', label: 'All scopes' },
              { value: 'driver', label: 'Drivers' },
              { value: 'truck', label: 'Units' },
              { value: 'trailer', label: 'Trailers' },
            ]}
            value={state.scope}
            onValueChange={(scope) => onChange({ scope: scope as WorkbenchScope })}
          />
          <div
            className="flex gap-0.5 rounded-[9px] bg-nw-segment p-0.5"
            role="group"
            aria-label="Group by"
          >
            <Segment
              active={state.group === 'requirement'}
              onClick={() => onChange({ group: 'requirement' })}
            >
              By requirement
            </Segment>
            <Segment
              active={state.group === 'entity'}
              onClick={() => onChange({ group: 'entity' })}
            >
              By record
            </Segment>
          </div>
        </div>
      </div>

      {state.group === 'requirement' ? (
        <div data-testid="held-table">
          <div className="grid min-h-[34px] grid-cols-[14px_minmax(200px,1.8fr)_150px_180px_minmax(130px,1fr)_104px] items-center gap-3.5 border-b border-nw-border bg-nw-subtle px-4 py-2 text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase max-[1200px]:grid-cols-[14px_minmax(170px,1.7fr)_140px_160px_104px] max-[920px]:grid-cols-[14px_minmax(0,1fr)_120px_96px]">
            <span />
            <span>Requirement</span>
            <span>Open</span>
            <span className="max-[920px]:hidden">Catalog compliance</span>
            <span className="max-[1200px]:hidden">Owner</span>
            <span>Deadline</span>
          </div>
          {groups.length === 0 ? (
            <Empty />
          ) : (
            groups.map((group) => (
              <RequirementRow
                key={group.code}
                group={group}
                open={state.openRequirement === group.code}
                onToggle={() =>
                  onChange({
                    openRequirement: state.openRequirement === group.code ? null : group.code,
                  })
                }
                onPick={(key) => onChange({ selectedKey: key, group: 'entity' })}
              />
            ))
          )}
          <Footer
            count={filtered.length}
            records={entities.length}
            onOpenCompliance={onOpenCompliance}
          />
        </div>
      ) : (
        <div
          className="grid grid-cols-[minmax(0,1fr)_344px] items-start max-[1200px]:grid-cols-1"
          data-testid="held-table"
        >
          <div className="min-w-0 border-r border-nw-border max-[1200px]:border-r-0 max-[1200px]:border-b">
            <div className="grid min-h-[34px] grid-cols-[minmax(150px,1.3fr)_minmax(190px,1.6fr)_minmax(170px,1.6fr)_minmax(120px,1fr)_104px_14px] items-center gap-3 border-b border-nw-border bg-nw-subtle px-4 py-2 text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase max-[1200px]:grid-cols-[minmax(130px,1fr)_minmax(240px,2fr)_minmax(110px,.9fr)_104px_14px] max-[920px]:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_96px_14px]">
              <span>Driver / unit</span>
              <span>Reason</span>
              <span className="max-[1200px]:hidden">Required action</span>
              <span className="max-[920px]:hidden">Owner</span>
              <span>Deadline</span>
              <span />
            </div>
            {entities.length === 0 ? (
              <Empty />
            ) : (
              entities.map((entity) => (
                <EntityRow
                  key={entityKey(entity.scope, entity.entityId)}
                  entity={entity}
                  focus={state.focus}
                  today={bundle.today}
                  selected={state.selectedKey === entityKey(entity.scope, entity.entityId)}
                  onPick={() => onChange({ selectedKey: entityKey(entity.scope, entity.entityId) })}
                />
              ))
            )}
            <Footer
              count={filtered.length}
              records={entities.length}
              onOpenCompliance={onOpenCompliance}
            />
          </div>
          <EntityPanel
            entity={selected}
            today={bundle.today}
            onClose={() => onChange({ selectedKey: null })}
          />
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------ toolbar

function Segment({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-semibold whitespace-nowrap text-nw-text-2 hover:text-nw-text',
        active && 'bg-nw-panel text-nw-text shadow-segment',
      )}
    >
      {children}
      {count !== undefined ? (
        <span className="tabular text-[11px] font-bold opacity-70">{count}</span>
      ) : null}
    </button>
  );
}

function Empty() {
  return (
    <div className="px-6 py-14 text-center">
      <div className="text-sm font-bold text-nw-text">Nothing matches</div>
      <p className="mt-1 text-[12.5px] text-nw-text-3">Clear the search or widen the scope.</p>
    </div>
  );
}

function Footer({
  count,
  records,
  onOpenCompliance,
}: {
  count: number;
  records: number;
  onOpenCompliance: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-nw-border px-4 py-2.5 text-[12.5px] text-nw-text-3">
      <span className="tabular">
        {count} open {count === 1 ? 'item' : 'items'} on {records}{' '}
        {records === 1 ? 'record' : 'records'}
      </span>
      <button
        type="button"
        onClick={onOpenCompliance}
        className="inline-flex items-center gap-1 font-semibold text-nw-accent-ink hover:underline"
      >
        Open in compliance
        <ArrowRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------------------ by requirement

function RequirementRow({
  group,
  open,
  onToggle,
  onPick,
}: {
  group: RequirementGroup;
  open: boolean;
  onToggle: () => void;
  onPick: (key: string) => void;
}) {
  const [bulk, setBulk] = useState(false);
  const family: StatusSymbolFamily = group.blocking > 0 ? 'urgent' : 'warning';
  const meter = complianceFamily(group.compliance.pct);
  return (
    <div data-testid="requirement-group" className="border-b border-nw-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          'grid w-full grid-cols-[14px_minmax(200px,1.8fr)_150px_180px_minmax(130px,1fr)_104px] items-center gap-3.5 px-4 py-2.5 text-left text-[13px] text-nw-text-2 hover:bg-nw-hover max-[1200px]:grid-cols-[14px_minmax(170px,1.7fr)_140px_160px_104px] max-[920px]:grid-cols-[14px_minmax(0,1fr)_120px_96px]',
          open && 'bg-nw-hover',
        )}
      >
        {open ? (
          <ChevronDown className="size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden />
        )}
        <span className="flex min-w-0 items-center gap-2 font-semibold text-nw-text">
          <StatusSymbol
            family={family}
            size={13}
            className={family === 'urgent' ? 'text-nw-urgent-icon' : 'text-nw-warning-icon'}
          />
          <span className="min-w-0">{group.name}</span>
          <span className="text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase">
            {SCOPE_LABEL[group.scope]}
          </span>
        </span>
        <span className="tabular whitespace-nowrap">
          <b className="font-bold text-nw-text">{group.rows.length}</b> open
          {group.blocking > 0 ? (
            <em className="font-semibold text-nw-urgent-text not-italic">
              {' '}
              · {group.blocking} blocking
            </em>
          ) : null}
        </span>
        <span className="flex items-center gap-2 max-[920px]:hidden">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-nw-track">
            <i
              className={cn(
                'block h-full rounded-full',
                meter === 'done'
                  ? 'bg-nw-done-icon'
                  : meter === 'warning'
                    ? 'bg-nw-warning-icon'
                    : 'bg-nw-urgent-icon',
              )}
              style={{ width: `${group.compliance.pct ?? 0}%` }}
            />
          </span>
          <span className="tabular w-[34px] text-right text-xs font-semibold">
            {group.compliance.pct === null ? '—' : `${group.compliance.pct}%`}
          </span>
        </span>
        <span className="truncate max-[1200px]:hidden">{ROLE_LABEL[group.owner]}</span>
        <span
          className={cn(
            'tabular font-semibold',
            group.soonestDays !== null && group.soonestDays <= 0 && 'text-nw-urgent-text',
          )}
        >
          {daysLabel(group.soonestDays)}
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2.5 px-4 pb-3.5 pl-11">
          <div className="flex items-center justify-between gap-2.5 rounded-lg border border-nw-border bg-nw-subtle px-2.5 py-2 text-[13px] text-nw-text">
            <span>{group.requiredAction}</span>
            <Button variant="secondary" size="sm" icon={<Upload />} onClick={() => setBulk(true)}>
              Bulk upload · {group.rows.length}
            </Button>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(186px,1fr))] gap-1.5">
            {group.rows.slice(0, CHIP_CAP).map((action) => (
              <EntityChip key={action.key} action={action} onPick={onPick} />
            ))}
            {group.rows.length > CHIP_CAP ? (
              <span className="flex h-8 items-center justify-center rounded-lg border border-nw-border bg-nw-subtle text-[13px] font-semibold text-nw-text-3">
                +{group.rows.length - CHIP_CAP} more
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {bulk ? <BulkUploadDialog group={group} onClose={() => setBulk(false)} /> : null}
    </div>
  );
}

function EntityChip({
  action,
  onPick,
}: {
  action: ComplianceAction;
  onPick: (key: string) => void;
}) {
  const family = statusFamily(action.item.status);
  return (
    <button
      type="button"
      onClick={() => onPick(entityKey(action.item.scope, action.item.entityId))}
      className="flex h-8 items-center gap-1.5 rounded-lg border border-nw-border bg-nw-panel px-2.5 text-[13px] font-semibold text-nw-text-2 hover:border-nw-border-strong hover:bg-nw-hover"
    >
      {SCOPE_ICON[action.item.scope]}
      <span className="min-w-0 flex-1 truncate text-left text-nw-text">
        {action.item.entityLabel}
      </span>
      <StatusSymbol family={family} size={12} className={FAMILY_ICON[family]} />
    </button>
  );
}

/**
 * Bulk upload: the requirement's records, each with its own upload, ticked off as the engine
 * re-evaluates them. The document dialog takes one owner at a time - a file belongs to one
 * driver or unit - so "bulk" is a queue, not a multi-select.
 */
function BulkUploadDialog({ group, onClose }: { group: RequirementGroup; onClose: () => void }) {
  const [uploading, setUploading] = useState<EvaluatedItem | null>(null);
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="md"
      title={`Bulk upload · ${group.name}`}
      description={group.requiredAction}
    >
      <ul className="divide-y divide-nw-border">
        {group.rows.map((action) => (
          <li key={action.key} className="flex items-center justify-between gap-3 py-2 text-[13px]">
            <span className="flex min-w-0 items-center gap-2">
              {SCOPE_ICON[action.item.scope]}
              <span className="truncate font-semibold text-nw-text">{action.item.entityLabel}</span>
              <StatusBadge status={action.item.status} size="sm" />
            </span>
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload />}
              onClick={() => setUploading(action.item)}
            >
              Upload…
            </Button>
          </li>
        ))}
      </ul>
      {uploading ? (
        <UploadDocumentDialog
          item={uploading}
          ownerType={uploading.scope}
          open
          onOpenChange={(o) => (o ? undefined : setUploading(null))}
        />
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------- by record

/** The item the row leads with: the first one the focus is about, worst first. */
function leadItem(entity: EntityCompliance, focus: WorkbenchFocus): EvaluatedItem | undefined {
  const open = openItems(entity);
  const inFocus = open.find((item) => {
    switch (focus) {
      case 'held':
        return item.blocksDispatch;
      case 'expiring':
        return (
          item.status === 'expiring' &&
          item.daysRemaining !== null &&
          item.daysRemaining <= EXPIRING_WITHIN_DAYS
        );
      case 'expired':
        return item.status === 'expired';
      case 'missing':
        return item.status === 'missing';
      case 'pending':
        return item.status === 'pending_verification' || item.status === 'verification_failed';
      case 'failed':
        return item.status === 'verification_failed';
      case 'critical':
        return item.severity === 'critical';
      default:
        return true;
    }
  });
  return inFocus ?? open[0];
}

function EntityRow({
  entity,
  focus,
  today,
  selected,
  onPick,
}: {
  entity: EntityCompliance;
  focus: WorkbenchFocus;
  today: string;
  selected: boolean;
  onPick: () => void;
}) {
  const first = leadItem(entity, focus);
  const open = openItems(entity);
  const dueIn = first ? deadlineDays(first, today) : null;
  return (
    <button
      type="button"
      role="row"
      aria-selected={selected}
      onClick={onPick}
      className={cn(
        'grid min-h-[54px] w-full grid-cols-[minmax(150px,1.3fr)_minmax(190px,1.6fr)_minmax(170px,1.6fr)_minmax(120px,1fr)_104px_14px] items-center gap-3 border-b border-nw-border px-4 py-2 text-left text-[13px] text-nw-text-2 hover:bg-nw-hover max-[1200px]:grid-cols-[minmax(130px,1fr)_minmax(240px,2fr)_minmax(110px,.9fr)_104px_14px] max-[920px]:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_96px_14px]',
        selected && 'bg-nw-selected shadow-[inset_2px_0_0_var(--color-nw-accent)]',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {SCOPE_ICON[entity.scope]}
        <span className="min-w-0">
          <span className="block text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase">
            {SCOPE_LABEL[entity.scope]}
          </span>
          <span className="block truncate text-[13px] font-semibold text-nw-text">
            {entity.entityLabel}
          </span>
        </span>
      </span>
      <span className="flex min-w-0 flex-col items-start gap-0.5 text-nw-text">
        <span className="max-w-full text-[13px] font-semibold">
          {first?.requirementName ?? '—'}
        </span>
        <span className="flex items-center gap-1.5">
          {first ? (
            <>
              <span className="max-[1200px]:hidden">
                <StatusBadge status={first.status} size="sm" />
              </span>
              <span className="min-[1201px]:hidden">
                <StatusSymbol
                  family={statusFamily(first.status)}
                  size={13}
                  className={FAMILY_ICON[statusFamily(first.status)]}
                />
              </span>
            </>
          ) : null}
          {open.length > 1 ? (
            <span className="rounded-full bg-nw-segment px-1.5 py-0.5 text-[11px] font-bold text-nw-text-3">
              +{open.length - 1}
            </span>
          ) : null}
        </span>
      </span>
      <span className="truncate max-[1200px]:hidden">{first?.requiredAction ?? ''}</span>
      <span className="truncate max-[920px]:hidden">{first ? ROLE_LABEL[first.owner] : '—'}</span>
      <span className="whitespace-nowrap">
        <span
          className={cn(
            'tabular block font-semibold',
            dueIn !== null && dueIn <= 0 ? 'text-nw-urgent-text' : 'text-nw-text',
          )}
        >
          {daysLabel(dueIn)}
        </span>
        {first?.deadline ? (
          <span className="block text-[11.5px] text-nw-text-3">
            {formatIsoDate(first.deadline)}
          </span>
        ) : null}
      </span>
      <ChevronRight className="size-3.5" aria-hidden />
    </button>
  );
}

// -------------------------------------------------------------------------------- the panel

/**
 * The selected record's file, beside the list rather than over the page (§3): what it is, whether
 * it can be dispatched and why not, every open item with its upload, what is on file.
 */
function EntityPanel({
  entity,
  today,
  onClose,
}: {
  entity: EntityCompliance | null;
  today: string;
  onClose: () => void;
}) {
  const [uploading, setUploading] = useState<EvaluatedItem | null>(null);
  const [waiving, setWaiving] = useState<EvaluatedItem | null>(null);
  if (!entity) {
    return (
      <aside
        className="sticky top-0 flex flex-col items-center justify-center gap-1.5 px-7 py-16 text-center"
        aria-label="Selected record"
      >
        <StatusSymbol family="neutral" size={20} className="text-nw-neutral-icon" />
        <div className="text-sm font-bold text-nw-text">Nothing selected</div>
        <p className="max-w-[32ch] text-[12.5px] text-nw-text-3">
          Pick a driver, unit or trailer to see its qualification file, what is blocking dispatch
          and the next action.
        </p>
      </aside>
    );
  }
  const open = openItems(entity);
  const onFile = entity.items.filter((i) => i.requiredAction === null);
  const waivable = open.find((i) => i.itemId && i.status !== 'waived') ?? null;
  return (
    <aside className="sticky top-0 min-w-0" aria-label={`${entity.entityLabel} file`}>
      <div className="flex items-start justify-between gap-2.5 px-4 py-3.5">
        <div className="min-w-0">
          <span className="block text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase">
            {SCOPE_LABEL[entity.scope]}
          </span>
          <div className="mt-0.5 text-base leading-tight font-bold text-nw-text">
            {entity.entityLabel}
          </div>
          <div className="text-[11.5px] text-nw-text-3">
            {entity.counts.total} requirements apply
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-8 place-items-center rounded-lg text-nw-text-2 hover:bg-nw-hover"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2.5 border-y border-nw-border bg-nw-subtle px-4 py-2.5">
        <div className="flex flex-col items-start gap-1">
          <span className="text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase">
            Dispatch
          </span>
          {entity.dispatchable ? (
            <Badge tone="success" size="sm">
              Clear
            </Badge>
          ) : (
            <Badge tone="danger" size="sm">
              Hold
            </Badge>
          )}
        </div>
        <div className="flex flex-col items-start gap-1">
          <span className="text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase">
            State
          </span>
          <span className="text-[13px] font-semibold text-nw-text">
            {entity.state === 'non_compliant'
              ? 'Non-compliant'
              : entity.state === 'at_risk'
                ? 'At risk'
                : 'Compliant'}
          </span>
        </div>
        <div className="flex flex-col items-start gap-1">
          <span className="text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase">
            Satisfied
          </span>
          <span className="tabular text-[13px] font-semibold text-nw-text">
            {entity.counts.satisfied}/{entity.counts.total}
          </span>
        </div>
      </div>
      {!entity.dispatchable ? (
        <div className="flex items-start gap-2 border-b border-nw-urgent-border bg-nw-urgent-bg px-4 py-2.5 text-[12.5px] font-semibold text-nw-urgent-text">
          <StatusSymbol family="urgent" size={13} className="mt-0.5 text-nw-urgent-icon" />
          <span>Cannot be dispatched — {entity.gateReasons.join(', ')}</span>
        </div>
      ) : null}
      <div className="flex flex-col gap-2.5 border-b border-nw-border px-4 py-3">
        <span className="text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase">
          Open items
        </span>
        {open.length === 0 ? (
          <p className="text-[12.5px] text-nw-text-3">Nothing is open.</p>
        ) : null}
        {open.map((item) => {
          const dueIn = deadlineDays(item, today);
          return (
            <div
              key={item.requirementCode}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-2"
            >
              <StatusBadge status={item.status} size="sm" />
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-nw-text">{item.requirementName}</div>
                <div className="text-[11.5px] text-nw-text-3">
                  {item.reasons[0]} · owner {ROLE_LABEL[item.owner]}
                </div>
              </div>
              <div className="text-right text-xs font-semibold whitespace-nowrap">
                <span
                  className={cn(
                    'tabular block',
                    dueIn !== null && dueIn <= 0 ? 'text-nw-urgent-text' : 'text-nw-text',
                  )}
                >
                  {daysLabel(dueIn)}
                </span>
                {item.deadline ? (
                  <span className="block text-[11.5px] font-medium text-nw-text-3">
                    {formatIsoDate(item.deadline)}
                  </span>
                ) : null}
              </div>
              <div className="col-start-3">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Upload />}
                  onClick={() => setUploading(item)}
                >
                  Upload
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {onFile.length > 0 ? (
        <div className="flex flex-col gap-2 border-b border-nw-border px-4 py-3">
          <span className="text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase">
            On file
          </span>
          {onFile.map((item) => (
            <div
              key={item.requirementCode}
              className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5"
            >
              <StatusBadge status={item.status} size="sm" />
              <span className="truncate text-[11.5px] text-nw-text-3">{item.requirementName}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2 px-4 py-3">
        {/* The hold is the engine's verdict; it lifts when the blocking items are answered. So the
            first action is the upload for the worst open item, never a button that pretends to
            release a hold by hand. */}
        {open[0] ? (
          <Button
            variant="primary"
            className="flex-1"
            icon={<Upload />}
            onClick={() => setUploading(open[0] as EvaluatedItem)}
          >
            {entity.dispatchable ? 'Upload document' : 'Clear the hold'}
          </Button>
        ) : null}
        {waivable ? (
          <Button variant="secondary" onClick={() => setWaiving(waivable)}>
            Waive…
          </Button>
        ) : null}
      </div>
      {uploading ? (
        <UploadDocumentDialog
          item={uploading}
          ownerType={entity.scope}
          open
          onOpenChange={(o) => (o ? undefined : setUploading(null))}
        />
      ) : null}
      {waiving?.itemId ? (
        <WaiveDialog
          itemId={waiving.itemId}
          name={waiving.requirementName}
          open
          onOpenChange={(o) => (o ? undefined : setWaiving(null))}
        />
      ) : null}
    </aside>
  );
}

// ------------------------------------------------------------------------------------ helpers

const FAMILY_ICON: Record<StatusSymbolFamily, string> = {
  urgent: 'text-nw-urgent-icon',
  warning: 'text-nw-warning-icon',
  done: 'text-nw-done-icon',
  moving: 'text-nw-moving-icon',
  neutral: 'text-nw-neutral-icon',
  inShop: 'text-nw-neutral-icon',
  info: 'text-nw-neutral-icon',
};

/** The status family the engine's statuses wear, the same map the badges use. */
function statusFamily(status: EvaluatedItem['status']): StatusSymbolFamily {
  switch (status) {
    case 'missing':
    case 'expired':
    case 'verification_failed':
      return 'urgent';
    case 'expiring':
    case 'pending_verification':
      return 'warning';
    case 'verified':
    case 'valid':
      return 'done';
    default:
      return 'neutral';
  }
}
