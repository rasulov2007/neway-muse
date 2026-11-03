import { Check, ExternalLink, Plus, ShieldCheck, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, Modal, cn } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { accApi, useAccWrite, useCaseTasks, useVendors } from './api';
import { dollarsToCents } from './claims-api';
import { triText } from './labels';
import { DeptChip, DueText, Empty, Field, KV, NInput, NSelect, NTextarea, Panel, Person, Seg, ToneBadge, TriField } from './ui';

type D = A.CaseDetailResponse;

const FLOW = ['at_scene', 'towed_storage', 'at_shop', 'in_repair', 'returned'] as const;
const unitTone = (s: A.UnitView['status']) => (s === 'operational' || s === 'returned' ? 'done' : s === 'unknown' ? 'warning' : s === 'total_loss' || s === 'not_involved' ? 'neutral' : 'urgent');
const woTone = (s: string) => (s === 'Completed' ? 'done' : s === 'In repair' || s === 'Approved' ? 'moving' : 'warning');

/**
 * Equipment & cargo tab (SPEC §1.4, prototype CaseTabs1 EquipmentTab) — behind `accidents_v2`. Units (flow, condition at
 * the scene, where it is now, tow, storage), Fleet's repair work orders with the estimates policy and the Fleet actions
 * (accidents.fleet), out-of-service periods Fleet verifies, cargo & load, Dispatch coordination (requests only — the
 * Daily board changes only when Dispatch confirms) and the connected records.
 */
export function EquipmentTab({ d }: { d: D }) {
  const c = d.case;
  const navigate = useNavigate();
  const tasks = useCaseTasks(c.id);
  const [newWo, setNewWo] = useState(false);
  const money = d.computed.money;
  const verify = useAccWrite((p: { id: string; version: number }) => accApi.verifyDowntime(p.id, { version: p.version }), 'Out-of-service period verified');
  const openRequests = (tasks.data ?? []).filter((t) => t.requestKind && t.status !== 'done' && t.status !== 'cancelled');
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[1.4fr_1fr]">
      <div className="flex min-w-0 flex-col gap-3">
        {d.units.length === 0 ? <Panel title="Units"><Empty title="No unit on this case">Name the truck or trailer on the Incident tab.</Empty></Panel> : d.units.map((u) => <UnitCard key={`${u.id}-${u.version}`} d={d} u={u} />)}
        <Panel
          title="Repair work orders · Fleet module"
          sub="Estimates, approval and the invoice live on Fleet’s work order; the case reads them"
          id="work-orders"
          actions={d.permissions.fleet && d.units.length ? <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => setNewWo(true)}>Create work order</Button> : null}
        >
          {money.workOrders.length === 0 ? (
            <Empty title="No repair work order yet">{d.permissions.fleet ? 'Create one for a unit, or link an existing accident repair from its work-order page.' : 'Fleet opens the repair work order.'}</Empty>
          ) : (
            <div className="flex flex-col gap-3">{money.workOrders.map((w) => <WorkOrderBlock key={`${w.id}-${w.updatedAt}`} d={d} w={w} />)}</div>
          )}
        </Panel>
        <Panel title="Out-of-service time" sub="Downtime comes from these periods; Fleet verifies each one" pad={false} id="downtime">
          {d.computed.downtime.periods.length === 0 ? <Empty title="No out-of-service time recorded" /> : (
            <ul className="divide-y divide-nw-border">
              {d.computed.downtime.periods.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                  <b className="text-nw-text">{p.unitKind === 'truck' ? 'Truck' : 'Trailer'} {p.unit}</b>
                  <ToneBadge tone={p.ongoing ? 'urgent' : 'neutral'}>{R.downtimeLabel(p.ms)}{p.ongoing ? ' so far' : ''}</ToneBadge>
                  <span className="min-w-0 flex-1 text-xs text-nw-text-3">
                    {R.fmtShortDateTime(p.startedAt, c.tz, nowMs())} → {p.endedAt ? R.fmtShortDateTime(p.endedAt, c.tz, nowMs()) : 'now'} · {p.source === 'entered' ? 'Entered by Safety' : p.source === 'work_order' ? 'Work order' : 'Daily board'}
                    {p.note ? ` · ${p.note}` : ''}
                  </span>
                  {p.verifiedBy ? (
                    <ToneBadge tone="done">Verified · {p.verifiedBy}</ToneBadge>
                  ) : d.permissions.fleet ? (
                    <Button size="sm" variant="secondary" icon={<ShieldCheck />} loading={verify.isPending} onClick={() => verify.mutate({ id: p.id, version: p.version })}>Verify</Button>
                  ) : (
                    <ToneBadge tone="warning">Fleet to verify</ToneBadge>
                  )}
                </li>
              ))}
              <li className="px-4 py-2 text-xs text-nw-text-3">Truck total: {R.downtimeLabel(d.computed.downtime.truckMs)}{d.computed.downtime.ongoing ? ' and counting' : ''}{d.computed.downtime.trailerMs ? ` · Trailer: ${R.downtimeLabel(d.computed.downtime.trailerMs)}` : ''}</li>
            </ul>
          )}
        </Panel>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <CargoPanel d={d} />
        <DispatchPanel d={d} openRequests={openRequests} />
        <Panel title="Connected NeWay records" id="connected">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Conn label="Truck" value={d.display.truck ? `Truck ${d.display.truck.unit}` : '—'} onClick={d.display.truck ? () => void navigate({ to: '/fleet/trucks/$truckId', params: { truckId: d.display.truck!.id } }) : undefined} />
            <Conn label="Trailer" value={d.display.trailer ? `Trailer ${d.display.trailer.unit}` : '—'} onClick={d.display.trailer ? () => void navigate({ to: '/fleet/trailers/$trailerId', params: { trailerId: d.display.trailer!.id } }) : undefined} />
            <Conn label="Driver" value={d.display.driver?.name ?? '—'} onClick={d.display.driver ? () => void navigate({ to: '/drivers/$driverId', params: { driverId: d.display.driver!.id } }) : undefined} />
            <Conn label="Work orders" value={money.workOrders.length ? money.workOrders.map((w) => w.number).join(', ') : 'None'} />
            <Conn label="Load" value={d.display.load ? d.display.load.number : 'No load'} />
            <Conn label="Daily board" value={money.unitStatus.length ? money.unitStatus.map((u) => u.status).join(', ') : 'No confirmed change'} />
            <Conn
              label="AP bills"
              value={money.apBills.length ? `${money.apBills.length} · ${money.apBills.some((b) => b.amountCents === null) ? 'amounts hidden' : R.money(money.apBills.reduce((a, b) => a + (b.amountCents ?? 0), 0))}` : 'None'}
              onClick={money.apBills.length ? () => void navigate({ to: '/accounting/payables' } as never) : undefined}
            />
            <Conn label="Claims" value={d.computed.claims.length ? `${d.computed.claims.length} · ${d.computed.claims.filter((k) => R.OPEN_CLAIM(k.status)).length} open` : 'None'} />
          </div>
        </Panel>
      </div>
      {newWo ? <NewWorkOrder d={d} onClose={() => setNewWo(false)} /> : null}
    </div>
  );
}

function Conn({ label, value, onClick }: { label: string; value: string; onClick?: (() => void) | undefined }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={cn('flex min-w-0 flex-col rounded-md bg-nw-subtle px-2.5 py-1.5 text-left', onClick ? 'hover:bg-nw-hover' : '')}>
      <span className="text-xs text-nw-text-3">{label}</span>
      <span className="truncate font-semibold text-nw-text">{value}</span>
    </Tag>
  );
}

function UnitCard({ d, u }: { d: D; u: A.UnitView }) {
  const navigate = useNavigate();
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState({
    status: u.status,
    damage: u.damage ?? '',
    towCompany: u.towCompany ?? '',
    towedTo: u.towedTo ?? '',
    storageRate: u.storageRateCents === null ? '' : String(u.storageRateCents / 100),
    storageSince: u.storageSince ? R.isoToLocalInput(u.storageSince, d.case.tz) : '',
  });
  const save = useAccWrite((body: Omit<A.UnitPatchInput, 'version'>) => accApi.unit(d.case.id, u.id, { version: u.version, ...body }), 'Unit updated · change recorded in the timeline');
  const at = FLOW.indexOf(u.status as (typeof FLOW)[number]);
  const toIso = (local: string) => {
    if (!local) return null;
    const r = R.localToUtc(local, d.case.tz);
    return r.ok ? r.iso : null;
  };
  return (
    <Panel
      title={`${u.unitKind === 'truck' ? 'Tractor' : 'Trailer'} ${u.unit}`}
      id={`unit-${u.unitKind}`}
      actions={
        <>
          <Button size="sm" variant="ghost" icon={<ExternalLink />} onClick={() => void navigate(u.unitKind === 'truck' ? { to: '/fleet/trucks/$truckId', params: { truckId: u.unitId } } : { to: '/fleet/trailers/$trailerId', params: { trailerId: u.unitId } })}>
            Profile
          </Button>
          {d.permissions.editUnits && !edit ? <Button size="sm" variant="secondary" onClick={() => setEdit(true)}>Update</Button> : null}
        </>
      }
    >
      <ol className="mb-3 flex flex-wrap gap-1 text-xs" aria-label="Where the unit is">
        {FLOW.map((s, i) => (
          <li key={s} className={cn('rounded-[5px] px-1.5 py-0.5 font-semibold', i <= at && at >= 0 ? 'bg-nw-accent-tint text-nw-accent-ink' : 'bg-nw-subtle text-nw-text-3')}>
            {i <= at && at >= 0 ? <Check className="mr-0.5 inline size-3" aria-hidden /> : null}
            {R.EQUIP_STATUS_LABEL[s]}
          </li>
        ))}
      </ol>
      {edit ? (
        <div className="flex flex-col gap-3">
          <Field label="Where it is now" htmlFor={`u-st-${u.id}`}>
            <NSelect id={`u-st-${u.id}`} value={v.status} onChange={(s) => setV({ ...v, status: s as A.UnitView['status'] })}>
              {Object.entries(R.EQUIP_STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </NSelect>
          </Field>
          <Field label="Damage" htmlFor={`u-dmg-${u.id}`}><NInput id={`u-dmg-${u.id}`} value={v.damage} onChange={(e) => setV({ ...v, damage: e.target.value })} /></Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Towing company" htmlFor={`u-tow-${u.id}`}><NInput id={`u-tow-${u.id}`} value={v.towCompany} onChange={(e) => setV({ ...v, towCompany: e.target.value })} /></Field>
            <Field label="Towed to" htmlFor={`u-to-${u.id}`}><NInput id={`u-to-${u.id}`} value={v.towedTo} onChange={(e) => setV({ ...v, towedTo: e.target.value })} /></Field>
            <Field label="Storage $/day" htmlFor={`u-rate-${u.id}`} hint="Accrues on the ledger while towed to storage"><NInput id={`u-rate-${u.id}`} inputMode="decimal" value={v.storageRate} onChange={(e) => setV({ ...v, storageRate: e.target.value })} /></Field>
            <Field label="In storage since (incident time)" htmlFor={`u-since-${u.id}`}><NInput id={`u-since-${u.id}`} type="datetime-local" value={v.storageSince} onChange={(e) => setV({ ...v, storageSince: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEdit(false)}>Cancel</Button>
            <Button
              size="sm"
              variant="primary"
              loading={save.isPending}
              onClick={() =>
                save.mutate(
                  { status: v.status, damage: v.damage || null, towCompany: v.towCompany || null, towedTo: v.towedTo || null, storageRateCents: dollarsToCents(v.storageRate), storageSince: toIso(v.storageSince) },
                  { onSuccess: () => setEdit(false) },
                )
              }
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <dl>
          <KV k="Status">
            <ToneBadge tone={unitTone(u.status)}>{R.EQUIP_STATUS_LABEL[u.status]}</ToneBadge>
            {u.returnedToServiceAt ? <span className="ml-1 text-xs text-nw-text-3">{R.fmtShortDateTime(u.returnedToServiceAt, d.case.tz, nowMs())}</span> : null}
          </KV>
          <KV k="Condition at scene" hint="Recorded by Safety; a repair never changes it">{u.conditionAtScene === 'drivable' ? 'Drivable' : u.conditionAtScene === 'not_drivable' ? 'Not drivable' : 'Unknown'}</KV>
          <KV k="Damage">{u.damage || <span className="text-nw-text-3">Not described yet</span>}</KV>
          <KV k="Tow">{u.towCompany ? `${u.towCompany}${u.towedTo ? ` → ${u.towedTo}` : ''}` : <span className="text-nw-text-3">No tow recorded</span>}</KV>
          {u.storageRateCents ? <KV k="Storage">{R.money(u.storageRateCents)}/day{u.storageSince ? ` since ${R.fmtShort(u.storageSince, d.case.tz, nowMs())}` : ''}</KV> : null}
        </dl>
      )}
    </Panel>
  );
}

function WorkOrderBlock({ d, w }: { d: D; w: A.WorkOrderView }) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<null | 'estimate' | 'approve' | 'complete'>(null);
  const [est, setEst] = useState({ vendor: '', amount: '' });
  const [appr, setAppr] = useState({ estimateId: w.estimates.find((e) => e.selected)?.id ?? w.estimates[0]?.id ?? '', reason: '' });
  const [inv, setInv] = useState({ number: '', amount: w.approvedAmountCents === null ? '' : String(w.approvedAmountCents / 100), workDone: '' });
  const act = useAccWrite(
    (p: { action: 'estimates' | 'approve' | 'start' | 'complete'; body: Record<string, unknown> }) => accApi.wo<A.CompleteRepairResponse | { id: string }>(w.id, p.action, { updatedAt: w.updatedAt, ...p.body }),
    (r, p) =>
      p.action === 'complete'
        ? (() => {
            const res = r as A.CompleteRepairResponse;
            return `${w.number} completed — ${res.bill ? `${res.bill.number} created` : `AP bill not created: ${res.billWarning}`}; Dispatch asked to mark the unit ready`;
          })()
        : p.action === 'estimates'
          ? `${w.number}: estimate added`
          : p.action === 'approve'
            ? `${w.number}: estimate approved`
            : `${w.number}: repair started`,
  );
  const short = w.estimates.length < w.estimatesRequired;
  const canFleet = d.permissions.fleet && w.status !== 'Completed';
  return (
    <div className="rounded-[10px] border border-nw-border p-3" data-wo={w.number}>
      <div className="flex flex-wrap items-center gap-2">
        <Wrench className="size-4 text-nw-text-3" aria-hidden />
        <button type="button" className="font-bold text-nw-accent-ink hover:underline" onClick={() => void navigate({ to: '/fleet/shop/$orderId', params: { orderId: w.id } })}>{w.number}</button>
        <span className="text-sm text-nw-text-2">{w.unitKind === 'truck' ? 'Tractor' : 'Trailer'} {w.unit} · {w.shop}</span>
        <span className="flex-1" />
        <ToneBadge tone={woTone(w.status)}>{w.status}</ToneBadge>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
        <div><dt className="text-nw-text-3">Estimates</dt><dd className={cn('font-semibold', short && w.status !== 'Completed' ? 'text-nw-warning-text' : 'text-nw-text')}>{w.estimates.length} of {w.estimatesRequired} required</dd></div>
        <div><dt className="text-nw-text-3">Approved</dt><dd className="font-semibold text-nw-text">{w.approvedAmountCents === null ? '—' : R.money(w.approvedAmountCents)}</dd></div>
        <div><dt className="text-nw-text-3">ETA</dt><dd className="font-semibold text-nw-text">{w.eta ? R.fmtShort(w.eta, d.case.tz, nowMs()) : '—'}</dd></div>
        <div><dt className="text-nw-text-3">Invoice · AP bill</dt><dd className="font-semibold text-nw-text">{w.status === 'Completed' ? `${w.invoiceNumber ?? '—'}${w.bill ? ` · ${w.bill.number}` : ' · no bill yet'}` : '—'}</dd></div>
      </dl>
      {w.policyExceptionReason ? <p className="mt-1 text-xs text-nw-warning-text">Policy exception: {w.policyExceptionReason}</p> : null}
      {w.estimates.length ? (
        <ul className="mt-2 divide-y divide-nw-border rounded-md bg-nw-subtle px-2">
          {w.estimates.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 py-1 text-xs">
              <span className="text-nw-text">{e.vendor} · {R.fmtShort(e.receivedAt, d.case.tz, nowMs())}</span>
              <span className="flex items-center gap-1.5">
                <b className="text-nw-text">{e.amountCents === null ? 'Hidden' : R.money(e.amountCents)}</b>
                {e.selected ? <ToneBadge tone="done">Approved</ToneBadge> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {canFleet ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => { setEst({ vendor: w.shop, amount: '' }); setDialog('estimate'); }}>Add estimate</Button>
          {w.estimates.length && (w.status === 'Waiting for approval' || w.status === 'Awaiting estimate') ? <Button size="sm" variant="secondary" onClick={() => setDialog('approve')}>Approve estimate</Button> : null}
          {w.status === 'Approved' ? <Button size="sm" variant="secondary" loading={act.isPending} onClick={() => act.mutate({ action: 'start', body: {} })}>Start repair</Button> : null}
          {w.status === 'Approved' || w.status === 'In repair' ? <Button size="sm" variant="primary" onClick={() => setDialog('complete')}>Mark repaired</Button> : null}
        </div>
      ) : null}
      {dialog === 'estimate' ? (
        <Modal open onOpenChange={(o) => (o ? undefined : setDialog(null))} size="sm" title={`Add estimate · ${w.number}`} description={`More than ${R.money(R.DEFAULT_SAFETY_RULE_SETTINGS.estimatesRequiredThresholdCents)} needs ${R.DEFAULT_SAFETY_RULE_SETTINGS.estimatesRequired} estimates.`}
          footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!est.vendor.trim() || dollarsToCents(est.amount) === null} loading={act.isPending} onClick={() => act.mutate({ action: 'estimates', body: { vendor: est.vendor.trim(), amountCents: dollarsToCents(est.amount) } }, { onSuccess: () => setDialog(null) })}>Add</Button></>}
        >
          <div className="grid grid-cols-2 gap-2">
            <Field label="Shop" htmlFor="est-vendor"><NInput id="est-vendor" value={est.vendor} onChange={(e) => setEst({ ...est, vendor: e.target.value })} /></Field>
            <Field label="Amount ($)" htmlFor="est-amount"><NInput id="est-amount" inputMode="decimal" value={est.amount} onChange={(e) => setEst({ ...est, amount: e.target.value })} /></Field>
          </div>
        </Modal>
      ) : null}
      {dialog === 'approve' ? (
        <Modal open onOpenChange={(o) => (o ? undefined : setDialog(null))} size="sm" title={`Approve an estimate · ${w.number}`} description={short ? `${w.estimates.length} of ${w.estimatesRequired} required estimates received — approving now is a policy exception and needs a reason (logged).` : 'The approved amount becomes the case’s repair estimate until the invoice arrives.'}
          footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!appr.estimateId || (short && appr.reason.trim().length < 3)} loading={act.isPending} onClick={() => act.mutate({ action: 'approve', body: { estimateId: appr.estimateId, ...(short ? { exceptionReason: appr.reason.trim() } : {}) } }, { onSuccess: () => setDialog(null) })}>Approve</Button></>}
        >
          <div className="flex flex-col gap-3">
            <Field label="Estimate" htmlFor="appr-est">
              <NSelect id="appr-est" value={appr.estimateId} onChange={(v) => setAppr({ ...appr, estimateId: v })}>
                {w.estimates.map((e) => <option key={e.id} value={e.id}>{e.vendor} · {e.amountCents === null ? 'amount hidden' : R.money(e.amountCents)}</option>)}
              </NSelect>
            </Field>
            {short ? <Field label="Policy-exception reason" required htmlFor="appr-reason"><NTextarea id="appr-reason" rows={2} value={appr.reason} onChange={(e) => setAppr({ ...appr, reason: e.target.value })} /></Field> : null}
          </div>
        </Modal>
      ) : null}
      {dialog === 'complete' ? (
        <Modal open onOpenChange={(o) => (o ? undefined : setDialog(null))} size="sm" title={`Mark repaired · ${w.number}`} description="Completes the work order in Fleet, creates the AP bill, returns the unit to service, closes its downtime and asks Dispatch to mark it ready. The condition at the scene is not changed."
          footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!inv.number.trim() || dollarsToCents(inv.amount) === null} loading={act.isPending} onClick={() => act.mutate({ action: 'complete', body: { invoiceNumber: inv.number.trim(), invoiceTotalCents: dollarsToCents(inv.amount), ...(inv.workDone.trim() ? { workDone: inv.workDone.trim() } : {}) } }, { onSuccess: () => setDialog(null) })}>Mark repaired</Button></>}
        >
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Invoice #" htmlFor="inv-no" required><NInput id="inv-no" value={inv.number} onChange={(e) => setInv({ ...inv, number: e.target.value })} /></Field>
              <Field label="Final invoice ($)" htmlFor="inv-amt" required><NInput id="inv-amt" inputMode="decimal" value={inv.amount} onChange={(e) => setInv({ ...inv, amount: e.target.value })} /></Field>
            </div>
            <Field label="What the shop did" htmlFor="inv-done" hint="Defaults to the work order title"><NInput id="inv-done" value={inv.workDone} onChange={(e) => setInv({ ...inv, workDone: e.target.value })} /></Field>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function NewWorkOrder({ d, onClose }: { d: D; onClose: () => void }) {
  const vendors = useVendors(true);
  const kinds = [...new Set(d.units.map((u) => u.unitKind))];
  const [f, setF] = useState({ unitKind: kinds[0] ?? 'truck', vendorId: '', title: '' });
  const create = useAccWrite((body: A.CreateCaseWorkOrderInput) => accApi.createWorkOrder(d.case.id, body), 'Work order opened in Fleet and linked to the case');
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="sm"
      title="Create work order"
      description="Opens an Accident repair work order in Fleet, linked to this case. The unit moves to At shop."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.vendorId} loading={create.isPending} onClick={() => create.mutate({ version: d.version, unitKind: f.unitKind, vendorId: f.vendorId, ...(f.title.trim() ? { title: f.title.trim() } : {}) }, { onSuccess: onClose })}>Create</Button></>}
    >
      <div className="flex flex-col gap-3">
        <Field label="Unit" htmlFor="wo-unit">
          <NSelect id="wo-unit" value={f.unitKind} onChange={(v) => setF({ ...f, unitKind: v as 'truck' | 'trailer' })}>
            {d.units.map((u) => <option key={u.id} value={u.unitKind}>{u.unitKind === 'truck' ? 'Tractor' : 'Trailer'} {u.unit}</option>)}
          </NSelect>
        </Field>
        <Field label="Shop" htmlFor="wo-shop" required>
          <NSelect id="wo-shop" value={f.vendorId} onChange={(v) => setF({ ...f, vendorId: v })}>
            <option value="">{vendors.isLoading ? 'Loading…' : 'Pick the shop…'}</option>
            {(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </NSelect>
        </Field>
        <Field label="What is being repaired" htmlFor="wo-title"><NInput id="wo-title" value={f.title} placeholder={`Accident repair — ${d.case.number}`} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function CargoPanel({ d }: { d: D }) {
  const c = d.case;
  const cargoEdit = d.permissions.editCargo;
  const patch = useAccWrite((body: Omit<A.PatchAccidentInput, 'version'>) => accApi.patch(c.id, { version: d.version, ...body }), 'Saved · change recorded in the timeline');
  const [impact, setImpact] = useState(c.cargo.deliveryImpact ?? '');
  return (
    <Panel title="Cargo & load" id="cargo">
      <dl>
        <KV k="Load">{d.display.load ? `${d.display.load.number}${d.display.load.customer ? ` · ${d.display.load.customer}` : ''}${d.display.load.origin && d.display.load.destination ? ` · ${d.display.load.origin} → ${d.display.load.destination}` : ''}` : 'No load / empty'}</KV>
        <KV k="Cargo condition">
          {cargoEdit ? (
            <Seg ariaLabel="Cargo condition" size="sm" value={c.cargo.status} onChange={(v) => v && patch.mutate({ cargo: v })} options={[{ v: 'no_damage', label: 'No damage' }, { v: 'damaged', label: 'Damaged' }, { v: 'loss', label: 'Loss' }, { v: 'unknown', label: 'Unknown' }, { v: 'na', label: 'Empty' }]} />
          ) : (
            R.CARGO_STATUS_LABEL[c.cargo.status]
          )}
        </KV>
        <KV k="Recovery plan">
          <NSelect ariaLabel="Cargo plan" disabled={!cargoEdit} value={c.cargo.plan ?? ''} onChange={(v) => patch.mutate({ cargoPlan: (v || null) as A.PatchAccidentInput['cargoPlan'] })}>
            <option value="">Not decided</option>
            {Object.entries(R.CARGO_PLAN_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </NSelect>
        </KV>
        <KV k="Delivery impact">
          {cargoEdit ? (
            <span className="flex gap-1.5">
              <NInput aria-label="Delivery impact" className="h-8" value={impact} onChange={(e) => setImpact(e.target.value)} placeholder="e.g. Delivered 1 day late" />
              {impact !== (c.cargo.deliveryImpact ?? '') ? <Button size="sm" variant="primary" onClick={() => patch.mutate({ cargoDeliveryImpact: impact.trim() || null })}>Save</Button> : null}
            </span>
          ) : (
            c.cargo.deliveryImpact ?? <span className="text-nw-text-3">Not recorded</span>
          )}
        </KV>
        <KV k="Broker notified">{cargoEdit ? <TriField ariaLabel="Broker notified" value={c.cargo.brokerNotified ?? null} onChange={(v) => patch.mutate({ brokerNotified: v })} /> : triText(c.cargo.brokerNotified ?? null)}</KV>
      </dl>
    </Panel>
  );
}

function DispatchPanel({ d, openRequests }: { d: D; openRequests: A.TaskView[] }) {
  const c = d.case;
  const [req, setReq] = useState<null | A.RequestKind>(null);
  const [note, setNote] = useState('');
  const ask = useAccWrite((p: { kind: A.RequestKind; note: string }) => accApi.post<A.TaskView>(c.id, 'requests', p), 'Request sent to Dispatch');
  const confirm = useAccWrite((t: A.TaskView) => accApi.confirm(t.id, { version: t.version }), (_r, t) => `Dispatch confirmed: ${t.title}`);
  const truckStatus = d.computed.money.unitStatus.find((u) => u.unitKind === 'truck');
  return (
    <Panel title="Dispatch coordination" id="dispatch">
      <dl>
        <KV k="Daily board (truck)" hint="Changes only when Dispatch confirms a request">
          {truckStatus ? <><b>{truckStatus.status}</b> <span className="text-xs text-nw-text-3">since {R.fmtShortDateTime(truckStatus.since, R.EASTERN, nowMs())}{truckStatus.setBy ? ` · ${truckStatus.setBy}` : ''}</span></> : <span className="text-nw-text-3">No confirmed change from this case</span>}
        </KV>
      </dl>
      {openRequests.length ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {openRequests.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-md bg-nw-subtle px-2 py-1.5 text-sm">
              <DeptChip dept={t.dept} />
              <span className="min-w-0 flex-1 text-nw-text">{t.title}</span>
              {t.assignee ? <Person name={t.assignee.name} /> : null}
              <DueText iso={t.dueAt} />
              {d.permissions.confirm && t.dept === 'Dispatch' ? <Button size="sm" variant="secondary" loading={confirm.isPending} onClick={() => confirm.mutate(t)}>Confirm done</Button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="my-2 text-xs text-nw-text-3">NeWay never cancels a load, changes a truck’s availability or reassigns a driver on its own. Dispatch confirms every change.</p>
      {d.permissions.edit ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => { setReq('repower_transload'); setNote(''); }}>Ask Dispatch to repower / transload</Button>
          <Button size="sm" variant="secondary" onClick={() => { setReq('notify_broker'); setNote(''); }}>Ask Dispatch to notify the broker</Button>
          <Button size="sm" variant="secondary" onClick={() => { setReq('unit_unavailable'); setNote(''); }}>Ask Dispatch to mark the truck unavailable</Button>
        </div>
      ) : null}
      <Modal
        open={Boolean(req)}
        onOpenChange={(o) => (o ? undefined : setReq(null))}
        size="sm"
        title="Request to Dispatch"
        description="A high-priority Dispatch task due in 3 hours. Nothing changes on the load or the Daily board until Dispatch confirms."
        footer={<><Button variant="secondary" onClick={() => setReq(null)}>Cancel</Button><Button variant="primary" disabled={note.trim().length < 3} loading={ask.isPending} onClick={() => ask.mutate({ kind: req!, note: note.trim() }, { onSuccess: () => setReq(null) })}>Send request</Button></>}
      >
        <Field label="What Dispatch should do" required htmlFor="req-note"><NTextarea id="req-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Modal>
    </Panel>
  );
}
