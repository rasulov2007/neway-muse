import { Link, useSearch } from '@tanstack/react-router';
import { AlertTriangle, CircleAlert, Clock, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  PREVENTABILITY_DECISIONS,
  PREVENTABILITY_LABEL,
  SAFETY_REVIEW_KIND_LABEL,
  type SafetyReview,
  type SafetyReviewKind,
} from '@neway/shared';
import { Badge, Button, Combobox, DatePicker, Drawer, FormField, Input, Modal, Select, StatusBadge, Tabs, TabsContent, Textarea } from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { safetyApi, useCan, useSafetyPickers, useSafetyReview, useSafetyReviews, useSafetyWrite } from './api';
import { CountTile, DocumentsCard, FactList, LoadError, Loading, OwnerCell, Panel, SafetyTitle, TimelineCard, VoidDialog, WorkEditor, td, th } from './ui';

const STATUS_WORD: Record<SafetyReview['status'], { status: string; label: string }> = {
  not_started: { status: 'not_started', label: 'Not started' },
  scheduled: { status: 'scheduled', label: 'Scheduled' },
  in_progress: { status: 'pending', label: 'In progress' },
  completed: { status: 'completed', label: 'Completed' },
};

const LINK_PATH = {
  accident: '/safety/accidents/$accidentId',
  claim: '/safety/claims/$claimId',
} as const;

function LinkedCase({ review: r }: { review: Pick<SafetyReview, 'linkedType' | 'linkedId' | 'linkedNumber'> }) {
  if (!r.linkedId || !r.linkedType) return <span className="text-nw-text-3">None</span>;
  const cls = 'font-semibold text-nw-accent-ink underline underline-offset-2';
  if (r.linkedType === 'accident') return <Link to={LINK_PATH.accident} params={{ accidentId: r.linkedId }} className={cls}>{r.linkedNumber}</Link>;
  if (r.linkedType === 'claim') return <Link to={LINK_PATH.claim} params={{ claimId: r.linkedId }} className={cls}>{r.linkedNumber}</Link>;
  if (r.linkedType === 'violation') return <Link to="/safety/violations" search={{ open: r.linkedId } as never} className={cls}>{r.linkedNumber}</Link>;
  return <span>{r.linkedNumber}</span>;
}

/** Safety review, as the owner's mockup draws it: three tabs, three counts, the driver in a drawer. */
export function SafetyReviewV2Page() {
  const all = useSafetyReviews();
  const canWrite = useCan('safety.manage');
  const search = useSearch({ strict: false }) as { open?: string };
  const [tab, setTab] = useState<SafetyReviewKind>('driver_review');
  const [openId, setOpenId] = useState<string | null>(search.open ?? null);
  const [creating, setCreating] = useState(false);
  const today = companyToday();
  const rows = all.data ?? [];
  const open = rows.filter((r) => r.status !== 'completed');
  const count = (n: number) => (all.data ? n : null);
  return (
    <div className="flex w-full flex-col gap-4">
      {creating ? <NewReviewDialog open={creating} onOpenChange={setCreating} kind={tab} onCreated={setOpenId} /> : null}
      <Drawer open={Boolean(openId)} onOpenChange={(o) => !o && setOpenId(null)} size="lg" title="Safety review">
        {openId ? <ReviewCase id={openId} /> : null}
      </Drawer>
      <SafetyTitle
        title="Safety review"
        subtitle="Follow up with drivers and close corrective actions."
        actions={
          canWrite ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              New {SAFETY_REVIEW_KIND_LABEL[tab].toLowerCase()}
            </Button>
          ) : null
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as SafetyReviewKind)}
        items={[
          { value: 'driver_review', label: 'Driver reviews', count: all.data ? open.filter((r) => r.kind === 'driver_review').length : undefined },
          { value: 'coaching', label: 'Coaching', count: all.data ? open.filter((r) => r.kind === 'coaching').length : undefined },
          { value: 'corrective_action', label: 'Corrective actions', count: all.data ? open.filter((r) => r.kind === 'corrective_action').length : undefined },
        ]}
      >
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <CountTile icon={<CircleAlert />} tone="urgent" value={count(open.filter((r) => r.kind === 'driver_review').length)} label="Reviews due" hint="Driver reviews to complete" />
          <CountTile icon={<Clock />} tone="warning" value={count(open.filter((r) => r.kind === 'coaching').length)} label="Coaching open" hint="Active coaching items" />
          <CountTile
            icon={<AlertTriangle />}
            tone="urgent"
            value={count(open.filter((r) => r.kind === 'corrective_action' && r.nextActionDueOn !== null && r.nextActionDueOn < today).length)}
            label="Overdue actions"
            hint="Past due corrective actions"
          />
        </div>
        {(['driver_review', 'coaching', 'corrective_action'] as const).map((kind) => (
          <TabsContent key={kind} value={kind} className="pt-4">
            <Panel padding="none">
              {all.isLoading ? <Loading /> : all.error ? <LoadError error={all.error} /> : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] border-collapse">
                    <thead className="border-b border-nw-border bg-nw-subtle">
                      <tr>
                        <th className={th}>Driver</th>
                        <th className={th}>Reason</th>
                        <th className={th}>Linked case</th>
                        <th className={th}>Next action</th>
                        <th className={th}>Owner</th>
                        <th className={th}>Due</th>
                        <th className={th}>Status</th>
                        <th className={th}>Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-nw-border">
                      {rows.filter((r) => r.kind === kind).length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-3 py-10 text-center text-sm text-nw-text-3">
                            Nothing here yet. Reviews open themselves from accidents and violations, or start one with the button above.
                          </td>
                        </tr>
                      ) : (
                        rows
                          .filter((r) => r.kind === kind)
                          .map((r) => {
                            const overdue = r.status !== 'completed' && r.nextActionDueOn !== null && r.nextActionDueOn < today;
                            return (
                              <tr key={r.id} className={openId === r.id ? 'bg-nw-selected' : overdue ? 'bg-nw-urgent-bg' : 'hover:bg-nw-hover'}>
                                <td className={td}>
                                  {r.driverName ?? <span className="text-nw-text-3">No driver</span>}
                                  {r.isTest ? <Badge size="sm" className="ml-1">Test</Badge> : null}
                                </td>
                                <td className={td}>{r.reason}</td>
                                <td className={td}>
                                  <LinkedCase review={r} />
                                </td>
                                <td className={td}>{r.nextAction ?? <span className="text-nw-text-3">None</span>}</td>
                                <td className={td}>
                                  <OwnerCell name={r.ownerName} />
                                </td>
                                <td className={`${td} whitespace-nowrap`}>{r.nextActionDueOn ? formatIsoDate(r.nextActionDueOn) : <span className="text-nw-text-3">None</span>}</td>
                                <td className={td}>
                                  <StatusBadge status={overdue ? 'overdue' : STATUS_WORD[r.status].status} label={overdue ? 'Overdue' : STATUS_WORD[r.status].label} />
                                </td>
                                <td className={td}>
                                  <Button size="sm" variant="outline" data-row-open onClick={() => setOpenId(r.id)}>
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
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function ReviewCase({ id }: { id: string }) {
  const detail = useSafetyReview(id);
  const canWrite = useCan('safety.manage');
  const [tab, setTab] = useState('summary');
  const [work, setWork] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const r = detail.data?.record;
  const patch = useSafetyWrite((body: Record<string, unknown>) => safetyApi.patch<SafetyReview>(`/reviews/${id}`, { version: r?.version, ...body }), 'Saved');
  const complete = useSafetyWrite(() => safetyApi.post<SafetyReview>(`/reviews/${id}/complete`, { version: r?.version }), 'Review completed');
  const voidIt = useSafetyWrite((reason: string) => safetyApi.post(`/reviews/${id}/void`, { version: r?.version, reason }), 'Voided');
  if (detail.isLoading) return <Loading />;
  if (detail.error || !r || !detail.data) return <LoadError error={detail.error ?? new Error('Not found')} />;
  const related = detail.data.related;
  const editable = canWrite && r.status !== 'completed' && !r.voidedAt;
  return (
    <div className="grid gap-4">
      {work ? <WorkEditor open={work} onOpenChange={setWork} initial={r} saving={patch.isPending} onSave={(b) => patch.mutate(b, { onSuccess: () => setWork(false) })} /> : null}
      <VoidDialog open={voiding} onOpenChange={setVoiding} what={r.number} saving={voidIt.isPending} onVoid={(reason) => voidIt.mutate(reason)} />
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[19px] font-extrabold text-nw-text">{r.driverName ?? 'No driver'}</h2>
          <div className="text-sm text-nw-text-2">
            {r.number} · {SAFETY_REVIEW_KIND_LABEL[r.kind]} · {r.reason}
          </div>
        </div>
        <StatusBadge status={STATUS_WORD[r.status].status} label={STATUS_WORD[r.status].label} />
      </div>
      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'summary', label: 'Summary' },
          { value: 'plan', label: 'Action plan' },
          { value: 'history', label: 'History' },
        ]}
      >
        <TabsContent value="summary" className="grid gap-4 pt-3">
          <Panel title="Related records">
            <FactList
              rows={[
                ['Accident', related.accidents.length ? <RelatedList items={related.accidents.map((a) => ({ id: a.id, label: `${a.number} · ${formatIsoDate(a.occurredAt.slice(0, 10))}`, to: 'accident' as const }))} /> : 'None'],
                ['Claim', related.claims.length ? <RelatedList items={related.claims.map((c) => ({ id: c.id, label: `${c.number} · ${formatIsoDate(c.openedOn)}`, to: 'claim' as const }))} /> : 'None'],
                ['Violation', related.violations.length ? <RelatedList items={related.violations.map((v) => ({ id: v.id, label: `${v.number} · ${v.description}`, to: 'violation' as const }))} /> : 'None'],
              ]}
            />
          </Panel>
          <Panel title="Review details">
            <FactList
              rows={[
                ['Linked case', <LinkedCase key="l" review={r} />],
                ['Preventability', r.preventabilityRequired ? <StatusBadge key="p" status={r.preventability === 'undetermined' ? 'under_review' : 'resolved'} label={PREVENTABILITY_LABEL[r.preventability]} /> : 'Not part of this review'],
                ['Required training', r.requiredTraining ? `${r.requiredTraining} (${r.trainingCompletedOn ? `done ${formatIsoDate(r.trainingCompletedOn)}` : 'pending'})` : 'None'],
                ['Notes', r.notes ?? 'None'],
                ['Outcome', r.outcome ?? 'Not written yet'],
                ['Follow-up date', r.followUpOn ? formatIsoDate(r.followUpOn) : 'None'],
                ['Evidence', r.evidenceNote ?? 'None'],
                ['Reviewer', r.ownerName ?? 'Unassigned'],
                ['Next action', r.nextAction ? `${r.nextAction}${r.nextActionDueOn ? ` · due ${formatIsoDate(r.nextActionDueOn)}` : ''}` : 'None'],
              ]}
            />
            {editable ? (
              <Button variant="link" size="sm" onClick={() => setWork(true)}>
                Change owner or next action
              </Button>
            ) : null}
          </Panel>
          <DocumentsCard caseType="safety_review" caseId={r.id} documents={detail.data.documents} kinds={['training_record', 'driver_statement', 'photos', 'other']} />
          {r.status === 'completed' ? (
            <p className="text-sm text-nw-text-2">
              Completed {r.completedAt ? formatDateTime(r.completedAt) : ''} by {r.completedBy ?? ''}.
            </p>
          ) : editable ? (
            <div className="grid gap-1">
              <Button variant="primary" fullWidth disabled={r.completeBlockers.length > 0} loading={complete.isPending} onClick={() => complete.mutate(undefined)}>
                Complete review
              </Button>
              {r.completeBlockers.length > 0 ? (
                <ul className="list-disc pl-5 text-xs text-nw-warning-text">
                  {r.completeBlockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-center text-xs text-nw-text-3">All required tasks must be completed before closing.</p>
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="plan" className="pt-3">
          <ActionPlan review={r} editable={editable} onSave={(b) => patch.mutate(b)} saving={patch.isPending} />
          {editable ? (
            <Button variant="ghost" className="mt-2" onClick={() => setVoiding(true)}>
              Void…
            </Button>
          ) : null}
        </TabsContent>
        <TabsContent value="history" className="pt-3">
          <TimelineCard entries={detail.data.timeline} title="History" />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RelatedList({ items }: { items: { id: string; label: string; to: 'accident' | 'claim' | 'violation' }[] }) {
  const cls = 'block font-semibold text-nw-accent-ink underline underline-offset-2';
  return (
    <span className="grid gap-0.5">
      {items.map((i) =>
        i.to === 'accident' ? (
          <Link key={i.id} to={LINK_PATH.accident} params={{ accidentId: i.id }} className={cls}>{i.label}</Link>
        ) : i.to === 'claim' ? (
          <Link key={i.id} to={LINK_PATH.claim} params={{ claimId: i.id }} className={cls}>{i.label}</Link>
        ) : (
          <Link key={i.id} to="/safety/violations" search={{ open: i.id } as never} className={cls}>{i.label}</Link>
        ),
      )}
    </span>
  );
}

function ActionPlan({ review: r, editable, onSave, saving }: { review: SafetyReview; editable: boolean; onSave: (b: Record<string, unknown>) => void; saving: boolean }) {
  const [f, setF] = useState({
    status: r.status === 'completed' ? 'in_progress' : r.status,
    scheduledFor: r.scheduledFor ?? '',
    preventability: r.preventability,
    requiredTraining: r.requiredTraining ?? '',
    trainingCompletedOn: r.trainingCompletedOn ?? '',
    notes: r.notes ?? '',
    outcome: r.outcome ?? '',
    followUpOn: r.followUpOn ?? '',
    evidenceNote: r.evidenceNote ?? '',
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <FormField label="Status">
        <Select value={f.status} disabled={!editable} onValueChange={(v) => set('status', v as typeof f.status)} options={[{ value: 'not_started', label: 'Not started' }, { value: 'scheduled', label: 'Scheduled' }, { value: 'in_progress', label: 'In progress' }]} />
      </FormField>
      <FormField label="Scheduled for">
        <DatePicker value={f.scheduledFor || null} disabled={!editable} onIsoChange={(v) => set('scheduledFor', v)} />
      </FormField>
      {r.preventabilityRequired ? (
        <FormField label="Preventability" className="md:col-span-2">
          <Select value={f.preventability} disabled={!editable} onValueChange={(v) => set('preventability', v as typeof f.preventability)} options={PREVENTABILITY_DECISIONS.map((p) => ({ value: p, label: PREVENTABILITY_LABEL[p] }))} />
        </FormField>
      ) : null}
      <FormField label="Required training">
        <Input value={f.requiredTraining} disabled={!editable} onChange={(e) => set('requiredTraining', e.target.value)} placeholder="Defensive driving" />
      </FormField>
      <FormField label="Training completed on">
        <DatePicker value={f.trainingCompletedOn || null} disabled={!editable} onIsoChange={(v) => set('trainingCompletedOn', v)} />
      </FormField>
      <FormField label="Notes" className="md:col-span-2">
        <Textarea rows={3} value={f.notes} disabled={!editable} onChange={(e) => set('notes', e.target.value)} />
      </FormField>
      <FormField label="Outcome" className="md:col-span-2" description="What was decided with the driver. Required to complete.">
        <Textarea rows={2} value={f.outcome} disabled={!editable} onChange={(e) => set('outcome', e.target.value)} />
      </FormField>
      <FormField label="Follow-up date">
        <DatePicker value={f.followUpOn || null} disabled={!editable} onIsoChange={(v) => set('followUpOn', v)} />
      </FormField>
      <FormField label="Evidence">
        <Input value={f.evidenceNote} disabled={!editable} onChange={(e) => set('evidenceNote', e.target.value)} placeholder="Dash cam video (pending)" />
      </FormField>
      {editable ? (
        <div className="md:col-span-2">
          <Button
            variant="primary"
            loading={saving}
            onClick={() =>
              onSave({
                status: f.status,
                scheduledFor: f.scheduledFor || null,
                ...(r.preventabilityRequired ? { preventability: f.preventability } : {}),
                requiredTraining: f.requiredTraining.trim() || null,
                trainingCompletedOn: f.trainingCompletedOn || null,
                notes: f.notes.trim() || null,
                outcome: f.outcome.trim() || null,
                followUpOn: f.followUpOn || null,
                evidenceNote: f.evidenceNote.trim() || null,
              })
            }
          >
            Save action plan
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function NewReviewDialog({ open, onOpenChange, kind, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; kind: SafetyReviewKind; onCreated: (id: string) => void }) {
  const pickers = useSafetyPickers();
  const [driverId, setDriverId] = useState<string | null>(null);
  const [reason, setReason] = useState(kind === 'coaching' ? 'Coaching' : kind === 'corrective_action' ? 'Corrective action' : 'Driver review');
  const [training, setTraining] = useState('');
  const [due, setDue] = useState('');
  const save = useSafetyWrite(
    () => safetyApi.post<SafetyReview>('/reviews', { kind, reason: reason.trim(), driverId, requiredTraining: training.trim() || null, nextActionDueOn: due || null }),
    (r) => `${r.number} opened`,
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`New ${SAFETY_REVIEW_KIND_LABEL[kind].toLowerCase()}`}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={reason.trim().length < 2} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: (r) => { onOpenChange(false); onCreated(r.id); } })}>
            Open
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <FormField label="Driver">
          <Combobox options={(pickers.data?.drivers ?? []).map((d) => ({ value: d.id, label: d.name }))} value={driverId} loading={pickers.isLoading} placeholder="Choose the driver" onValueChange={setDriverId} />
        </FormField>
        <FormField label="Reason" required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        <FormField label="Required training">
          <Input value={training} onChange={(e) => setTraining(e.target.value)} />
        </FormField>
        <FormField label="Due">
          <DatePicker value={due || null} onIsoChange={setDue} />
        </FormField>
      </div>
    </Modal>
  );
}
