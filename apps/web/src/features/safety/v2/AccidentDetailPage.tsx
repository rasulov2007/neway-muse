import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ChevronDown, Lock } from 'lucide-react';
import { useState } from 'react';
import {
  ACCIDENT_FAULTS,
  ACCIDENT_FAULT_LABEL,
  ACCIDENT_STAGES,
  ACCIDENT_STAGE_LABEL,
  PREVENTABILITY_LABEL,
  TEST_PROGRESS_LABEL,
  type SafetyAccident,
  type SafetyClaim,
  type SafetyDrugTest,
  type TestResult,
} from '@neway/shared';
import {
  Button,
  Card,
  DropdownMenu,
  FormField,
  Input,
  MenuItem,
  MenuSeparator,
  Modal,
  Select,
  StatusBadge,
  Tabs,
  TabsContent,
  Textarea,
} from '@/design-system';
import { apiPost } from '@/lib/api-client';
import { formatDateTime, formatTime } from '@/lib/format';
import { safetyApi, useAccident, useCan, useClaim, useDrugTest, useSafetyPickers, useSafetyWrite } from './api';
import { AccidentForm } from './AccidentForm';
import { fromEasternInput, toEasternInput } from './time';
import {
  CaseStepper,
  DocumentsCard,
  FactList,
  LoadError,
  Loading,
  NextActionCard,
  Panel,
  TimelineCard,
  VoidDialog,
  WorkEditor,
  money,
} from './ui';

/** The accident file, as the owner's mockup draws it: stepper, next action, five tabs. */
export function AccidentDetailV2Page({ accidentId }: { accidentId: string }) {
  const detail = useAccident(accidentId);
  const navigate = useNavigate();
  const canWrite = useCan('safety.manage');
  const canTestManage = useCan('safety_testing.manage');
  const [editing, setEditing] = useState(false);
  const [work, setWork] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [adminClose, setAdminClose] = useState(false);
  const [tab, setTab] = useState('overview');

  const a = detail.data?.record;
  const advance = useSafetyWrite(() => safetyApi.post<SafetyAccident>(`/accidents/${accidentId}/advance`, { version: a?.version }), (r) => `${r.number}: ${ACCIDENT_STAGE_LABEL[r.stage]}`);
  const patch = useSafetyWrite((body: Record<string, unknown>) => safetyApi.patch<SafetyAccident>(`/accidents/${accidentId}`, { version: a?.version, ...body }), 'Saved');
  const voidIt = useSafetyWrite((reason: string) => safetyApi.post<SafetyAccident>(`/accidents/${accidentId}/void`, { version: a?.version, reason }), 'Voided');
  const close = useSafetyWrite((reason: string) => safetyApi.post<SafetyAccident>(`/accidents/${accidentId}/close`, { version: a?.version, kind: 'administrative', reason }), 'Closed administratively');
  const claim = useSafetyWrite(
    () => safetyApi.post<{ claim: SafetyClaim; created: boolean }>(`/accidents/${accidentId}/claim`, { kind: 'physical_damage' }),
    (r) => (r.created ? `Claim ${r.claim.number} opened` : `Claim ${r.claim.number} is already open`),
  );

  if (detail.isLoading) return <Loading />;
  if (detail.error || !a || !detail.data) return <LoadError error={detail.error ?? new Error('Not found')} />;

  const subtitle = [a.driverName, a.truckNumber ? `Unit ${a.truckNumber}` : null, a.trailerNumber ? `Trailer ${a.trailerNumber}` : null, a.loadNumber ? `Load ${a.loadNumber}` : null].filter(Boolean).join(' · ');
  const closed = a.stage === 'closed';
  const steps = ACCIDENT_STAGES.map((s) => ({ key: s, label: ACCIDENT_STAGE_LABEL[s] }));

  return (
    <div className="flex w-full flex-col gap-4">
      {editing ? <AccidentForm open={editing} onOpenChange={setEditing} accident={a} /> : null}
      {work ? (
        <WorkEditor
          open={work}
          onOpenChange={setWork}
          initial={a}
          saving={patch.isPending}
          onSave={(v) => patch.mutate(v, { onSuccess: () => setWork(false) })}
        />
      ) : null}
      <VoidDialog open={voiding} onOpenChange={setVoiding} what={a.number} saving={voidIt.isPending} onVoid={(r) => voidIt.mutate(r, { onSuccess: () => void navigate({ to: '/safety/accidents' }) })} />
      <AdminCloseDialog open={adminClose} onOpenChange={setAdminClose} blockers={a.closeBlockers} saving={close.isPending} onClose={(r) => close.mutate(r, { onSuccess: () => setAdminClose(false) })} />

      <div>
        <Link to="/safety/accidents" className="inline-flex items-center gap-1 text-sm font-semibold text-nw-accent-ink">
          <ArrowLeft className="size-4" /> Back to accidents
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[22px] font-extrabold tracking-[-.022em] text-nw-text">{a.number}</h1>
            {subtitle ? <div className="text-[15px] font-semibold text-nw-text">{subtitle}</div> : null}
            <div className="text-sm text-nw-text-2">
              {formatDateTime(a.occurredAt)} · {a.location}
              {a.city ? `, ${a.city}` : ''}
              {a.state ? `, ${a.state}` : ''}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {a.voidedAt ? <StatusBadge status="void" /> : <StatusBadge status={closed ? 'closed' : 'opened'} label={closed ? (a.closeKind === 'administrative' ? 'Closed (administrative)' : 'Closed') : 'Open'} />}
            {canWrite && !a.voidedAt ? (
              <DropdownMenu
                trigger={
                  <Button variant="outline" iconRight={<ChevronDown />}>
                    More actions
                  </Button>
                }
              >
                {!closed ? <MenuItem onSelect={() => setEditing(true)}>Edit facts</MenuItem> : null}
                {!closed ? <MenuItem onSelect={() => setWork(true)}>Owner and next action</MenuItem> : null}
                <MenuItem onSelect={() => (a.claimId ? void navigate({ to: '/safety/claims/$claimId', params: { claimId: a.claimId } }) : claim.mutate(undefined))}>{a.claimId ? `Open claim ${a.claimNumber}` : 'Create claim'}</MenuItem>
                {!closed && canTestManage ? <MenuItem onSelect={() => setAdminClose(true)}>Close administratively…</MenuItem> : null}
                <MenuSeparator />
                <MenuItem onSelect={() => setVoiding(true)}>Void (entered in error)…</MenuItem>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
      </div>

      <CaseStepper steps={steps} current={a.stage} finished={closed && a.closeKind !== 'administrative'} administrative={a.closeKind === 'administrative'} />
      {!closed && !a.voidedAt ? (
        <NextActionCard
          action={a.nextAction}
          ownerName={a.ownerName}
          dueOn={a.nextActionDueOn}
          canWrite={canWrite}
          onComplete={() => advance.mutate(undefined)}
          completing={advance.isPending}
          completeLabel={a.stage === 'review' ? 'Close accident' : 'Mark complete'}
          blockers={a.advanceBlockers}
          onEdit={() => setWork(true)}
        />
      ) : null}

      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'testing', label: 'Testing' },
          { value: 'damage', label: 'Damage & costs' },
          { value: 'documents', label: 'Documents', count: detail.data.documents.length },
          { value: 'timeline', label: 'Timeline' },
        ]}
      >
        <TabsContent value="overview" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Incident facts">
              <FactList
                rows={[
                  ['Fatalities', a.fatalities > 0 ? String(a.fatalities) : 'No'],
                  ['Injuries', a.injuries > 0 ? `${a.injuries} (${a.injuriesTreatedAway} treated away)` : 'No'],
                  ['Disabling damage (tow-away)', a.disablingTow ? 'Yes' : 'No'],
                  ['Moving citation', a.citationIssued ? `Yes${a.citationAt ? ` (${formatTime(a.citationAt)})` : ' (time not recorded)'}` : 'No'],
                  ['DOT recordable', a.dotRecordable ? 'Yes' : 'No'],
                  ['Police report #', a.policeReportNumber ?? 'Not recorded'],
                ]}
              />
              {a.description ? <p className="mt-3 text-sm text-nw-text-2">{a.description}</p> : null}
            </Panel>
            <FaultCard accident={a} canWrite={canWrite && !closed} onSave={(body) => patch.mutate(body)} />
            <DocumentsCard caseType="accident" caseId={a.id} documents={detail.data.documents} kinds={['police_report', 'photos', 'driver_statement', 'witness_statement', 'repair_estimate', 'other']} />
            <TestingSummaryCard accident={a} />
            <DamageCard accident={a} />
            <TimelineCard entries={detail.data.timeline.slice(0, 8)} />
          </div>
        </TabsContent>
        <TabsContent value="testing" className="pt-4">
          <TestingTab accident={a} />
        </TabsContent>
        <TabsContent value="damage" className="pt-4">
          <DamageTab accident={a} canWrite={canWrite} onSave={(body) => patch.mutate(body)} onCreateClaim={() => claim.mutate(undefined)} />
        </TabsContent>
        <TabsContent value="documents" className="pt-4">
          <DocumentsCard caseType="accident" caseId={a.id} documents={detail.data.documents} />
        </TabsContent>
        <TabsContent value="timeline" className="pt-4">
          <TimelineCard entries={detail.data.timeline} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FaultCard({ accident: a, canWrite, onSave }: { accident: SafetyAccident; canWrite: boolean; onSave: (body: Record<string, unknown>) => void }) {
  return (
    <Panel title="Fault & preventability">
      <div className="grid gap-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-nw-text-2">Fault</span>
          {canWrite ? (
            <Select size="sm" value={a.fault} onValueChange={(v) => onSave({ fault: v })} options={ACCIDENT_FAULTS.map((f) => ({ value: f, label: ACCIDENT_FAULT_LABEL[f] }))} />
          ) : (
            <StatusBadge status={a.fault === 'undetermined' ? 'pending' : 'info'} label={ACCIDENT_FAULT_LABEL[a.fault]} />
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-nw-text-2">Preventability</span>
          <StatusBadge status={a.preventability === 'undetermined' ? 'under_review' : a.preventability === 'preventable' ? 'warning' : 'resolved'} label={PREVENTABILITY_LABEL[a.preventability]} />
        </div>
        <p className="text-xs text-nw-text-3">
          Preventability is decided in the driver review{a.reviewNumber ? ' ' : ''}
          {a.reviewId ? (
            <Link to="/safety/review" search={{ open: a.reviewId } as never} className="font-semibold text-nw-accent-ink underline">
              {a.reviewNumber}
            </Link>
          ) : null}
          {a.reviewId ? '' : ', opened when the file reaches Review'}.
        </p>
        {a.preventabilityNote ? <p className="text-nw-text-2">{a.preventabilityNote}</p> : null}
        {a.notes ? <p className="text-nw-text-2">{a.notes}</p> : null}
        {canWrite ? <NotesEditor value={a.notes ?? ''} onSave={(notes) => onSave({ notes })} /> : null}
      </div>
    </Panel>
  );
}

function NotesEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  return (
    <>
      <Button variant="link" size="sm" onClick={() => setOpen(true)}>
        {value ? 'Edit notes' : 'Add notes'}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Notes"
        footer={
          <Button
            variant="primary"
            onClick={() => {
              onSave(text);
              setOpen(false);
            }}
          >
            Save
          </Button>
        }
      >
        <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </Modal>
    </>
  );
}

function testWord(t: SafetyAccident['tests'][number]): { status: string; label: string } {
  if (t.resultRestricted && (t.status.progress === 'result_recorded' || t.status.progress === 'result_pending')) {
    return { status: t.status.resolved ? 'result_restricted' : 'result_pending', label: t.status.resolved ? 'Result restricted' : 'In progress' };
  }
  return { status: t.status.progress, label: TEST_PROGRESS_LABEL[t.status.progress] };
}

function TestingSummaryCard({ accident: a }: { accident: SafetyAccident }) {
  return (
    <Panel title="Testing">
      <div className="grid gap-2 text-sm">
        {(['alcohol', 'drug'] as const).map((s) => {
          const assess = a.testing[s];
          const test = a.tests.find((t) => t.substance === s);
          const w = test ? testWord(test) : { status: assess.required === 'no' ? 'not_required' : 'required', label: assess.required === 'no' ? 'Not required' : assess.required === 'yes' ? 'Required' : 'Needs assessment' };
          return (
            <div key={s} className="flex items-center justify-between gap-2">
              <span className="text-nw-text-2">{s === 'alcohol' ? 'Alcohol test' : 'Drug test'}</span>
              <span className="text-xs text-nw-text-3">{test?.collectedAt ? `Collected ${formatTime(test.collectedAt)}` : ''}</span>
              <StatusBadge status={w.status} label={w.label} />
            </div>
          );
        })}
        <p className="mt-1 text-xs text-nw-text-3">Test results are restricted to authorised personnel. Receipt of test materials is not a clearance for return to duty.</p>
      </div>
    </Panel>
  );
}

function DamageCard({ accident: a }: { accident: SafetyAccident }) {
  const claim = useClaim(a.claimId ?? '');
  const c = claim.data?.record;
  return (
    <Panel title="Damage & coverage">
      <FactList
        rows={[
          ['Repair estimate', money(a.damageEstimateCents)],
          ['Confirmed insurer payment', a.claimId ? (c ? money(c.receivedCents) : 'Loading…') : 'No claim'],
          ['Company deductible', money(c?.deductibleCents ?? a.companyDeductibleCents)],
          ['Recovery pending', c ? money(c.remainingApprovedCents) : 'No claim'],
          ['Driver deduction', c?.driverDeductionProposedCents ? `${money(c.driverDeductionProposedCents)} proposed — Accounting decides` : 'Not authorized'],
          [
            'Linked claim',
            a.claimId ? (
              <Link to="/safety/claims/$claimId" params={{ claimId: a.claimId }} className="font-semibold text-nw-accent-ink underline">
                {a.claimNumber}
              </Link>
            ) : (
              'None'
            ),
          ],
          ['Linked repair', a.workOrderNumber ?? 'None'],
        ]}
      />
    </Panel>
  );
}

function DamageTab({ accident: a, canWrite, onSave, onCreateClaim }: { accident: SafetyAccident; canWrite: boolean; onSave: (body: Record<string, unknown>) => void; onCreateClaim: () => void }) {
  const pickers = useSafetyPickers();
  const canMaintain = useCan('maintenance.edit');
  const [estimate, setEstimate] = useState(a.damageEstimateCents === null ? '' : String(a.damageEstimateCents / 100));
  const [deductible, setDeductible] = useState(a.companyDeductibleCents === null ? '' : String(a.companyDeductibleCents / 100));
  const [workOrderId, setWorkOrderId] = useState('');
  const link = useSafetyWrite((id: string) => safetyApi.post<SafetyAccident>(`/accidents/${a.id}/work-order`, { version: a.version, workOrderId: id }), (r) => `Repair ${r.workOrderNumber} linked`);
  const createAndLink = useSafetyWrite(
    async () => {
      if (!a.truckId) throw new Error('Name the truck on the accident first');
      const order = await apiPost<{ id: string; number: string }>('/fleet/work-orders', {
        assetType: 'truck',
        unitId: a.truckId,
        status: 'in_shop',
        workType: 'repair',
        title: `Accident ${a.number} repairs`,
      });
      return safetyApi.post<SafetyAccident>(`/accidents/${a.id}/work-order`, { version: a.version, workOrderId: order.id });
    },
    (r) => `Work order ${r.workOrderNumber} opened and linked`,
  );
  const orders = (pickers.data?.workOrders ?? []).filter((w) => !a.truckId || w.unitId === a.truckId || w.unitId === a.trailerId);
  const cents = (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 100));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Costs" padding="md">
        <div className="grid gap-3">
          <FormField label="Repair estimate ($)">
            <Input type="number" min={0} step="0.01" value={estimate} disabled={!canWrite} onChange={(e) => setEstimate(e.target.value)} />
          </FormField>
          <FormField label="Company deductible ($)">
            <Input prefix="$" type="number" min={0} step="0.01" value={deductible} disabled={!canWrite} onChange={(e) => setDeductible(e.target.value)} />
          </FormField>
          {canWrite ? (
            <div>
              <Button variant="primary" onClick={() => onSave({ damageEstimateCents: cents(estimate), companyDeductibleCents: cents(deductible) })}>Save costs</Button>
            </div>
          ) : null}
          <p className="text-xs text-nw-text-3">Money moves to Accounting from the claim, as suggestions Accounting confirms. Nothing here posts or deducts.</p>
        </div>
      </Card>
      <div className="grid gap-4">
        <Card title="Insurance claim" padding="md">
          {a.claimId ? (
            <p className="text-sm">
              Claim{' '}
              <Link to="/safety/claims/$claimId" params={{ claimId: a.claimId }} className="font-semibold text-nw-accent-ink underline">
                {a.claimNumber}
              </Link>{' '}
              is linked. One accident has one claim.
            </p>
          ) : canWrite ? (
            <Button variant="outline" onClick={onCreateClaim}>
              Create claim
            </Button>
          ) : (
            <p className="text-sm text-nw-text-3">No claim yet.</p>
          )}
        </Card>
        <Card title="Repairs" padding="md">
          {a.workOrderId ? <p className="mb-2 text-sm">Linked work order: <span className="font-semibold">{a.workOrderNumber}</span></p> : null}
          {canWrite ? (
            <div className="grid gap-2">
              <FormField label="Link an existing work order">
                <Select
                  value={workOrderId}
                  onValueChange={setWorkOrderId}
                  placeholder={pickers.isLoading ? 'Loading…' : orders.length === 0 ? 'No work orders for this unit' : 'Choose a work order'}
                  options={orders.map((w) => ({ value: w.id, label: `${w.number} · Unit ${w.unitNumber}` }))}
                />
              </FormField>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={!workOrderId} loading={link.isPending} onClick={() => link.mutate(workOrderId)}>
                  Link work order
                </Button>
                {canMaintain ? (
                  <Button variant="outline" disabled={!a.truckId} loading={createAndLink.isPending} onClick={() => createAndLink.mutate(undefined)}>
                    Create repair work order (unit in the shop)
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

/** Each required test: its rule, its clock, and the steps Safety records. Results only for the authorised. */
function TestingTab({ accident: a }: { accident: SafetyAccident }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(['alcohol', 'drug'] as const).map((s) => {
        const test = a.tests.find((t) => t.substance === s);
        const assess = a.testing[s];
        return (
          <Card key={s} title={s === 'alcohol' ? 'Alcohol test' : 'Drug test'} padding="md">
            <FactList
              rows={[
                ['Required', assess.required === 'yes' ? 'Yes' : assess.required === 'no' ? 'No' : 'Cannot tell yet'],
                ['Rule', assess.reasons.join('; ')],
                ['Testing window ends', formatDateTime(assess.deadlineAt)],
                ...(assess.promptBy ? ([['Give within 2 hours by', formatDateTime(assess.promptBy)]] as [string, string][]) : []),
              ]}
            />
            {test ? <TestEditor testId={test.id} /> : assess.required === 'yes' ? <p className="mt-3 text-sm text-nw-text-3">Loading…</p> : null}
          </Card>
        );
      })}
    </div>
  );
}

function TestEditor({ testId }: { testId: string }) {
  const detail = useDrugTest(testId);
  const canManage = useCan('safety_testing.manage');
  const canSafety = useCan('safety.manage');
  const canReview = canManage && canSafety;
  const t = detail.data?.record;
  const [scheduled, setScheduled] = useState('');
  const [collected, setCollected] = useState('');
  const [reason, setReason] = useState('');
  const [late, setLate] = useState('');
  const [note, setNote] = useState('');
  const save = useSafetyWrite((body: Record<string, unknown>) => safetyApi.patch<SafetyDrugTest>(`/tests/${testId}`, { version: t?.version, ...body }), 'Test updated');
  const review = useSafetyWrite(() => safetyApi.post<SafetyDrugTest>(`/tests/${testId}/exception-review`, { version: t?.version, note }), 'Exception reviewed');
  if (detail.isLoading || !t) return <Loading />;
  const done = t.status.resolved;
  return (
    <div className="mt-4 grid gap-3 border-t border-nw-border pt-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{t.number}</span>
        <StatusBadge status={t.resultRestricted && ['result_recorded', 'result_pending'].includes(t.status.progress) ? 'result_pending' : t.status.progress} label={t.resultRestricted && t.status.resolved ? 'Resolved (restricted)' : TEST_PROGRESS_LABEL[t.status.progress]} />
        {t.resultRestricted ? (
          <span className="inline-flex items-center gap-1 text-xs text-nw-text-3">
            <Lock className="size-3" /> Results restricted
          </span>
        ) : null}
      </div>
      <FactList
        rows={[
          ['Scheduled', t.scheduledAt ? formatDateTime(t.scheduledAt) : 'Not scheduled'],
          ['Collected', t.collectedAt ? formatDateTime(t.collectedAt) : 'Not collected'],
          ['Result', t.resultRestricted ? 'Restricted' : t.result ? t.result.charAt(0).toUpperCase() + t.result.slice(1) : 'Pending'],
          ...(t.notCompletedReason ? ([['Why not completed', t.notCompletedReason]] as [string, string][]) : []),
          ...(t.lateReason ? ([['Why late', t.lateReason]] as [string, string][]) : []),
          ...(t.exceptionReviewedAt ? ([['Exception reviewed', `${formatDateTime(t.exceptionReviewedAt)} by ${t.exceptionReviewedBy ?? ''}`]] as [string, string][]) : []),
        ]}
      />
      {t.status.blockers.length > 0 && !t.resultRestricted ? (
        <ul className="list-disc pl-5 text-xs text-nw-warning-text">
          {t.status.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}
      {!done && canManage ? (
        <div className="grid gap-2">
          {!t.collectedAt ? (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <FormField label="Scheduled for (Eastern)">
                  <Input type="datetime-local" value={scheduled || toEasternInput(t.scheduledAt)} onChange={(e) => setScheduled(e.target.value)} />
                </FormField>
                <Button variant="outline" size="sm" disabled={!scheduled} onClick={() => save.mutate({ scheduledAt: fromEasternInput(scheduled) })}>
                  Save schedule
                </Button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <FormField label="Collected at (Eastern)">
                  <Input type="datetime-local" value={collected} onChange={(e) => setCollected(e.target.value)} />
                </FormField>
                <Button variant="outline" size="sm" disabled={!collected} onClick={() => save.mutate({ collectedAt: fromEasternInput(collected) })}>
                  Record collection
                </Button>
              </div>
            </>
          ) : null}
          {t.collectedAt && t.result === 'pending' ? (
            <FormField label="Record the result">
              <Select
                placeholder="Choose the result"
                onValueChange={(v) => save.mutate({ result: v as TestResult })}
                options={[
                  { value: 'negative', label: 'Negative' },
                  { value: 'positive', label: 'Positive' },
                  { value: 'refused', label: 'Refused' },
                  { value: 'cancelled', label: 'Cancelled' },
                ]}
              />
            </FormField>
          ) : null}
          {t.status.blockers.some((b) => /2 hours/.test(b)) ? (
            <div className="flex flex-wrap items-end gap-2">
              <FormField label="Why alcohol was given after 2 hours" className="flex-1">
                <Input value={late} onChange={(e) => setLate(e.target.value)} />
              </FormField>
              <Button variant="outline" size="sm" disabled={late.trim().length < 3} onClick={() => save.mutate({ lateReason: late.trim() })}>
                Save reason
              </Button>
            </div>
          ) : null}
          {!t.collectedAt || t.status.progress === 'not_completed' ? (
            <div className="flex flex-wrap items-end gap-2">
              <FormField label="Not given / refused / could not complete — why" className="flex-1">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t.notCompletedReason ?? ''} />
              </FormField>
              <Button variant="outline" size="sm" disabled={reason.trim().length < 5} onClick={() => save.mutate({ notCompletedReason: reason.trim() })}>
                Document reason
              </Button>
            </div>
          ) : null}
          {t.status.progress === 'not_completed' && t.notCompletedReason && canReview ? (
            <div className="flex flex-wrap items-end gap-2">
              <FormField label="Safety review of the exception" className="flex-1">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was reviewed and decided" />
              </FormField>
              <Button variant="primary" size="sm" disabled={note.trim().length < 5} loading={review.isPending} onClick={() => review.mutate(undefined)}>
                Approve exception
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {!canManage && !done ? <p className="text-xs text-nw-text-3">Recording collections and results takes the drug & alcohol testing permission.</p> : null}
    </div>
  );
}

function AdminCloseDialog({ open, onOpenChange, blockers, onClose, saving }: { open: boolean; onOpenChange: (o: boolean) => void; blockers: string[]; onClose: (reason: string) => void; saving: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Close administratively"
      description="An explicit, reasoned and audited closure. Open tests stay open, a corrective action carries what is outstanding, and the driver is not cleared to operate by this."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={reason.trim().length < 10} loading={saving} onClick={() => onClose(reason.trim())}>
            Close administratively
          </Button>
        </>
      }
    >
      {blockers.length > 0 ? (
        <div className="mb-3 text-sm">
          <div className="font-semibold">Still outstanding</div>
          <ul className="list-disc pl-5 text-nw-text-2">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <FormField label="Reason" description="At least 10 characters">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
    </Modal>
  );
}
