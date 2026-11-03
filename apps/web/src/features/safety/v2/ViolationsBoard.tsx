import { ChevronDown, ChevronRight, CircleDollarSign, FileText, GraduationCap, Image as ImageIcon, NotebookPen, Paperclip, Pencil, Plus, Scale, Search, Send, Trash2, Upload } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  CITATION_DISPOSITIONS,
  CITATION_DISPOSITION_LABEL,
  VIOLATION_FOLLOWUP_CHOICES,
  VIOLATION_STATUS_LABEL,
  VIOLATION_TRAINING_LABEL,
  VIOLATION_TRAINING_STATUSES,
  VIOLATION_TYPE_LABEL,
  usStateLabel,
  type SafetyDocument,
  type SafetyViolation,
  type SafetyViolationCase,
  type ViolationFollowupChoice,
  type ViolationStatus,
  type ViolationTrainingStatus,
} from '@neway/shared';
import { Button, Checkbox, ConfirmDialog, DatePicker, Drawer, FormField, Input, Modal, Select, StatusBadge, StatusSymbol, Textarea, cn, type StatusSymbolFamily } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import { DocumentViewer } from '@/features/documents';
import { API_BASE_URL } from '@/lib/api';
import { openFile } from '@/lib/files';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { safetyApi, useCan, useSafetyWrite, useViolation, useViolationCases } from './api';
import { toEasternInput } from './time';
import { LoadError, Loading, money } from './ui';
import { AddViolationDialog, CATEGORY_LABEL, DeleteViolationDialog, ViolationCase, correctionBadge, issuedToLabel } from './ViolationsPage';

/**
 * Violations as the owner drew them (2026-10-13): one table, a row opens in place to the citation
 * and court, the lawyer and the follow-up, and Edit record takes the four follow-up steps -
 * Training, Status, Charge / Bonus, Notes - each saved on its own. Every icon and every
 * open/close chevron is the same across the page.
 */

const STATUS_LOOK: Record<ViolationStatus, { family: StatusSymbolFamily; className: string; icon: string }> = {
  undecided: { family: 'warning', className: 'bg-nw-warning-bg text-nw-warning-text', icon: 'text-nw-warning-icon' },
  not_charged: { family: 'moving', className: 'bg-nw-moving-bg text-nw-moving-text', icon: 'text-nw-moving-icon' },
  charge_pending: { family: 'warning', className: 'bg-nw-warning-bg text-nw-warning-text', icon: 'text-nw-warning-icon' },
  charged: { family: 'urgent', className: 'bg-nw-urgent-bg text-nw-urgent-text', icon: 'text-nw-urgent-icon' },
  bonus_pending: { family: 'warning', className: 'bg-nw-warning-bg text-nw-warning-text', icon: 'text-nw-warning-icon' },
  bonus_received: { family: 'done', className: 'bg-nw-done-bg text-nw-done-text', icon: 'text-nw-done-icon' },
  bonus_dismissed: { family: 'urgent', className: 'bg-nw-urgent-bg text-nw-urgent-text', icon: 'text-nw-urgent-icon' },
  ready_to_close: { family: 'neutral', className: 'bg-nw-neutral-bg text-nw-neutral-text', icon: 'text-nw-neutral-icon' },
  closed: { family: 'done', className: 'bg-nw-done-bg text-nw-done-text', icon: 'text-nw-done-icon' },
};

/** The mockup's pill (owner, 2026-10-13): round, soft colour, no border; the symbol stays beside the word. */
export function ViolationStatusPill({ status }: { status: ViolationStatus }) {
  const look = STATUS_LOOK[status];
  return (
    <span className={cn('inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium whitespace-nowrap', look.className)} data-testid="violation-status">
      <StatusSymbol family={look.family} size={11} className={look.icon} />
      {VIOLATION_STATUS_LABEL[status]}
    </span>
  );
}

/** "393.47E · Brake out of adjustment": the code once, even when the description repeats it. */
function violationText(v: Pick<SafetyViolation, 'code' | 'description'>): string {
  const code = v.code?.trim();
  const desc = v.description.trim();
  if (!code) return desc;
  const rest = desc.toLowerCase().startsWith(code.toLowerCase()) ? desc.slice(code.length).replace(/^[\s·:\-–—]+/, '') : desc;
  return rest ? `${code} · ${rest}` : code;
}

function TrainingCell({ status }: { status: ViolationTrainingStatus }) {
  if (status === 'completed')
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-nw-text">
        <StatusSymbol family="done" size={14} />
        Completed
      </span>
    );
  if (status === 'not_required') return <span className="text-sm text-nw-text-3">—</span>;
  return <span className="text-sm text-nw-text-2">{VIOLATION_TRAINING_LABEL[status]}</span>;
}

function moneyCell(v: Pick<SafetyViolationCase, 'moneyKind' | 'moneyCents'>): ReactNode {
  if (!v.moneyKind || !v.moneyCents) return <span className="text-nw-text-3">—</span>;
  return v.moneyKind === 'bonus' ? (
    <span className="font-semibold text-nw-done-text">+{money(v.moneyCents)} bonus</span>
  ) : (
    <span className="text-nw-text">{money(v.moneyCents)} charge</span>
  );
}

/** Work Safety still owes on the case: a decision, a charge or bonus with Accounting, or training. */
function needsAction(c: SafetyViolationCase): boolean {
  if (c.closed) return false;
  return ['undecided', 'charge_pending', 'bonus_pending'].includes(c.status) || c.trainingStatus === 'pending' || c.trainingStatus === 'in_progress';
}

/** Everything a search may hit, across every violation on the paper. */
function caseText(c: SafetyViolationCase): string {
  return [
    c.driverName,
    c.truckNumber,
    c.reportNumber,
    c.state,
    c.agency,
    c.reviewNumber,
    ...c.violations.flatMap((v) => [v.code, v.description, v.number, ...v.notes.map((n) => n.body)]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

const levelLabel = (level: number | null) => (level ? `Level ${['I', 'II', 'III', 'IV', 'V', 'VI'][level - 1] ?? level}` : null);

const DATE_RANGES = [
  { value: 'all', label: 'All dates' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'year', label: 'This year' },
] as const;

type Tab = 'all' | 'action' | 'closed';
/** Inspections, citations and warnings are kept apart (owner, 2026-10-13; warnings their own list since 2026-10-19). */
type Kind = 'inspection' | 'citation' | 'warning';
const kindOf = (v: Pick<SafetyViolationCase, 'violationType'>): Kind =>
  v.violationType === 'citation' ? 'citation' : v.violationType === 'warning' ? 'warning' : 'inspection';
const ADD_LABEL: Record<Kind, string> = { inspection: 'Add inspection', citation: 'Add citation', warning: 'Add warning' };

/** One row per paper (owner, 2026-10-21): a case and every violation on it; counts count cases. */
export function ViolationsBoard() {
  const list = useViolationCases();
  const canWrite = useCan('safety.manage');
  const [kind, setKind] = useState<Kind>('inspection');
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | ViolationStatus>('all');
  const [range, setRange] = useState<(typeof DATE_RANGES)[number]['value']>('all');
  const [asc, setAsc] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  /** The lead violation whose follow-up is being edited. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** One violation open in the full drawer. */
  const [caseId, setCaseId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const today = companyToday();
  const everything = useMemo(() => list.data ?? [], [list.data]);
  const kindCounts: Record<Kind, number> = { inspection: 0, citation: 0, warning: 0 };
  for (const c of everything) kindCounts[kindOf(c)] += 1;
  const rows = useMemo(() => everything.filter((c) => kindOf(c) === kind), [everything, kind]);
  const counts = { all: rows.length, action: rows.filter(needsAction).length, closed: rows.filter((r) => r.closed).length };
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const from =
      range === 'all' ? null : range === 'year' ? `${today.slice(0, 4)}-01-01` : new Date(Date.parse(`${today}T12:00:00Z`) - Number(range) * 86_400_000).toISOString().slice(0, 10);
    return rows
      .filter((c) => (tab === 'all' ? true : tab === 'closed' ? c.closed : needsAction(c)))
      .filter((c) => status === 'all' || c.status === status)
      .filter((c) => !from || toEasternInput(c.occurredAt).slice(0, 10) >= from)
      .filter((c) => !needle || caseText(c).includes(needle))
      .sort((a, b) => (asc ? a.occurredAt.localeCompare(b.occurredAt) : b.occurredAt.localeCompare(a.occurredAt)));
  }, [rows, tab, status, range, q, asc, today]);
  const fresh = editingId ? (everything.flatMap((c) => c.violations).find((v) => v.id === editingId) ?? null) : null;

  return (
    <div className="flex w-full flex-col gap-4">
      {adding ? <AddViolationDialog key={kind} kind={kind} open={adding} onOpenChange={setAdding} onCreated={(id) => setOpenId(id)} /> : null}
      {fresh ? <EditRecordModal violation={fresh} onClose={() => setEditingId(null)} /> : null}
      <Drawer open={Boolean(caseId)} onOpenChange={(o) => !o && setCaseId(null)} size="lg" title="Violation">
        {caseId ? <ViolationCase id={caseId} onClose={() => setCaseId(null)} /> : null}
      </Drawer>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-extrabold tracking-[-0.01em] text-nw-text">Violations</h1>
          <p className="text-sm text-nw-text-2">Inspections, citations and warnings, each with its charges and follow-up</p>
        </div>
        {canWrite ? (
          <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)} data-testid="add-violation">
            {ADD_LABEL[kind]}
          </Button>
        ) : null}
      </div>

      {/* Inspections | Citations: two lists, each created on its own (owner, 2026-10-13). */}
      <div role="tablist" aria-label="Paper" className="inline-flex w-fit gap-0.5 rounded-lg bg-nw-segment p-0.5">
        {(
          [
            ['inspection', 'Inspections'],
            ['citation', 'Citations'],
            ['warning', 'Warnings'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={kind === value}
            onClick={() => {
              setKind(value);
              setOpenId(null);
            }}
            className={cn('inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm font-semibold text-nw-text-2', kind === value && 'bg-nw-accent text-nw-on-accent shadow-sm')}
            data-testid={`kind-${value}`}
          >
            {label}
            <span className={cn('tabular rounded-full px-1.5 text-xs font-bold', kind === value ? 'bg-nw-on-accent/20' : 'bg-nw-panel text-nw-text-3')}>{list.data ? kindCounts[value] : '…'}</span>
          </button>
        ))}
      </div>

      <div role="tablist" aria-label="Violations" className="flex gap-1 border-b border-nw-border">
        {(
          [
            ['all', 'All violations'],
            ['action', 'Needs action'],
            ['closed', 'Closed'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn('-mb-px border-b-2 px-3 pb-2 text-sm font-semibold', tab === value ? 'border-nw-accent text-nw-accent-ink' : 'border-transparent text-nw-text-2 hover:text-nw-text')}
          >
            {label} ({list.data ? counts[value] : '…'})
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex h-10 min-w-[260px] flex-1 items-center gap-2 rounded-lg border border-nw-border-strong bg-nw-field px-3 text-sm text-nw-text-3 focus-within:border-nw-accent md:max-w-[420px]">
          <Search className="size-4 shrink-0" aria-hidden />
          <input
            type="search"
            aria-label="Search violations"
            placeholder="Search drivers, violations, notes…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full min-w-0 bg-transparent text-nw-text outline-none placeholder:text-nw-text-3"
          />
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <span className="text-sm text-nw-text-2">Status</span>
          <Select
            aria-label="Status"
            className="w-48"
            value={status}
            onValueChange={(v) => setStatus(v as typeof status)}
            options={[{ value: 'all', label: 'All statuses' }, ...(Object.keys(VIOLATION_STATUS_LABEL) as ViolationStatus[]).map((s) => ({ value: s, label: VIOLATION_STATUS_LABEL[s] }))]}
          />
          <span className="text-sm text-nw-text-2">Date</span>
          <Select aria-label="Date" className="w-44" value={range} onValueChange={(v) => setRange(v as typeof range)} options={[...DATE_RANGES]} />
        </div>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-nw-border bg-nw-panel">
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <LoadError error={list.error} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-sm" data-testid="violations-table">
              <thead>
                <tr className="border-b border-nw-border text-left text-[13px] font-semibold text-nw-text-2">
                  <th className="px-4 py-3">
                    <button type="button" onClick={() => setAsc((v) => !v)} className="inline-flex items-center gap-1 hover:text-nw-text" aria-label="Sort by date">
                      Date <ChevronDown aria-hidden className={cn('size-3.5 transition-transform', asc && 'rotate-180')} />
                    </button>
                  </th>
                  <th className="px-3 py-3">Driver / Unit</th>
                  <th className="px-3 py-3">Violation</th>
                  <th className="px-3 py-3">Charge / Bonus</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Training</th>
                  <th className="w-12 px-3 py-3" aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-sm text-nw-text-3">
                      {rows.length === 0 ? (kind === 'citation' ? 'No citations recorded.' : kind === 'warning' ? 'No warnings recorded.' : 'No inspections recorded.') : 'Nothing matches. Clear the search or the filters.'}
                    </td>
                  </tr>
                ) : (
                  shown.map((c) => {
                    const lead = c.violations.find((v) => v.id === c.leadId) ?? c.violations[0]!;
                    return (
                      <ViolationRow
                        key={c.id}
                        c={c}
                        open={openId === c.id}
                        onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                        onEdit={canWrite && !lead.closedAt && !lead.voidedAt ? () => setEditingId(lead.id) : null}
                        onOpenViolation={(id) => setCaseId(id)}
                      />
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {list.data ? <p className="text-right text-xs text-nw-text-3">Showing {shown.length} case{shown.length === 1 ? '' : 's'}</p> : null}
    </div>
  );
}

function ViolationRow({ c, open, onToggle, onEdit, onOpenViolation }: { c: SafetyViolationCase; open: boolean; onToggle: () => void; onEdit: (() => void) | null; onOpenViolation: (id: string) => void }) {
  const level = levelLabel(c.inspectionLevel) ?? (c.violationType ? VIOLATION_TYPE_LABEL[c.violationType] : null);
  // One violation reads as before; several read as "3 violations: 392.9A2-C (OOS), 393.47E, …" (owner, 2026-10-21).
  const text = c.violations.length === 1 ? `${violationText(c.violations[0]!)}${c.violations[0]!.oos ? ' (OOS)' : ''}` : c.summary;
  return (
    <>
      <tr className={cn('cursor-pointer border-b border-nw-border', open ? 'bg-nw-selected' : 'hover:bg-nw-hover')} onClick={onToggle} data-testid="violation-row">
        <td className="px-4 py-3 whitespace-nowrap text-nw-text">{formatIsoDate(toEasternInput(c.occurredAt).slice(0, 10))}</td>
        <td className="px-3 py-3">
          <span className="block text-nw-text">{c.driverName ?? 'No driver'}</span>
          <span className="block text-xs text-nw-text-3">{c.truckNumber ? `Unit ${c.truckNumber}` : '—'}</span>
        </td>
        <td className="max-w-[420px] px-3 py-3">
          {/* Two lines at most (owner, 2026-10-13); the whole text on hover. */}
          <span className="line-clamp-2 text-nw-text" title={c.violations.map((v) => `${violationText(v)}${v.oos ? ' (OOS)' : ''}`).join('\n')} data-testid="violation-summary">
            {text}
          </span>
          <span className="block text-xs text-nw-text-3">{[c.state, level, c.reportNumber].filter(Boolean).join(' · ') || '—'}</span>
        </td>
        <td className="px-3 py-3 whitespace-nowrap">{moneyCell(c)}</td>
        <td className="px-3 py-3">
          <ViolationStatusPill status={c.status} />
        </td>
        <td className="px-3 py-3">
          <TrainingCell status={c.trainingStatus} />
        </td>
        <td className="px-3 py-3 text-right">
          <button type="button" aria-label={open ? 'Close' : 'Open'} aria-expanded={open} className="grid size-7 place-items-center rounded-md text-nw-text-3 hover:bg-nw-hover" onClick={(e) => (e.stopPropagation(), onToggle())}>
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-nw-border bg-nw-subtle">
          <td colSpan={7} className="px-4 py-4">
            <ViolationExpanded c={c} onEdit={onEdit} onOpenViolation={onOpenViolation} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 py-1 text-sm">
      <dt className="text-nw-text-3">{label}</dt>
      <dd className="text-nw-text">{children}</dd>
    </div>
  );
}

/** Every violation on the paper, each with what is its own: rule, what it was, category, OOS, correction. */
function CaseViolations({ c, onOpenViolation }: { c: SafetyViolationCase; onOpenViolation: (id: string) => void }) {
  return (
    <section className="md:col-span-full">
      <h3 className="mb-2 text-sm font-bold text-nw-text">
        {c.violations.length === 1 ? 'Violation' : `${c.violations.length} violations on this paper`}
        {c.reviewNumber ? <span className="ml-2 text-xs font-normal text-nw-text-3">One driver review: {c.reviewNumber}</span> : null}
      </h3>
      <ul className="divide-y divide-nw-border rounded-[10px] border border-nw-border bg-nw-panel" data-testid="case-violations">
        {c.violations.map((v) => (
          <li key={v.id} className="grid items-center gap-x-4 gap-y-1 px-3 py-2 text-sm md:grid-cols-[9rem_minmax(0,1fr)_11rem_7rem_12rem_auto]" data-testid="case-violation">
            <span className="font-semibold text-nw-text">{v.code ?? '—'}</span>
            <span className="min-w-0 text-nw-text">{v.description}</span>
            <span className="text-nw-text-2">{v.category ? CATEGORY_LABEL[v.category] : 'No category'}</span>
            <span>{v.oos ? <StatusBadge status="oos" /> : <span className="text-nw-text-3">No OOS</span>}</span>
            <span>{v.closedAt ? <StatusBadge status="closed" /> : <StatusBadge status={correctionBadge(v).status} label={correctionBadge(v).label} />}</span>
            <Button size="sm" variant="ghost" icon={<FileText />} onClick={() => onOpenViolation(v.id)} aria-label={`Open ${v.number}`}>
              {v.number}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ViolationExpanded({ c, onEdit, onOpenViolation }: { c: SafetyViolationCase; onEdit: (() => void) | null; onOpenViolation: (id: string) => void }) {
  // The case's follow-up and its paper live on the lead violation.
  const v = c.violations.find((x) => x.id === c.leadId) ?? c.violations[0]!;
  const detail = useViolation(v.id);
  const docs = detail.data?.documents ?? [];
  const [viewing, setViewing] = useState<SafetyDocument | null>(null);
  // Delete = void the whole case (owner, 2026-10-21): kept on record, gone from every list.
  const canDelete = useCan('safety.manage');
  const [deleting, setDeleting] = useState(false);
  const del = useSafetyWrite(
    (reason: string) =>
      safetyApi.post<{ voided: string[]; reviewsVoided: string[] }>(`/violation-cases/${encodeURIComponent(c.id)}/void`, {
        reason,
        versions: Object.fromEntries(c.violations.map((x) => [x.id, x.version])),
      }),
    (r) => (r.voided.length === 1 ? `${r.voided[0]} deleted` : `Case deleted (${r.voided.length} violations)`),
  );
  // Court and lawyer belong to a citation; an inspection or a warning shows its papers only (owner, 2026-10-19).
  const citation = v.violationType === 'citation';
  return (
    <div className={cn('grid gap-6', citation ? 'md:grid-cols-3' : 'md:grid-cols-2')} data-testid="violation-expanded">
      <CaseViolations c={c} onOpenViolation={onOpenViolation} />
      <section className="md:border-r md:border-nw-border md:pr-6">
        {citation ? <h3 className="mb-2 text-sm font-bold text-nw-text">Citation &amp; court</h3> : null}
        {citation ? (
        <dl>
          <Pair label="Citation number">{v.citationNumber ?? v.reportNumber ?? '—'}</Pair>
          <Pair label="State">{usStateLabel(c.state) || '—'}</Pair>
          <Pair label="Court date">{v.courtDate ? formatIsoDate(v.courtDate) : '—'}</Pair>
          <Pair label="Dispute">{v.dispute ? 'Yes' : 'No'}</Pair>
          <Pair label="Court result">{v.citationDisposition === 'none' ? '—' : CITATION_DISPOSITION_LABEL[v.citationDisposition]}</Pair>
        </dl>
        ) : null}
        {/* Documents open here, in a viewer over the page (owner, 2026-10-13). */}
        <h4 className={cn('mb-2 text-xs font-semibold tracking-[.04em] text-nw-text-3 uppercase', citation && 'mt-4')}>Documents</h4>
        <div className="grid gap-2">
          {detail.isLoading ? <p className="text-sm text-nw-text-3">Loading…</p> : null}
          {docs.map((d) => (
            <DocumentCard key={d.id} doc={d} onOpen={() => setViewing(d)} canRemove={Boolean(onEdit)} />
          ))}
          {onEdit ? <UploadDocument caseId={v.id} /> : null}
        </div>
        {viewing ? (
          <DocumentViewer
            source={{ kind: 'file', file: { fileUrl: `${API_BASE_URL}/files/${encodeURIComponent(viewing.fileId)}`, fileName: viewing.fileName, mimeType: viewing.contentType } }}
            title={viewing.fileName || viewing.title}
            subtitle={`${v.number} · ${viewing.uploadedBy} · ${formatDateTime(viewing.uploadedAt)}`}
            contentType={viewing.contentType}
            fileName={viewing.fileName}
            onClose={() => setViewing(null)}
          />
        ) : null}
      </section>
      {citation ? (
      <section className="md:border-r md:border-nw-border md:pr-6">
        <h3 className="mb-2 text-sm font-bold text-nw-text">Lawyer</h3>
        <dl>
          <Pair label="Lawyer name">{v.lawyerName ?? '—'}</Pair>
          <Pair label="Phone">{v.lawyerPhone ?? '—'}</Pair>
          <Pair label="Service fee">{v.lawyerFeeCents !== null ? money(v.lawyerFeeCents) : '—'}</Pair>
          <Pair label="Payment status">{v.lawyerFeeCents !== null ? (v.lawyerPaid ? 'Paid' : 'Unpaid') : '—'}</Pair>
        </dl>
      </section>
      ) : null}
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-nw-text">Follow-up</h3>
          <div className="flex gap-2">
            {onEdit ? (
              <Button size="sm" variant="outline" icon={<Pencil />} onClick={onEdit} data-testid="violation-edit-record">
                Edit record
              </Button>
            ) : null}
            {canDelete ? (
              <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setDeleting(true)} data-testid="case-delete">
                {c.violations.length > 1 ? 'Delete case' : 'Delete'}
              </Button>
            ) : null}
          </div>
          {deleting ? (
            <DeleteViolationDialog
              open={deleting}
              onOpenChange={setDeleting}
              what={c.reportNumber ? `Report ${c.reportNumber}` : c.number}
              count={c.violations.length}
              saving={del.isPending}
              onDelete={(reason) => del.mutate(reason, { onSuccess: () => setDeleting(false) })}
            />
          ) : null}
        </div>
        <dl>
          {citation ? null : <Pair label="State">{usStateLabel(c.state) || '—'}</Pair>}
          {citation || !c.inspectionLevel ? null : <Pair label="Inspection level">{levelLabel(c.inspectionLevel)}</Pair>}
          <Pair label="Report number">{c.reportNumber ?? '—'}</Pair>
          {/* Older records named the agency; new ones record the state (owner, 2026-10-21). */}
          {c.agency ? <Pair label="Issued by">{c.agency}</Pair> : null}
          <Pair label="Issued to">{issuedToLabel(c.issuedTo)}</Pair>
          <Pair label="OOS">{c.oos ? 'Yes' : 'No'}</Pair>
          <Pair label="Driver review">{c.reviewNumber ?? '—'}</Pair>
          <Pair label="Owner">{v.ownerName ?? '—'}</Pair>
        </dl>
      </section>
    </div>
  );
}

const fileSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** One document on the violation: what it is, how big, when; a click opens it in the viewer. */
function DocumentCard({ doc, onOpen, canRemove = false }: { doc: SafetyDocument; onOpen: () => void; canRemove?: boolean }) {
  const image = doc.contentType.startsWith('image/');
  const [removing, setRemoving] = useState(false);
  // Removed, never deleted: the file leaves the violation and stays on record (owner, 2026-10-19).
  const remove = useSafetyWrite(() => safetyApi.voidDocument(doc.id, 'Removed from the violation'), 'Document removed');
  return (
    <div className="flex items-center gap-2">
    <button
      type="button"
      onClick={onOpen}
      title={`Open ${doc.fileName}`}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-[10px] border border-nw-border bg-nw-panel px-3 py-2 text-left transition-colors hover:border-nw-accent hover:bg-nw-accent-tint"
      data-testid="violation-doc"
    >
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', image ? 'bg-nw-moving-bg text-nw-moving-icon' : 'bg-nw-urgent-bg text-nw-urgent-icon')} aria-hidden>
        {image ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-nw-text group-hover:text-nw-accent-ink">{doc.fileName || doc.title}</span>
        <span className="block truncate text-xs text-nw-text-3">
          {image ? 'Image' : 'PDF'} · {fileSize(doc.sizeBytes)} · {formatDateTime(doc.uploadedAt)}
        </span>
      </span>
      <span className="shrink-0 text-xs font-semibold text-nw-accent-ink opacity-0 transition-opacity group-hover:opacity-100">Open</span>
    </button>
      {canRemove ? (
        <Button size="sm" variant="ghost" icon={<Trash2 />} aria-label={`Remove ${doc.fileName || doc.title}`} loading={remove.isPending} onClick={() => setRemoving(true)} data-testid="violation-doc-remove" />
      ) : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${doc.fileName || doc.title}?`}
        description="It leaves this violation. The file stays on record with who removed it and when."
        confirmLabel="Remove"
        tone="danger"
        onConfirm={() => remove.mutateAsync(undefined).then(() => undefined)}
      />
    </div>
  );
}

/** A document straight onto the violation from the open row: click or drop a file. */
function UploadDocument({ caseId }: { caseId: string }) {
  const attach = useSafetyWrite((file: File) => safetyApi.attach('violation', caseId, file, 'citation'), 'Document added');
  const [over, setOver] = useState(false);
  return (
    <label
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-[10px] border border-dashed px-3 py-2 transition-colors',
        over ? 'border-nw-accent bg-nw-accent-tint' : 'border-nw-border-strong bg-nw-subtle hover:border-nw-accent hover:bg-nw-accent-tint',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) attach.mutate(file);
      }}
      data-testid="violation-upload"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-nw-panel text-nw-accent-ink" aria-hidden>
        <Upload className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-nw-accent-ink">{attach.isPending ? 'Uploading…' : 'Upload document'}</span>
        <span className="block text-xs text-nw-text-3">PDF, JPG or PNG · click or drop here</span>
      </span>
      <input
        type="file"
        className="sr-only"
        accept="application/pdf,image/*"
        disabled={attach.isPending}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) attach.mutate(file);
          e.target.value = '';
        }}
      />
    </label>
  );
}

// ------------------------------------------------------------------------------- Edit record

type Section = 'training' | 'status' | 'money' | 'notes' | 'details';
const SECTIONS: { key: Section; label: string; icon: ReactNode; citationOnly?: boolean }[] = [
  { key: 'training', label: 'Training', icon: <GraduationCap /> },
  { key: 'status', label: 'Status', icon: <Scale /> },
  { key: 'money', label: 'Charge / Bonus', icon: <CircleDollarSign /> },
  { key: 'notes', label: 'Notes', icon: <NotebookPen /> },
  { key: 'details', label: 'Citation & lawyer', icon: <FileText />, citationOnly: true },
];

function EditRecordModal({ violation: v, onClose }: { violation: SafetyViolation; onClose: () => void }) {
  const [section, setSection] = useState<Section>('training');
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={`Edit record · ${v.driverName ?? v.number}`} description={[v.code, v.description].filter(Boolean).join(' · ')}>
      <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]" data-testid="violation-edit-modal">
        <nav aria-label="Edit record" className="flex flex-row gap-1 overflow-x-auto md:flex-col">
          {SECTIONS.filter((s) => !s.citationOnly || v.violationType === 'citation').map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              aria-current={section === s.key ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-semibold whitespace-nowrap [&_svg]:size-4',
                section === s.key ? 'bg-nw-accent-tint text-nw-accent-ink' : 'text-nw-text-2 hover:bg-nw-hover',
              )}
              data-testid={`edit-${s.key}`}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          {section === 'training' ? <TrainingSection v={v} /> : null}
          {section === 'status' ? <StatusSection v={v} /> : null}
          {section === 'money' ? <MoneySection v={v} /> : null}
          {section === 'notes' ? <NotesSection v={v} /> : null}
          {section === 'details' ? <DetailsSection v={v} /> : null}
        </div>
      </div>
    </Modal>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-base font-bold text-nw-text">{children}</h3>;
}

function TrainingSection({ v }: { v: SafetyViolation }) {
  const account = useAccount();
  const [status, setStatus] = useState<ViolationTrainingStatus>(v.trainingStatus);
  const [completedOn, setCompletedOn] = useState(v.trainingCompletedOn ?? companyToday());
  const [trainer, setTrainer] = useState(v.trainerName ?? account?.name ?? '');
  // More than one paper may prove the training (owner, 2026-10-19): each is a training record on the violation.
  const [proofs, setProofs] = useState<File[]>([]);
  const detail = useViolation(v.id);
  const onFile = (detail.data?.documents ?? []).filter((d) => d.kind === 'training_record');
  const save = useSafetyWrite(async () => {
    let proofFileId = v.trainingProofFileId;
    for (const proof of proofs) {
      const doc = (await safetyApi.attach('violation', v.id, proof, 'training_record', 'Training proof')) as { fileId?: string; id?: string };
      proofFileId = doc.fileId ?? doc.id ?? proofFileId;
    }
    return safetyApi.post<SafetyViolation>(`/violations/${v.id}/training`, { version: v.version, status, completedOn: status === 'completed' ? completedOn : null, trainerName: trainer.trim() || null, proofFileId });
  }, 'Training saved');
  return (
    <div>
      <SectionTitle>Training</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="Training status">
          <Select value={status} onValueChange={(x) => setStatus(x as ViolationTrainingStatus)} options={VIOLATION_TRAINING_STATUSES.map((s) => ({ value: s, label: VIOLATION_TRAINING_LABEL[s] }))} />
        </FormField>
        <FormField label="Completed on">
          <DatePicker aria-label="Completed on" value={completedOn} onIsoChange={setCompletedOn} disabled={status !== 'completed'} />
        </FormField>
        <FormField label="Trainer">
          <Input value={trainer} onChange={(e) => setTrainer(e.target.value)} placeholder="Who trained the driver" />
        </FormField>
        <FormField label="Proof (optional, one or more files)" className="sm:col-span-3">
          <div className="flex flex-col gap-2">
            {onFile.map((d) => (
              <DocumentCard key={d.id} doc={d} onOpen={() => openFile({ fileId: d.fileId, fileName: d.fileName })} canRemove />
            ))}
            {proofs.map((f, i) => (
              <span key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm text-nw-text">
                <Paperclip aria-hidden className="size-4 text-nw-text-3" />
                {f.name}
                <span className="text-xs text-nw-text-3">· uploads on save</span>
                <button type="button" className="text-xs text-nw-urgent-text hover:underline" onClick={() => setProofs((ps) => ps.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </span>
            ))}
            <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border border-nw-border bg-nw-panel px-3 py-2 text-sm text-nw-accent-ink hover:bg-nw-hover">
              <Paperclip aria-hidden className="size-4" />
              {onFile.length || proofs.length ? 'Add another file' : 'Upload files (optional)'}
              <input
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  setProofs((ps) => [...ps, ...picked]);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </FormField>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)} data-testid="save-training">
          Save training
        </Button>
      </div>
    </div>
  );
}

// The six the owner listed (2026-10-19), in that order.
const STATUS_CHOICES: { value: ViolationFollowupChoice; label: string }[] = VIOLATION_FOLLOWUP_CHOICES.map((c) => ({ value: c, label: VIOLATION_STATUS_LABEL[c] }));

function StatusSection({ v }: { v: SafetyViolation }) {
  const [status, setStatus] = useState<ViolationFollowupChoice | ''>(v.followupStatus === 'undecided' ? '' : v.followupStatus);
  const save = useSafetyWrite(() => safetyApi.post<SafetyViolation>(`/violations/${v.id}/status`, { version: v.version, status }), 'Status saved');
  return (
    <div>
      <SectionTitle>Status</SectionTitle>
      <FormField label="Status">
        <Select value={status} placeholder="Choose the status" onValueChange={(x) => setStatus(x as ViolationFollowupChoice)} options={STATUS_CHOICES} />
      </FormField>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-nw-text-3">
        <StatusSymbol family="info" size={12} />
        "Waiting Accounting" moves on by itself once Accounting approves. Now: <ViolationStatusPill status={v.status} />
      </p>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" disabled={!status} loading={save.isPending} onClick={() => save.mutate(undefined)} data-testid="save-status">
          Save status
        </Button>
      </div>
    </div>
  );
}

function MoneySection({ v }: { v: SafetyViolation }) {
  const [kind, setKind] = useState<'charge' | 'bonus'>(v.moneyKind ?? 'charge');
  const [amount, setAmount] = useState(v.moneyCents ? (v.moneyCents / 100).toFixed(2) : '');
  const [reason, setReason] = useState(v.moneyReason ?? v.description);
  const cents = Math.round(Number(amount.replace(/[$,\s]/g, '')) * 100);
  const sent = v.moneyTxId && v.moneyTxState !== 'void';
  const send = useSafetyWrite(() => safetyApi.post<SafetyViolation>(`/violations/${v.id}/money`, { version: v.version, kind, amountCents: cents, party: 'driver', reason: reason.trim() }), 'Sent to Accounting');
  const segment = (on: boolean) =>
    cn('inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-semibold', on ? 'border-nw-accent bg-nw-accent-tint text-nw-accent-ink' : 'border-nw-border bg-nw-subtle text-nw-text-2 hover:bg-nw-hover');
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-bold text-nw-text">{kind === 'charge' ? 'Add charge' : 'Add bonus'}</h3>
        <div role="radiogroup" aria-label="Charge or bonus" className="flex gap-1">
          <button type="button" role="radio" aria-checked={kind === 'charge'} className={segment(kind === 'charge')} onClick={() => setKind('charge')} disabled={Boolean(sent)}>
            Charge
          </button>
          <button type="button" role="radio" aria-checked={kind === 'bonus'} className={segment(kind === 'bonus')} onClick={() => setKind('bonus')} disabled={Boolean(sent)}>
            Bonus
          </button>
        </div>
      </div>
      {sent ? (
        <p className="rounded-md border border-nw-border bg-nw-subtle px-3 py-2 text-sm text-nw-text-2">
          {v.moneyKind === 'bonus' ? 'Bonus' : 'Charge'} of {money(v.moneyCents ?? 0)} sent to Accounting · {v.moneyTxState === 'approved' || v.moneyTxState === 'applied' ? 'approved' : 'waiting for Accounting'}. To change it, Accounting voids it first.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Amount">
              <Input prefix="$" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </FormField>
            <FormField label={kind === 'charge' ? 'Charged to' : 'Recipient'}>
              <Select value="driver" onValueChange={() => undefined} options={[{ value: 'driver', label: v.driverName ? `Driver · ${v.driverName}` : 'Driver' }]} />
            </FormField>
            <FormField label="Reason">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === 'charge' ? 'Tire air leak' : 'Safe driving'} />
            </FormField>
          </div>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-nw-text-3">
            <StatusSymbol family="info" size={12} />
            Sending does not take money at once: Accounting reviews it first.
          </p>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" icon={<Send />} disabled={!(cents > 0) || reason.trim().length < 2 || !v.driverId} loading={send.isPending} onClick={() => send.mutate(undefined)} data-testid="send-to-accounting">
              Send to Accounting
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function NotesSection({ v }: { v: SafetyViolation }) {
  const [body, setBody] = useState('');
  const save = useSafetyWrite(() => safetyApi.post<SafetyViolation>(`/violations/${v.id}/notes`, { version: v.version, body: body.trim() }), 'Note saved');
  return (
    <div>
      <SectionTitle>Notes</SectionTitle>
      <FormField label="Add note">
        <Textarea rows={3} value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} placeholder="Driver bilan gaplashildi…" />
      </FormField>
      <div className="mt-3 flex justify-end">
        <Button variant="primary" disabled={!body.trim()} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => setBody('') })} data-testid="save-note">
          Save note
        </Button>
      </div>
      <h4 className="mt-4 mb-2 text-sm font-semibold text-nw-text-2">Saved notes</h4>
      {v.notes.length === 0 ? (
        <p className="text-sm text-nw-text-3">No notes yet.</p>
      ) : (
        <ul className="divide-y divide-nw-border rounded-md border border-nw-border">
          {v.notes.map((n) => (
            <li key={n.id} className="px-3 py-2">
              <p className="text-sm text-nw-text">{n.body}</p>
              <p className="text-xs text-nw-text-3">
                {n.by} · {new Date(n.at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetailsSection({ v }: { v: SafetyViolation }) {
  const [f, setF] = useState({
    citationNumber: v.citationNumber ?? '',
    state: v.state ?? '',
    inspectionLevel: v.inspectionLevel ? String(v.inspectionLevel) : '',
    courtDate: v.courtDate ?? '',
    dispute: v.dispute,
    citationDisposition: v.citationDisposition,
    lawyerName: v.lawyerName ?? '',
    lawyerPhone: v.lawyerPhone ?? '',
    lawyerFee: v.lawyerFeeCents !== null ? (v.lawyerFeeCents / 100).toFixed(2) : '',
    lawyerPaid: v.lawyerPaid,
  });
  const set = <K extends keyof typeof f>(k: K, val: (typeof f)[K]) => setF((p) => ({ ...p, [k]: val }));
  const save = useSafetyWrite(
    () =>
      safetyApi.patch<SafetyViolation>(`/violations/${v.id}`, {
        version: v.version,
        citationNumber: f.citationNumber.trim() || null,
        state: f.state.trim().toUpperCase() || null,
        inspectionLevel: f.inspectionLevel ? Number(f.inspectionLevel) : null,
        courtDate: f.courtDate || null,
        dispute: f.dispute,
        citationDisposition: f.citationDisposition,
        lawyerName: f.lawyerName.trim() || null,
        lawyerPhone: f.lawyerPhone.trim() || null,
        lawyerFeeCents: f.lawyerFee.trim() ? Math.round(Number(f.lawyerFee.replace(/[$,\s]/g, '')) * 100) : null,
        lawyerPaid: f.lawyerPaid,
      }),
    'Saved',
  );
  return (
    <div>
      <SectionTitle>Citation &amp; court</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="Citation number">
          <Input value={f.citationNumber} onChange={(e) => set('citationNumber', e.target.value)} />
        </FormField>
        <FormField label="State">
          <Input value={f.state} maxLength={2} onChange={(e) => set('state', e.target.value)} placeholder="NJ" />
        </FormField>
        <FormField label="Inspection level">
          <Select value={f.inspectionLevel} placeholder="—" onValueChange={(x) => set('inspectionLevel', x)} options={['1', '2', '3', '4', '5', '6'].map((n) => ({ value: n, label: `Level ${['I', 'II', 'III', 'IV', 'V', 'VI'][Number(n) - 1]}` }))} />
        </FormField>
        <FormField label="Court date">
          <DatePicker aria-label="Court date" value={f.courtDate} onIsoChange={(x) => set('courtDate', x)} />
        </FormField>
        <FormField label="Court result">
          <Select value={f.citationDisposition} onValueChange={(x) => set('citationDisposition', x as typeof f.citationDisposition)} options={CITATION_DISPOSITIONS.map((c) => ({ value: c, label: CITATION_DISPOSITION_LABEL[c] }))} />
        </FormField>
        <div className="flex items-end pb-2">
          <Checkbox checked={f.dispute} onCheckedChange={(x) => set('dispute', x === true)} label="Disputed" />
        </div>
      </div>
      <h3 className="mt-5 mb-3 text-base font-bold text-nw-text">Lawyer</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="Lawyer name">
          <Input value={f.lawyerName} onChange={(e) => set('lawyerName', e.target.value)} />
        </FormField>
        <FormField label="Phone">
          <Input type="tel" value={f.lawyerPhone} onChange={(e) => set('lawyerPhone', e.target.value)} />
        </FormField>
        <FormField label="Service fee">
          <Input prefix="$" inputMode="decimal" value={f.lawyerFee} onChange={(e) => set('lawyerFee', e.target.value)} />
        </FormField>
        <div className="flex items-end pb-2">
          <Checkbox checked={f.lawyerPaid} onCheckedChange={(x) => set('lawyerPaid', x === true)} label="Fee paid" />
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)} data-testid="save-details">
          Save
        </Button>
      </div>
    </div>
  );
}
