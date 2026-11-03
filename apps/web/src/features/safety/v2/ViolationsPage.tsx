import { useSearch } from '@tanstack/react-router';
import { FileText, Plus, Trash2, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  CITATION_DISPOSITIONS,
  CITATION_DISPOSITION_LABEL,
  CORRECTION_STATUSES,
  CORRECTION_STATUS_LABEL,
  DATAQS_STATUSES,
  DATAQS_STATUS_LABEL,
  US_STATE_CODES,
  US_STATE_NAMES,
  VIOLATION_CATEGORIES,
  VIOLATION_TYPES,
  VIOLATION_TYPE_LABEL,
  issuedToFromParties,
  issuedToLabel as sharedIssuedToLabel,
  issuedToParties,
  usStateLabel,
  type SafetyDocumentKind,
  type SafetyViolation,
  type SafetyViolationCase,
  type ViolationCategory,
  type ViolationIssuedParty,
  type ViolationIssuedTo,
  type ViolationType,
} from '@neway/shared';
import { Badge, Button, Checkbox, Combobox, DatePicker, Drawer, FormField, Input, Modal, Select, StatusBadge, Textarea } from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import { safetyApi, useCan, useRoadsideInspections, useSafetyPickers, useSafetyWrite, useViolation, useViolations } from './api';
import { easternNowInput, fromEasternInput, toEasternInput } from './time';
import { DocumentsCard, FactList, LoadError, Loading, NextActionCard, OwnerCell, Panel, SafetyTitle, Sub, TimelineCard, WorkEditor, money, td, th } from './ui';

export const CATEGORY_LABEL: Record<ViolationCategory, string> = {
  unsafe_driving: 'Unsafe driving',
  hos: 'Hours of service',
  driver_fitness: 'Driver fitness',
  controlled_substances: 'Controlled substances',
  vehicle_maintenance: 'Vehicle maintenance',
  hazmat: 'Hazmat',
  crash: 'Crash indicator',
};

/** The correction track as a badge: the word the mockup uses, on the family it draws. */
/** Who received it ("Driver", "Carrier", "Driver and Carrier"), or a dash on a warning that does not say. */
export function issuedToLabel(issuedTo: SafetyViolation['issuedTo']): string {
  return sharedIssuedToLabel(issuedTo);
}

/**
 * "Issued to (who received it)": Driver and Carrier as two ticks, so a paper issued to both is
 * recorded as both (owner, 2026-10-24). Stored as one value: driver, carrier or both.
 */
export function IssuedToPicker({ value, onChange, optional }: { value: ViolationIssuedTo | null; onChange: (next: ViolationIssuedTo | null) => void; optional?: boolean }) {
  const parties = issuedToParties(value);
  const toggle = (party: ViolationIssuedParty, on: boolean) =>
    onChange(issuedToFromParties(on ? [...parties, party] : parties.filter((p) => p !== party)));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-4" role="group" aria-label="Issued to">
        <Checkbox checked={parties.includes('driver')} onCheckedChange={(x) => toggle('driver', x === true)} label="Driver" />
        <Checkbox checked={parties.includes('carrier')} onCheckedChange={(x) => toggle('carrier', x === true)} label="Carrier" />
      </div>
      <span className="text-xs text-muted">{value ? `Issued to: ${sharedIssuedToLabel(value)}` : optional ? 'Not recorded (optional)' : 'Tick one or both'}</span>
    </div>
  );
}

export function correctionBadge(v: Pick<SafetyViolation, 'correctionStatus'>) {
  const map: Record<string, { status: string; label: string }> = {
    not_required: { status: 'not_required', label: 'No correction needed' },
    open: { status: 'correction_open', label: 'Repair proof needed' },
    repaired: { status: 'repaired', label: 'Repaired' },
    proof_submitted: { status: 'proof_submitted', label: 'Evidence submitted' },
    certified: { status: 'certified', label: 'Closed — corrected' },
  };
  return map[v.correctionStatus] ?? { status: 'unknown', label: v.correctionStatus };
}

/** Violations, as the owner's mockup draws them: filters, one row each, the case in a drawer. */
export function ViolationsV2Page() {
  const list = useViolations();
  const canWrite = useCan('safety.manage');
  const search = useSearch({ strict: false }) as { open?: string };
  const [openId, setOpenId] = useState<string | null>(search.open ?? null);
  const [adding, setAdding] = useState(false);
  const [driver, setDriver] = useState('all');
  const [truck, setTruck] = useState('all');
  const [agency, setAgency] = useState('all');
  const [status, setStatus] = useState('all');
  const [category, setCategory] = useState('all');
  const rows = list.data ?? [];
  const opts = useMemo(
    () => ({
      drivers: [...new Map(rows.filter((r) => r.driverId).map((r) => [r.driverId as string, r.driverName ?? ''])).entries()],
      trucks: [...new Map(rows.filter((r) => r.truckId).map((r) => [r.truckId as string, r.truckNumber ?? ''])).entries()],
      agencies: [...new Set(rows.map((r) => r.agency))],
    }),
    [rows],
  );
  const shown = rows.filter(
    (r) =>
      (driver === 'all' || r.driverId === driver) &&
      (truck === 'all' || r.truckId === truck) &&
      (agency === 'all' || r.agency === agency) &&
      (status === 'all' || (status === 'open' ? !r.closedAt : Boolean(r.closedAt))) &&
      (category === 'all' || r.category === category),
  );

  return (
    <div className="flex w-full flex-col gap-4">
      {adding ? <AddViolationDialog open={adding} onOpenChange={setAdding} onCreated={setOpenId} /> : null}
      <Drawer open={Boolean(openId)} onOpenChange={(o) => !o && setOpenId(null)} size="lg" title="Violation details">
        {openId ? <ViolationCase id={openId} onClose={() => setOpenId(null)} /> : null}
      </Drawer>
      <div className="text-xs text-nw-text-3">Safety &amp; Compliance / Violations</div>
      <SafetyTitle
        title="Violations"
        subtitle="Track citations, out-of-service orders, and corrective actions."
        actions={
          canWrite ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add violation
            </Button>
          ) : null
        }
      />
      <Panel>
        <div className="grid items-end gap-3 md:grid-cols-[repeat(5,minmax(0,1fr))_auto]">
          <FormField label="Driver">
            <Select value={driver} onValueChange={setDriver} options={[{ value: 'all', label: 'All drivers' }, ...opts.drivers.map(([id, n]) => ({ value: id, label: n }))]} />
          </FormField>
          <FormField label="Truck">
            <Select value={truck} onValueChange={setTruck} options={[{ value: 'all', label: 'All trucks' }, ...opts.trucks.map(([id, n]) => ({ value: id, label: n }))]} />
          </FormField>
          <FormField label="Issuing agency">
            <Select value={agency} onValueChange={setAgency} options={[{ value: 'all', label: 'All agencies' }, ...opts.agencies.map((a) => ({ value: a, label: a }))]} />
          </FormField>
          <FormField label="Status">
            <Select value={status} onValueChange={setStatus} options={[{ value: 'all', label: 'All statuses' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]} />
          </FormField>
          <FormField label="Category">
            <Select value={category} onValueChange={setCategory} options={[{ value: 'all', label: 'All categories' }, ...VIOLATION_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]} />
          </FormField>
          <Button
            variant="outline"
            onClick={() => {
              setDriver('all');
              setTruck('all');
              setAgency('all');
              setStatus('all');
              setCategory('all');
            }}
          >
            Clear filters
          </Button>
        </div>
      </Panel>
      <Panel padding="none">
        {list.isLoading ? <Loading /> : list.error ? <LoadError error={list.error} /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] border-collapse">
              <thead className="border-b border-nw-border bg-nw-subtle">
                <tr>
                  <th className={th}>Date &amp; report</th>
                  <th className={th}>Violation</th>
                  <th className={th}>Issued to</th>
                  <th className={th}>Driver</th>
                  <th className={th}>Truck</th>
                  <th className={th}>Issued by</th>
                  <th className={th}>OOS</th>
                  <th className={th}>Correction status</th>
                  <th className={th}>Next action</th>
                  <th className={th}>Owner</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nw-border">
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-10 text-center text-sm text-nw-text-3">
                      {rows.length === 0 ? 'No violations recorded.' : 'No violations match these filters.'}
                    </td>
                  </tr>
                ) : (
                  shown.map((v) => {
                    const c = correctionBadge(v);
                    return (
                      <tr key={v.id} className={openId === v.id ? 'bg-nw-selected' : 'hover:bg-nw-hover'}>
                        <td className={`${td} whitespace-nowrap`}>
                          {formatIsoDate(v.occurredAt.slice(0, 10))}
                          <button type="button" data-row-open className="block cursor-pointer font-semibold text-nw-accent-ink underline underline-offset-2" onClick={() => setOpenId(v.id)}>
                            {v.number}
                          </button>
                          {v.isTest ? <Badge size="sm">Test</Badge> : null}
                        </td>
                        <td className={td}>
                          {v.description}
                          {v.code ? <Sub>{v.code}</Sub> : null}
                        </td>
                        <td className={td}>{issuedToLabel(v.issuedTo)}</td>
                        <td className={td}>{v.driverName ?? <span className="text-nw-text-3">None</span>}</td>
                        <td className={td}>{v.truckNumber ?? <span className="text-nw-text-3">None</span>}</td>
                        <td className={td}>{v.agency}</td>
                        <td className={td}>
                          <StatusBadge status={v.oos ? 'oos' : 'no_oos'} />
                        </td>
                        <td className={td}>{v.closedAt ? <StatusBadge status="closed" /> : <StatusBadge status={c.status} label={c.label} />}</td>
                        <td className={td}>{v.nextAction ?? <span className="text-nw-text-3">None</span>}</td>
                        <td className={td}>
                          <OwnerCell name={v.ownerName} />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {list.data ? (
        <div className="text-right text-xs text-nw-text-3">
          Showing {shown.length} of {rows.length} violations
        </div>
      ) : null}
    </div>
  );
}

const EVIDENCE_ROWS: { kind: SafetyDocumentKind; label: string }[] = [
  { kind: 'repair_evidence', label: 'Repair evidence' },
  { kind: 'carrier_certification', label: 'Carrier certification' },
  { kind: 'return_report', label: 'Return report (if requested)' },
  { kind: 'dataqs', label: 'DataQs filing' },
];

/** One violation in the drawer: the facts, its three tracks, the evidence, the next action. */
export function ViolationCase({ id, onClose }: { id: string; onClose?: () => void }) {
  const detail = useViolation(id);
  const canWrite = useCan('safety.manage');
  const [work, setWork] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const v = detail.data?.record;
  const patch = useSafetyWrite((body: Record<string, unknown>) => safetyApi.patch<SafetyViolation>(`/violations/${id}`, { version: v?.version, ...body }), 'Saved');
  const close = useSafetyWrite(() => safetyApi.post<SafetyViolation>(`/violations/${id}/close`, { version: v?.version }), 'Violation closed');
  const voidIt = useSafetyWrite((reason: string) => safetyApi.post<SafetyViolation>(`/violations/${id}/void`, { version: v?.version, reason }), 'Violation deleted');
  if (detail.isLoading) return <Loading />;
  if (detail.error || !v || !detail.data) return <LoadError error={detail.error ?? new Error('Not found')} />;
  const editable = canWrite && !v.closedAt && !v.voidedAt;
  const docs = detail.data.documents;
  return (
    <div className="grid gap-4">
      {work ? <WorkEditor open={work} onOpenChange={setWork} initial={v} saving={patch.isPending} onSave={(b) => patch.mutate(b, { onSuccess: () => setWork(false) })} /> : null}
      <DeleteViolationDialog open={voiding} onOpenChange={setVoiding} what={v.number} saving={voidIt.isPending} onDelete={(r) => voidIt.mutate(r, { onSuccess: () => (setVoiding(false), onClose?.()) })} />
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[19px] font-extrabold text-nw-text">Violation {v.number}</h2>
        <div className="flex items-center gap-2">
          {v.closedAt ? <StatusBadge status="closed" /> : v.voidedAt ? <StatusBadge status="void" /> : <StatusBadge status={v.oos ? 'oos' : 'open'} label={v.oos ? 'Vehicle OOS' : 'Open'} />}
          {/* Save at the top right (owner, 2026-10-12): it submits the correction, citation and DataQs form below. */}
          {editable ? (
            <Button type="submit" form={`violation-tracks-${v.id}`} variant="primary" size="sm" loading={patch.isPending} data-testid="violation-save">
              Save
            </Button>
          ) : null}
        </div>
      </div>
      <FactList
        rows={[
          ['Report number', v.reportNumber ?? v.number],
          ['Date', formatIsoDate(toEasternInput(v.occurredAt).slice(0, 10))],
          ['Type', v.violationType ? VIOLATION_TYPE_LABEL[v.violationType] : '—'],
          ['Violation', v.description],
          ['Rule / source code', v.code ?? 'As reported'],
          ['Category', v.category ? CATEGORY_LABEL[v.category] : 'Not set'],
          ['Issued to', issuedToLabel(v.issuedTo)],
          ['Driver', v.driverName ?? 'None'],
          ['Truck', v.truckNumber ?? 'None'],
          ['State', usStateLabel(v.state) || '—'],
          // Older records named the agency; new ones record the state (owner, 2026-10-21).
          ...(v.agency ? ([['Issuing agency', v.agency]] as [string, string][]) : []),
          ['Fine amount', v.fineNotApplicable ? 'N/A' : v.fineCents ? money(v.fineCents) : 'Not recorded'],
          ['Inspection', v.inspectionNumber ?? 'Recorded manually'],
          ['Correction deadline', v.correctionDueOn ? formatIsoDate(v.correctionDueOn) : 'None'],
          ['Driver review', v.reviewNumber ?? 'None'],
        ]}
      />
      {!v.closedAt && !v.voidedAt ? (
        <NextActionCard action={v.nextAction} ownerName={v.ownerName} dueOn={v.nextActionDueOn} canWrite={canWrite} onEdit={() => setWork(true)} />
      ) : null}
      <TracksEditor violation={v} editable={editable} onSave={(b) => patch.mutate(b)} />
      <Panel title="Compliance & documents">
        {/* Three columns that line up (owner, 2026-10-13): what, whether it is on file, Upload. */}
        <ul className="divide-y divide-nw-border text-sm">
          {EVIDENCE_ROWS.map((row) => {
            const have = docs.filter((d) => d.kind === row.kind);
            return (
              <li key={row.kind} className="grid grid-cols-[minmax(0,1fr)_120px_auto] items-center gap-3 py-2">
                <span className="truncate text-nw-text">{row.label}</span>
                {have.length > 0 ? (
                  <StatusBadge status="received" label={`${have.length} on file`} />
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-nw-text-3">
                    <span aria-hidden className="size-1.5 rounded-full bg-nw-text-3" />
                    Not uploaded
                  </span>
                )}
                {editable ? <UploadButton caseId={v.id} kind={row.kind} /> : <span />}
              </li>
            );
          })}
          <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2">
            <span className="text-nw-text">DataQs status</span>
            <StatusBadge status={v.dataqsStatus === 'accepted' ? 'accepted' : v.dataqsStatus === 'denied' ? 'denied' : v.dataqsStatus === 'not_filed' ? 'not_started' : 'under_review'} label={DATAQS_STATUS_LABEL[v.dataqsStatus]} />
          </li>
        </ul>
      </Panel>
      <DocumentsCard caseType="violation" caseId={v.id} documents={docs} title="All documents" />
      {editable ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={v.openTracks.length > 0} loading={close.isPending} onClick={() => close.mutate(undefined)}>
            Close violation
          </Button>
          {v.openTracks.length > 0 ? <span className="self-center text-xs text-nw-text-3">Open: {v.openTracks.join(', ')}</span> : null}
        </div>
      ) : null}
      {canWrite && !v.voidedAt ? (
        <div>
          <Button variant="danger" icon={<Trash2 />} onClick={() => setVoiding(true)} data-testid="violation-delete">
            Delete violation
          </Button>
        </div>
      ) : null}
      <TimelineCard entries={detail.data.timeline} />
    </div>
  );
}

/**
 * "Delete" a case or one violation (owner, 2026-10-21): it is voided - hidden from every list,
 * kept on record with who, when and why. A reason is required.
 */
export function DeleteViolationDialog({
  open,
  onOpenChange,
  what,
  count,
  onDelete,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The violation number, or the case's report number. */
  what: string;
  /** Violations in the case; omitted for one violation. */
  count?: number;
  onDelete: (reason: string) => void;
  saving?: boolean;
}) {
  const [reason, setReason] = useState('');
  const isCase = count !== undefined;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isCase ? `Delete this case? (${count} violation${count === 1 ? '' : 's'})` : 'Delete this violation?'}
      description={`${what} leaves every list and count${isCase ? ', with all its violations and its driver review' : ''}. It is kept on record, marked deleted with your name, the time and this reason.`}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={reason.trim().length < 3} loading={saving} onClick={() => onDelete(reason.trim())} data-testid="confirm-delete">
            Delete
          </Button>
        </>
      }
    >
      <FormField label="Reason" required description="At least 3 characters">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} aria-label="Reason" placeholder="Entered twice by mistake" />
      </FormField>
    </Modal>
  );
}

function UploadButton({ caseId, kind }: { caseId: string; kind: SafetyDocumentKind }) {
  const attach = useSafetyWrite((file: File) => safetyApi.attach('violation', caseId, file, kind), 'Uploaded');
  return (
    <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-nw-border-strong bg-nw-panel px-3 text-xs font-semibold text-nw-accent-ink transition-colors hover:border-nw-accent hover:bg-nw-accent-tint">
      <Upload aria-hidden className="size-3.5" />
      {attach.isPending ? 'Uploading…' : 'Upload'}
      <input
        type="file"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) attach.mutate(file);
          e.target.value = '';
        }}
      />
    </label>
  );
}

/** The three tracks, each its own small form: correction, citation/court, DataQs. */
function TracksEditor({ violation: v, editable, onSave }: { violation: SafetyViolation; editable: boolean; onSave: (b: Record<string, unknown>) => void }) {
  const [correction, setCorrection] = useState(v.correctionStatus);
  const [correctionNote, setCorrectionNote] = useState(v.correctionNote ?? '');
  const [correctionDue, setCorrectionDue] = useState(v.correctionDueOn ?? '');
  const [fine, setFine] = useState(v.fineCents ? String(v.fineCents / 100) : '');
  const [fineNa, setFineNa] = useState(v.fineNotApplicable);
  const [court, setCourt] = useState(v.courtDate ?? '');
  const [disposition, setDisposition] = useState(v.citationDisposition);
  const [dataqs, setDataqs] = useState(v.dataqsStatus);
  const [dataqsRef, setDataqsRef] = useState(v.dataqsReference ?? '');
  return (
    <form
      id={`violation-tracks-${v.id}`}
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!editable) return;
        onSave({
                correctionStatus: correction,
                correctionNote: correctionNote.trim() || null,
                correctionDueOn: correctionDue || null,
                fineCents: fineNa || !fine.trim() ? null : Math.round(Number(fine) * 100),
                fineNotApplicable: fineNa,
                courtDate: court || null,
                citationDisposition: disposition,
                dataqsStatus: dataqs,
                dataqsReference: dataqsRef.trim() || null,
              });
      }}
    >
      <Panel title="1 · Correction">
        <div className="grid gap-2 md:grid-cols-2">
          <FormField label="Status">
            <Select value={correction} disabled={!editable} onValueChange={(x) => setCorrection(x as typeof correction)} options={CORRECTION_STATUSES.map((s) => ({ value: s, label: CORRECTION_STATUS_LABEL[s] }))} />
          </FormField>
          <FormField label="Correction deadline">
            <DatePicker value={correctionDue || null} disabled={!editable} onIsoChange={setCorrectionDue} />
          </FormField>
          <FormField label="What was done" className="md:col-span-2">
            <Textarea rows={2} value={correctionNote} disabled={!editable} onChange={(e) => setCorrectionNote(e.target.value)} />
          </FormField>
        </div>
      </Panel>
      <Panel title="2 · Citation and court">
        <div className="grid gap-2 md:grid-cols-3">
          <FormField label="Fine ($)">
            <div className="flex items-center gap-3">
              <Input type="number" min={0} step="0.01" value={fineNa ? '' : fine} placeholder={fineNa ? 'N/A' : ''} disabled={!editable || fineNa} onChange={(e) => setFine(e.target.value)} className="flex-1" />
              <Checkbox checked={fineNa} disabled={!editable} onCheckedChange={(x) => setFineNa(x === true)} label="N/A" />
            </div>
          </FormField>
          <FormField label="Court date">
            <DatePicker value={court || null} disabled={!editable} onIsoChange={setCourt} />
          </FormField>
          <FormField label="Outcome">
            <Select value={disposition} disabled={!editable} onValueChange={(x) => setDisposition(x as typeof disposition)} options={CITATION_DISPOSITIONS.map((s) => ({ value: s, label: CITATION_DISPOSITION_LABEL[s] }))} />
          </FormField>
        </div>
      </Panel>
      <Panel title="3 · DataQs">
        <div className="grid gap-2 md:grid-cols-2">
          <FormField label="Status">
            <Select value={dataqs} disabled={!editable} onValueChange={(x) => setDataqs(x as typeof dataqs)} options={DATAQS_STATUSES.map((s) => ({ value: s, label: DATAQS_STATUS_LABEL[s] }))} />
          </FormField>
          <FormField label="DataQs reference">
            <Input value={dataqsRef} disabled={!editable} onChange={(e) => setDataqsRef(e.target.value)} />
          </FormField>
        </div>
        {v.dataqsFiledOn ? <p className="mt-1 text-xs text-nw-text-3">Filed {formatIsoDate(v.dataqsFiledOn)}</p> : null}
      </Panel>
    </form>
  );
}

/** One violation on the paper: the rule first, then what it was, the category, OOS (owner, 2026-10-21). */
type ViolationLine = { code: string; description: string; category: string; oos: boolean };
const emptyLine = (): ViolationLine => ({ code: '', description: '', category: '', oos: false });

/** All 50 states and DC, "TN — Tennessee"; type the code or the name to filter. */
const STATE_OPTIONS =US_STATE_CODES.map((code) => ({ value: code, label: `${code} — ${US_STATE_NAMES[code]}` }));

/** The document kind a violation paper is filed as. */
const PAPER_KIND: Record<ViolationType, SafetyDocumentKind> = { citation: 'citation', inspection: 'inspection_report', warning: 'other' };

/**
 * Records violations by hand, or against a roadside inspection (owner, 2026-10-12): the date only,
 * what the paper was (inspection, citation, warning), every violation on it, the state, a fine or
 * N/A, and the paper itself. One paper is one case (owner, 2026-10-21): one record per violation,
 * one shared driver review, the paper filed once on the case.
 */
export function AddViolationDialog({
  open,
  onOpenChange,
  onCreated,
  kind,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The new case's key (its case id, or the violation's id when it stands alone). */
  onCreated?: (id: string) => void;
  /** Inspections, citations and warnings are created apart (owner, 2026-10-13 / 2026-10-19): the paper type is fixed. */
  kind?: 'inspection' | 'citation' | 'warning';
}) {
  const pickers = useSafetyPickers();
  const inspections = useRoadsideInspections();
  const [f, setF] = useState({
    date: easternNowInput().slice(0, 10),
    violationType: (kind ?? 'citation') as ViolationType,
    // A warning may leave it blank (owner, 2026-10-19).
    issuedTo: (kind === 'warning' ? null : 'driver') as ViolationIssuedTo | null,
    // The state replaces "Issuing agency" (owner, 2026-10-21).
    state: null as string | null,
    reportNumber: '',
    driverId: null as string | null,
    truckId: null as string | null,
    inspectionId: null as string | null,
    fine: '',
    fineNa: false,
  });
  const [lines, setLines] = useState<ViolationLine[]>([emptyLine()]);
  const [files, setFiles] = useState<File[]>([]);
  const set = <K extends keyof typeof f>(k: K, val: (typeof f)[K]) => setF((s) => ({ ...s, [k]: val }));
  const setLine = (i: number, patch: Partial<ViolationLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const filled = lines.filter((l) => l.description.trim().length >= 2);
  const save = useSafetyWrite(
    async () => {
      // One paper, one case, one driver review (owner, 2026-10-21).
      const created = await safetyApi.post<SafetyViolationCase>('/violation-cases', {
        // The paper's date; noon Eastern so no clock moves it to another day.
        occurredAt: fromEasternInput(`${f.date}T12:00`),
        violationType: f.violationType,
        issuedTo: f.issuedTo,
        state: f.state,
        reportNumber: f.reportNumber.trim() || null,
        driverId: f.driverId,
        truckId: f.truckId,
        inspectionId: f.inspectionId,
        fineCents: f.fineNa || !f.fine.trim() ? null : Math.round(Number(f.fine) * 100),
        fineNotApplicable: f.fineNa,
        lines: filled.map((l) => ({ code: l.code.trim() || null, description: l.description.trim(), category: l.category || null, oos: l.oos })),
      });
      // The paper is filed once, on the case (its lead violation).
      for (const file of files) await safetyApi.attach('violation', created.leadId, file, PAPER_KIND[f.violationType]);
      return created;
    },
    (c) => (c.violations.length === 1 ? `${c.number} recorded` : `${c.violations.length} violations recorded as one case`),
  );
  const valid = filled.length > 0 && lines.every((l) => !l.description.trim() || l.description.trim().length >= 2) && /^\d{4}-\d{2}-\d{2}$/.test(f.date) && (f.violationType === 'warning' || f.issuedTo !== null);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={kind === 'inspection' ? 'Add inspection' : kind === 'citation' ? 'Add citation' : kind === 'warning' ? 'Add warning' : 'Add violation'}
      description="Dates are US Eastern. One paper is one case: every violation on it shares one driver review."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={save.isPending}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: (c) => {
                  onOpenChange(false);
                  onCreated?.(c.id);
                },
              })
            }
            data-testid="add-violation-save"
          >
            {filled.length > 1 ? `Add ${filled.length} violations` : 'Add violation'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Date (Eastern)" required>
          <DatePicker value={f.date || null} onIsoChange={(x) => set('date', x)} />
        </FormField>
        <FormField label="Violation type" required>
          <Select
            value={f.violationType}
            onValueChange={(x) => set('violationType', x as ViolationType)}
            // Each list adds its own paper (warnings apart since 2026-10-19).
            options={VIOLATION_TYPES.filter((t) => !kind || t === kind).map((t) => ({ value: t, label: VIOLATION_TYPE_LABEL[t] }))}
            disabled={Boolean(kind)}
          />
        </FormField>
        <FormField label="From roadside inspection" className="md:col-span-2">
          <Combobox
            options={(inspections.data ?? []).map((i) => ({ value: i.id, label: `${i.number} · ${i.agency}` }))}
            value={f.inspectionId}
            loading={inspections.isLoading}
            placeholder="None (recorded manually)"
            onValueChange={(x) => set('inspectionId', x)}
          />
        </FormField>
        <div className="flex flex-col gap-2 md:col-span-2" data-testid="violation-lines">
          {lines.map((l, i) => (
            // Rule / code first, then the violation, then the category (owner, 2026-10-21); OOS is per violation.
            <div key={i} className="grid gap-2 rounded-lg border border-nw-border p-3 md:grid-cols-[9rem_minmax(0,1fr)_12rem_auto_auto]" data-testid={`violation-block-${i}`}>
              <FormField label="Rule / code">
                <Input value={l.code} onChange={(e) => setLine(i, { code: e.target.value })} placeholder="393.47E" data-testid={`violation-code-${i}`} />
              </FormField>
              <FormField label={lines.length > 1 ? `Violation ${i + 1}` : 'Violation'} required>
                <Input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="Brake defect, HOS log issue, …" data-testid={`violation-line-${i}`} />
              </FormField>
              <FormField label="Category">
                <Select value={l.category} onValueChange={(x) => setLine(i, { category: x })} placeholder="Choose" options={VIOLATION_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} />
              </FormField>
              <div className="flex items-end pb-2">
                <Checkbox checked={l.oos} onCheckedChange={(x) => setLine(i, { oos: x === true })} label="OOS" aria-label={`Violation ${i + 1} out of service`} />
              </div>
              {lines.length > 1 ? (
                <div className="flex items-end pb-1">
                  <Button variant="ghost" size="sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Remove violation ${i + 1}`}>
                    <Trash2 className="size-4 text-nw-urgent-text" />
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
          <Button variant="outline" size="sm" icon={<Plus />} className="w-fit" onClick={() => setLines((ls) => [...ls, emptyLine()])} data-testid="add-violation-line">
            Add another violation
          </Button>
        </div>
        <FormField label="Issued to (who received it)" required={f.violationType !== 'warning'}>
          <IssuedToPicker value={f.issuedTo} onChange={(x) => set('issuedTo', x)} optional={f.violationType === 'warning'} />
        </FormField>
        <FormField label="State">
          <Combobox options={STATE_OPTIONS} value={f.state} placeholder="Choose the state" searchPlaceholder="Type a code or a name…" onValueChange={(x) => set('state', x)} aria-label="State" />
        </FormField>
        <FormField label="Driver">
          <Combobox options={(pickers.data?.drivers ?? []).map((d) => ({ value: d.id, label: d.name }))} value={f.driverId} loading={pickers.isLoading} placeholder="None" onValueChange={(x) => set('driverId', x)} />
        </FormField>
        <FormField label="Truck">
          <Combobox options={(pickers.data?.trucks ?? []).map((t) => ({ value: t.id, label: `Unit ${t.number}` }))} value={f.truckId} loading={pickers.isLoading} placeholder="None" onValueChange={(x) => set('truckId', x)} />
        </FormField>
        <FormField label="Report number">
          <Input value={f.reportNumber} onChange={(e) => set('reportNumber', e.target.value)} />
        </FormField>
        <FormField label="Fine ($)">
          <div className="flex items-center gap-3">
            <Input type="number" min={0} step="0.01" value={f.fineNa ? '' : f.fine} disabled={f.fineNa} placeholder={f.fineNa ? 'N/A' : ''} onChange={(e) => set('fine', e.target.value)} className="flex-1" />
            <Checkbox checked={f.fineNa} onCheckedChange={(x) => set('fineNa', x === true)} label="N/A" />
          </div>
        </FormField>
        <div className="flex flex-col gap-2 md:col-span-2" data-testid="violation-documents">
          <span className="text-sm font-semibold text-nw-text">Documents</span>
          {files.map((file, i) => (
            <div key={`${file.name}-${i}`} className="flex items-center gap-3 rounded-lg border border-nw-border bg-nw-subtle px-3 py-2 text-sm">
              <FileText className="size-4 shrink-0 text-nw-text-3" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-nw-text">{file.name}</span>
              <Button variant="ghost" size="sm" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))} aria-label={`Remove ${file.name}`}>
                <Trash2 className="size-4 text-nw-urgent-text" />
              </Button>
            </div>
          ))}
          <label className="flex w-full cursor-pointer items-center gap-3 rounded-[10px] border border-dashed border-nw-border-strong bg-nw-subtle px-3 py-2.5 transition-colors hover:border-nw-accent hover:bg-nw-accent-tint">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-nw-panel text-nw-accent-ink" aria-hidden>
              <Upload className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-nw-accent-ink">Add document</span>
              <span className="block text-xs text-nw-text-3">PDF, JPG or PNG · you can pick several</span>
            </span>
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,application/pdf"
              className="sr-only"
              data-testid="violation-document-input"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                if (picked.length) setFiles((fs) => [...fs, ...picked]);
                e.target.value = '';
              }}
            />
          </label>
          <p className="text-xs text-nw-text-3">The citation, inspection report or warning — filed once, on the case.</p>
        </div>
      </div>
    </Modal>
  );
}
