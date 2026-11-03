import { Link } from '@tanstack/react-router';
import { Check, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import {
  ROADSIDE_STAGES,
  ROADSIDE_STAGE_LABEL,
  VIOLATION_CATEGORIES,
  roadsideFinalStage,
  type SafetyRoadsideInspection,
  type SafetyViolation,
} from '@neway/shared';
import { Alert, Badge, Button, Checkbox, Combobox, DatePicker, Drawer, FormField, Input, Modal, Select, StatusBadge } from '@/design-system';
import { apiPost } from '@/lib/api-client';
import { formatIsoDate } from '@/lib/format';
import { CATEGORY_LABEL } from './ViolationsPage';
import { safetyApi, useCan, useRoadsideInspection, useRoadsideInspections, useSafetyPickers, useSafetyWrite } from './api';
import { easternNowInput, fromEasternInput } from './time';
import { DocumentsCard, FactList, LoadError, Loading, NextActionCard, Panel, SafetyTitle, TimelineCard, VoidDialog, WorkEditor, td, th } from './ui';

/** Inspections: roadside reports and their violations (Annual removed, owner 2026-10-16). */
export function InspectionsV2Page() {
  // Pre-trip lives on Fleet › PTI only (owner, 2026-10-09).
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const canWrite = useCan('safety.manage');
  return (
    <div className="flex w-full flex-col gap-4">
      {adding ? <AddRoadsideDialog open={adding} onOpenChange={setAdding} onCreated={(id) => setOpenId(id)} /> : null}
      <Drawer open={Boolean(openId)} onOpenChange={(o) => !o && setOpenId(null)} size="lg" title="Roadside inspection">
        {openId ? <RoadsideCase id={openId} onClose={() => setOpenId(null)} /> : null}
      </Drawer>
      <SafetyTitle
        title="Inspections"
        subtitle="Review inspection reports and follow up on violations."
        actions={
          canWrite ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add inspection
            </Button>
          ) : null
        }
      />
      {/* Roadside only: the Annual tab was removed (owner, 2026-10-16). */}
      <RoadsideTab onOpen={setOpenId} openId={openId} />
    </div>
  );
}

function roadsideBadge(i: SafetyRoadsideInspection) {
  if (i.status === 'clean') return { status: 'clean', label: 'Clean' };
  if (i.status === 'closed') return { status: 'closed', label: 'Closed' };
  return { status: 'opened', label: 'Open' };
}

function RoadsideTab({ onOpen, openId }: { onOpen: (id: string) => void; openId: string | null }) {
  const list = useRoadsideInspections();
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('all');
  const [result, setResult] = useState('all');
  const [status, setStatus] = useState('all');
  const rows = list.data ?? [];
  const shown = rows.filter((i) => {
    const q = search.trim().toLowerCase();
    if (q && ![i.number, i.driverName, i.truckNumber, i.agency, i.reportNumber].some((v) => v?.toLowerCase().includes(q))) return false;
    if (level !== 'all' && String(i.level) !== level) return false;
    if (result === 'clean' && i.violationCount > 0) return false;
    if (result === 'violations' && i.violationCount === 0) return false;
    if (result === 'oos' && !i.oos) return false;
    if (status !== 'all' && i.status !== status) return false;
    return true;
  });
  return (
    <div className="grid gap-3">
      <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <Input prefix={<Search className="size-4" />} placeholder="Search driver or truck…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search inspections" />
        <Select value={level} onValueChange={setLevel} options={[{ value: 'all', label: 'All levels' }, ...[1, 2, 3, 4, 5, 6].map((l) => ({ value: String(l), label: `Level ${l}` }))]} />
        <Select value={result} onValueChange={setResult} options={[{ value: 'all', label: 'All results' }, { value: 'clean', label: 'Clean' }, { value: 'violations', label: 'With violations' }, { value: 'oos', label: 'Out of service' }]} />
        <Select value={status} onValueChange={setStatus} options={[{ value: 'all', label: 'All statuses' }, { value: 'open', label: 'Open' }, { value: 'clean', label: 'Clean' }, { value: 'closed', label: 'Closed' }]} />
      </div>
      <Panel padding="none">
        {list.isLoading ? <Loading /> : list.error ? <LoadError error={list.error} /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse">
              <thead className="border-b border-nw-border bg-nw-subtle">
                <tr>
                  <th className={th}>Inspection &amp; date</th>
                  <th className={th}>Driver</th>
                  <th className={th}>Truck</th>
                  <th className={th}>Level</th>
                  <th className={th}>Violations</th>
                  <th className={th}>OOS</th>
                  <th className={th}>Correction due</th>
                  <th className={th}>Status</th>
                  <th className={th}>Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nw-border">
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-10 text-center text-sm text-nw-text-3">
                      {rows.length === 0 ? 'No roadside inspections recorded.' : 'No inspections match these filters.'}
                    </td>
                  </tr>
                ) : (
                  shown.map((i) => {
                    const b = roadsideBadge(i);
                    return (
                      <tr key={i.id} className={openId === i.id ? 'bg-nw-selected' : i.oos && i.status === 'open' ? 'bg-nw-urgent-bg' : 'hover:bg-nw-hover'}>
                        <td className={td}>
                          <span className="font-semibold">{i.number}</span>
                          {i.isTest ? <Badge size="sm" className="ml-1">Test</Badge> : null}
                          <span className="block text-xs text-nw-text-3">{formatIsoDate(i.inspectedAt.slice(0, 10))}</span>
                        </td>
                        <td className={td}>{i.driverName ?? <span className="text-nw-text-3">None</span>}</td>
                        <td className={td}>{i.truckNumber ?? <span className="text-nw-text-3">None</span>}</td>
                        <td className={td}>Level {roman(i.level)}</td>
                        <td className={td}>{i.violationCount}</td>
                        <td className={td}>
                          <StatusBadge status={i.oos ? 'required' : 'not_required'} label={i.oos ? 'Yes' : 'No'} />
                        </td>
                        <td className={td}>{i.correctionDueOn ? formatIsoDate(i.correctionDueOn) : <span className="text-nw-text-3">None</span>}</td>
                        <td className={td}>
                          <StatusBadge status={b.status} label={b.label} />
                        </td>
                        <td className={td}>
                          <Button size="sm" variant="outline" data-row-open onClick={() => onOpen(i.id)}>
                            View
                          </Button>
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
    </div>
  );
}

const roman = (n: number) => ['I', 'II', 'III', 'IV', 'V', 'VI'][n - 1] ?? String(n);

/** One roadside inspection: the stage checklist, the OOS banner, its violations and the repair. */
function RoadsideCase({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useRoadsideInspection(id);
  const canWrite = useCan('safety.manage');
  const canMaintain = useCan('maintenance.edit');
  const pickers = useSafetyPickers();
  const [work, setWork] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [addingViolation, setAddingViolation] = useState(false);
  const [workOrderId, setWorkOrderId] = useState('');
  const i = detail.data?.record;
  const patch = useSafetyWrite((body: Record<string, unknown>) => safetyApi.patch<SafetyRoadsideInspection>(`/roadside/${id}`, { version: i?.version, ...body }), 'Saved');
  const stage = useSafetyWrite((to: string) => safetyApi.post<SafetyRoadsideInspection>(`/roadside/${id}/stage`, { version: i?.version, stage: to }), (r) => `${r.number}: ${ROADSIDE_STAGE_LABEL[r.stage]}`);
  const voidIt = useSafetyWrite((reason: string) => safetyApi.post(`/roadside/${id}/void`, { version: i?.version, reason }), 'Voided');
  const link = useSafetyWrite((woId: string) => safetyApi.post<SafetyRoadsideInspection>(`/roadside/${id}/work-order`, { version: i?.version, workOrderId: woId }), (r) => `Repair ${r.workOrderNumber} linked`);
  const createWo = useSafetyWrite(
    async () => {
      if (!i?.truckId) throw new Error('Name the truck on the inspection first');
      const order = await apiPost<{ id: string }>('/fleet/work-orders', { assetType: 'truck', unitId: i.truckId, status: 'in_shop', workType: 'repair', title: `Roadside ${i.number} out-of-service repairs` });
      return safetyApi.post<SafetyRoadsideInspection>(`/roadside/${id}/work-order`, { version: i.version, workOrderId: order.id });
    },
    (r) => `Work order ${r.workOrderNumber} opened; the unit is in the shop`,
  );
  if (detail.isLoading) return <Loading />;
  if (detail.error || !i || !detail.data) return <LoadError error={detail.error ?? new Error('Not found')} />;
  const order = [...ROADSIDE_STAGES];
  const at = order.indexOf(i.stage);
  const final = roadsideFinalStage(i);
  const steps = order.filter((s) => s !== 'returned' || i.returnRequired);
  const next = order[at + 1];
  const canAdvance = canWrite && !i.voidedAt && next && at < order.indexOf(final);
  const orders = (pickers.data?.workOrders ?? []).filter((w) => w.unitId === i.truckId || w.unitId === i.trailerId);
  return (
    <div className="grid gap-4">
      {work ? <WorkEditor open={work} onOpenChange={setWork} initial={i} saving={patch.isPending} onSave={(b) => patch.mutate(b, { onSuccess: () => setWork(false) })} /> : null}
      {addingViolation ? <RoadsideViolationDialog open={addingViolation} onOpenChange={setAddingViolation} inspection={i} /> : null}
      <VoidDialog open={voiding} onOpenChange={setVoiding} what={i.number} saving={voidIt.isPending} onVoid={(r) => voidIt.mutate(r, { onSuccess: onClose })} />
      <div>
        <h2 className="text-[19px] font-extrabold text-nw-text">{i.number}</h2>
        <div className="text-sm text-nw-text-2">
          {formatIsoDate(i.inspectedAt.slice(0, 10))} · Roadside · Level {roman(i.level)} · {i.agency}
        </div>
      </div>
      <ol className="grid gap-2" aria-label="Inspection checklist">
        {steps.map((s) => {
          const done = Boolean(i.stageDates[s]);
          return (
            <li key={s} className="flex items-center gap-3 text-sm">
              <span className={done ? 'grid size-5 place-items-center rounded-full bg-nw-accent text-nw-on-accent' : 'size-5 rounded-full ring-1 ring-nw-border-strong'} aria-hidden>
                {done ? <Check className="size-3" /> : null}
              </span>
              <span className={done ? 'flex-1 font-semibold text-nw-text' : 'flex-1 text-nw-text-2'}>
                {ROADSIDE_STAGE_LABEL[s]}
                <span className="sr-only">{done ? ' (done)' : ' (pending)'}</span>
              </span>
              <span className="text-xs text-nw-text-3">{i.stageDates[s] ? formatIsoDate(i.stageDates[s]!.slice(0, 10)) : 'Pending'}</span>
            </li>
          );
        })}
      </ol>
      {canAdvance ? (
        <Button variant="primary" loading={stage.isPending} onClick={() => stage.mutate(next as string)}>
          Mark {ROADSIDE_STAGE_LABEL[next as (typeof ROADSIDE_STAGES)[number]].toLowerCase()}
        </Button>
      ) : null}
      {i.oos && i.status === 'open' ? (
        <Alert
          tone="danger"
          title="Vehicle out of service — repairs required"
          description="This vehicle remains blocked until required repairs are completed."
          actions={
            i.truckId ? (
              <Link to="/fleet/trucks/$truckId" params={{ truckId: i.truckId }} className="text-sm font-semibold text-nw-urgent-text underline">
                Open unit {i.truckNumber} (mark it down)
              </Link>
            ) : undefined
          }
        />
      ) : null}
      <FactList
        rows={[
          ['Driver', i.driverName ?? 'None'],
          ['Truck', i.truckNumber ?? 'None'],
          ['Trailer', i.trailerNumber ?? 'None'],
          ['Report number', i.reportNumber ?? 'Not recorded'],
          ['Violations', String(i.violationCount)],
          ['Correction due', i.correctionDueOn ? formatIsoDate(i.correctionDueOn) : 'None'],
          ['Return to agency', i.returnRequired ? 'Requested' : 'Not requested'],
          ['Repair', i.workOrderNumber ?? 'None linked'],
          ['Status', i.status === 'open' ? 'Open' : i.status === 'clean' ? 'Clean' : 'Closed'],
        ]}
      />
      {i.nextAction ? <NextActionCard action={i.nextAction} ownerName={i.ownerName} dueOn={i.nextActionDueOn} canWrite={canWrite} onEdit={() => setWork(true)} /> : null}
      <Panel
        title="Violations on this inspection"
        actions={
          canWrite && !i.voidedAt && i.status !== 'closed' ? (
            <Button size="sm" variant="outline" icon={<Plus />} onClick={() => setAddingViolation(true)}>
              Add violation
            </Button>
          ) : undefined
        }
      >
        {i.violations.length === 0 ? <p className="text-sm text-nw-text-3">No violations recorded on this inspection.</p> : null}
        <ul className="grid gap-2 text-sm">
          {i.violations.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-2">
              <Link to="/safety/violations" search={{ open: v.id } as never} className="font-semibold text-nw-accent-ink underline">
                {v.number}
              </Link>
              <span className="flex-1 text-nw-text">{v.description}</span>
              {v.oos ? <StatusBadge status="oos" /> : null}
            </li>
          ))}
        </ul>
      </Panel>
      {canWrite && !i.voidedAt && i.status === 'open' && (i.oos || i.violationCount > 0) ? (
        <Panel title="Repairs">
          <div className="grid gap-2">
            <Select value={workOrderId} onValueChange={setWorkOrderId} placeholder={orders.length === 0 ? 'No work orders for this unit' : 'Choose a work order'} options={orders.map((w) => ({ value: w.id, label: `${w.number} · Unit ${w.unitNumber}` }))} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={!workOrderId} loading={link.isPending} onClick={() => link.mutate(workOrderId)}>
                Link work order
              </Button>
              {canMaintain ? (
                <Button size="sm" variant="outline" disabled={!i.truckId} loading={createWo.isPending} onClick={() => createWo.mutate(undefined)}>
                  Create repair work order (unit in the shop)
                </Button>
              ) : null}
            </div>
          </div>
        </Panel>
      ) : null}
      <DocumentsCard caseType="roadside_inspection" caseId={i.id} documents={detail.data.documents} kinds={['inspection_report', 'repair_evidence', 'carrier_certification', 'return_report', 'other']} />
      {canWrite && !i.voidedAt ? (
        <div>
          <Button variant="ghost" onClick={() => setVoiding(true)}>
            Void…
          </Button>
        </div>
      ) : null}
      <TimelineCard entries={detail.data.timeline} />
    </div>
  );
}

function RoadsideViolationDialog({ open, onOpenChange, inspection }: { open: boolean; onOpenChange: (o: boolean) => void; inspection: SafetyRoadsideInspection }) {
  const [f, setF] = useState({ code: '', description: '', category: '', issuedTo: 'carrier', oos: false, fine: '', correctionDueOn: inspection.correctionDueOn ?? '' });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const save = useSafetyWrite(
    () =>
      safetyApi.post<SafetyViolation>(`/roadside/${inspection.id}/violations`, {
        version: inspection.version,
        code: f.code.trim() || null,
        description: f.description.trim(),
        category: f.category || null,
        issuedTo: f.issuedTo,
        oos: f.oos,
        fineCents: f.fine.trim() ? Math.round(Number(f.fine) * 100) : null,
        correctionDueOn: f.correctionDueOn || null,
      }),
    (v) => `${v.number} recorded`,
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Violation on ${inspection.number}`}
      description={`Issued by ${inspection.agency}. It is recorded as its own violation, linked to this inspection.`}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={f.description.trim().length < 2} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => onOpenChange(false) })}>
            Add violation
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Violation" required className="md:col-span-2">
          <Input value={f.description} onChange={(e) => set('description', e.target.value)} />
        </FormField>
        <FormField label="Rule / source code">
          <Input value={f.code} onChange={(e) => set('code', e.target.value)} />
        </FormField>
        <FormField label="Category">
          <Select value={f.category} onValueChange={(v) => set('category', v)} placeholder="Choose" options={VIOLATION_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} />
        </FormField>
        <FormField label="Issued to">
          <Select value={f.issuedTo} onValueChange={(v) => set('issuedTo', v)} options={[{ value: 'carrier', label: 'Carrier' }, { value: 'driver', label: 'Driver' }, { value: 'both', label: 'Driver and Carrier' }]} />
        </FormField>
        <FormField label="Fine ($)">
          <Input type="number" min={0} step="0.01" value={f.fine} onChange={(e) => set('fine', e.target.value)} />
        </FormField>
        <FormField label="Correction deadline">
          <DatePicker value={f.correctionDueOn || null} onIsoChange={(v) => set('correctionDueOn', v)} />
        </FormField>
        <Checkbox checked={f.oos} onCheckedChange={(v) => set('oos', v === true)} label="Out-of-service violation" />
      </div>
    </Modal>
  );
}

function AddRoadsideDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const pickers = useSafetyPickers();
  const [f, setF] = useState({
    inspectedAt: easternNowInput(),
    level: '1',
    agency: '',
    reportNumber: '',
    location: '',
    state: '',
    driverId: null as string | null,
    truckId: null as string | null,
    trailerId: null as string | null,
    oos: false,
    correctionDueOn: '',
    returnRequired: false,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const save = useSafetyWrite(
    () =>
      apiPost<SafetyRoadsideInspection>('/safety/roadside', {
        inspectedAt: fromEasternInput(f.inspectedAt),
        level: Number(f.level),
        agency: f.agency.trim(),
        reportNumber: f.reportNumber.trim() || null,
        location: f.location.trim() || null,
        state: f.state.trim() || null,
        driverId: f.driverId,
        truckId: f.truckId,
        trailerId: f.trailerId,
        oos: f.oos,
        correctionDueOn: f.correctionDueOn || null,
        returnRequired: f.returnRequired,
      }),
    (r) => `${r.number} recorded`,
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Add roadside inspection"
      description="Times are US Eastern. Record each violation on the inspection after saving it."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={f.agency.trim().length < 2 || !fromEasternInput(f.inspectedAt)}
            loading={save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: (r) => { onOpenChange(false); onCreated(r.id); } })}
          >
            Add inspection
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Date and time (Eastern)" required>
          <Input type="datetime-local" value={f.inspectedAt} onChange={(e) => set('inspectedAt', e.target.value)} />
        </FormField>
        <FormField label="Level">
          <Select value={f.level} onValueChange={(v) => set('level', v)} options={[1, 2, 3, 4, 5, 6].map((l) => ({ value: String(l), label: `Level ${roman(l)}` }))} />
        </FormField>
        <FormField label="Agency" required>
          <Input value={f.agency} onChange={(e) => set('agency', e.target.value)} placeholder="Illinois State Police" />
        </FormField>
        <FormField label="Report number">
          <Input value={f.reportNumber} onChange={(e) => set('reportNumber', e.target.value)} />
        </FormField>
        <FormField label="Location">
          <Input value={f.location} onChange={(e) => set('location', e.target.value)} />
        </FormField>
        <FormField label="State">
          <Input value={f.state} onChange={(e) => set('state', e.target.value)} />
        </FormField>
        <FormField label="Driver">
          <Combobox options={(pickers.data?.drivers ?? []).map((d) => ({ value: d.id, label: d.name }))} value={f.driverId} loading={pickers.isLoading} placeholder="None" onValueChange={(v) => set('driverId', v)} />
        </FormField>
        <FormField label="Truck">
          <Combobox options={(pickers.data?.trucks ?? []).map((t) => ({ value: t.id, label: `Unit ${t.number}` }))} value={f.truckId} loading={pickers.isLoading} placeholder="None" onValueChange={(v) => set('truckId', v)} />
        </FormField>
        <FormField label="Trailer">
          <Combobox options={(pickers.data?.trailers ?? []).map((t) => ({ value: t.id, label: `Trailer ${t.number}` }))} value={f.trailerId} loading={pickers.isLoading} placeholder="None" onValueChange={(v) => set('trailerId', v)} />
        </FormField>
        <FormField label="Correction due">
          <DatePicker value={f.correctionDueOn || null} onIsoChange={(v) => set('correctionDueOn', v)} />
        </FormField>
        <Checkbox checked={f.oos} onCheckedChange={(v) => set('oos', v === true)} label="Vehicle placed out of service" />
        <Checkbox checked={f.returnRequired} onCheckedChange={(v) => set('returnRequired', v === true)} label="Agency asked for the signed report back" />
      </div>
    </Modal>
  );
}
