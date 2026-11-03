import { Camera, Check, FileText, Info, Link2, X } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, Modal, cn, useToast } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { nowMs } from '@/lib/clock';
import { uploadFile } from '@/lib/files';
import { accApi, accKeys, fieldErrors, problemText, useCan, usePickers } from './api';
import { newIdempotencyKey } from './labels';
import { DeptChip, Field, NInput, NSelect, NTextarea, Seg, ToneBadge, TriField } from './ui';

/**
 * Quick accident report (SPEC §1.3, prototype screens/Report.tsx) — a new Safety employee files it in about a minute.
 * The rail's live check and "Do now" prompts run the shared rules in the browser for instant feedback; the server
 * recomputes everything on save (it is the source of truth) and creates the tasks. Drafts create nothing for other
 * departments. Telematics (Samsara collision events) is not offered: NeWay has no such feed (A3 N/A).
 */

interface Form {
  truckId: string;
  driverId: string;
  trailerId: string;
  loadId: string;
  assignmentSource: string;
  local: string;
  tz: string;
  tzTouched: boolean;
  choice: string;
  road: string;
  city: string;
  state: string;
  publicRoad: R.Tri;
  type: string;
  description: string;
  injuries: R.Tri;
  treatedAway: string;
  fatalities: string;
  ourDriver: R.Tri;
  towAway: R.Tri;
  truckCondition: 'drivable' | 'not_drivable' | 'unknown';
  cargo: R.CargoState['status'];
  police: R.Tri;
  citation: R.Tri;
  hazmat: R.Tri;
  hazmatNote: string;
  /** "Post-accident alcohol and drug test required?" (owner, 2026-10-24). */
  ptRequired: 'yes' | 'no' | null;
  ptAlcohol: string;
  ptDrug: string;
  ptReason: string;
}

const emptyForm = (): Form => ({
  truckId: '',
  driverId: '',
  trailerId: '',
  loadId: '',
  assignmentSource: '',
  local: R.isoToLocalInput(new Date(Math.floor(nowMs() / 300_000) * 300_000).toISOString(), R.EASTERN),
  tz: R.EASTERN,
  tzTouched: false,
  choice: '',
  road: '',
  city: '',
  state: '',
  publicRoad: null,
  type: '',
  description: '',
  injuries: null,
  treatedAway: '',
  fatalities: '',
  ourDriver: null,
  towAway: null,
  truckCondition: 'unknown',
  cargo: 'unknown',
  police: null,
  citation: null,
  hazmat: null,
  hazmatNote: '',
  ptRequired: null,
  ptAlcohol: '',
  ptDrug: '',
  ptReason: '',
});

function fromDraft(d: A.CaseDetailResponse): Form {
  const c = d.case;
  const unit = d.units.find((u) => u.unitKind === 'truck');
  return {
    ...emptyForm(),
    truckId: c.truckId ?? '',
    driverId: c.driverId ?? '',
    trailerId: c.trailerId ?? '',
    loadId: c.loadId ?? '',
    assignmentSource: c.assignmentSource ?? '',
    local: R.isoToLocalInput(c.occurredAt, c.tz),
    tz: c.tz,
    tzTouched: true,
    road: c.location.road ?? '',
    city: c.location.city,
    state: c.location.state,
    publicRoad: c.location.publicRoad,
    type: c.type === 'Other' ? '' : c.type,
    description: c.description,
    injuries: c.injuries.status,
    treatedAway: c.injuries.treatedAway === null ? '' : String(c.injuries.treatedAway),
    fatalities: c.injuries.fatalities === null ? '' : String(c.injuries.fatalities),
    ourDriver: c.injuries.ourDriver,
    towAway: c.towAway,
    truckCondition: unit?.conditionAtScene ?? 'unknown',
    cargo: c.cargo.status,
    police: c.police.responded,
    citation: c.citation.status,
    hazmat: c.hazmat,
    // Safety already marked the tests required (Testing panel): the answer was Yes.
    ptRequired: c.testing.alcohol.decision === 'required' || c.testing.drug.decision === 'required' ? 'yes' : null,
    ptReason: c.testing.alcohol.notAdministeredReason ?? c.testing.drug.notAdministeredReason ?? '',
  };
}

const RESULT_OPTIONS = [
  { v: '', label: 'Not known yet' },
  { v: 'pending', label: 'Pending at the lab' },
  { v: 'negative', label: 'Negative' },
  { v: 'positive', label: 'Positive' },
  { v: 'refused', label: 'Refused' },
  { v: 'cancelled', label: 'Cancelled' },
];

const count = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.floor(Number(s))));

export function ReportModal({ onClose, onCreated, draft }: { onClose: () => void; onCreated: (id: string, submitted: boolean) => void; draft?: A.CaseDetailResponse }) {
  const { toast } = useToast();
  const client = useQueryClient();
  const pickers = usePickers(true);
  const [f, setF] = useState<Form>(() => (draft ? fromDraft(draft) : emptyForm()));
  const [files, setFiles] = useState<File[]>([]);
  const [testFile, setTestFile] = useState<File | null>(null);
  const canResults = useCan('accidents.restricted');
  const [promptState, setPromptState] = useState<Record<string, { create: boolean; done: boolean }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [started] = useState(nowMs);
  const [idemKey] = useState(newIdempotencyKey);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));

  const P = pickers.data;
  const load = P?.loads.find((l) => l.id === f.loadId);
  const truck = P?.trucks.find((t) => t.id === f.truckId);
  const conv = f.local ? R.localToUtc(f.local, f.tz, f.choice || undefined) : null;
  const occurredIso = conv && conv.ok ? conv.iso : null;

  const facts: R.ReportFacts = {
    occurredAt: occurredIso,
    tz: f.tz,
    publicRoad: f.publicRoad,
    city: f.city,
    state: f.state,
    injuries: f.injuries,
    treatedAway: count(f.treatedAway),
    fatalities: count(f.fatalities),
    ourDriverInjured: f.ourDriver,
    towAway: f.towAway,
    truckCondition: f.truckCondition,
    cargo: f.cargo,
    hazmat: f.hazmat,
    police: f.police,
    citation: f.citation,
    loadId: f.loadId || null,
    loadParty: load?.broker || load?.customer || null,
  };
  const now = nowMs();
  const live = R.reportLiveCheck(facts, { now });
  const prompts = R.reportPrompts(facts, { now });
  const ps = (k: string) => promptState[k] ?? { create: true, done: false };
  const zone = f.state ? R.zoneForState(f.state) : null;
  const ptHint = R.postAccidentIntakeHint(live.testing, f.ptRequired);

  const pickTruck = async (id: string) => {
    set({ truckId: id });
    if (!id) return;
    try {
      const a = await accApi.assignment({ truckId: id });
      setF((x) => {
        const p: Partial<Form> = {};
        if (!x.driverId && a.driverId) p.driverId = a.driverId;
        if (!x.trailerId && a.trailerId) p.trailerId = a.trailerId;
        if (!x.loadId && a.loadId) p.loadId = a.loadId;
        if (a.source) p.assignmentSource = a.source;
        const l = P?.loads.find((y) => y.id === (p.loadId ?? x.loadId));
        const pre = R.hazmatPrefill(l ? ({ id: l.id, number: l.number, hazmat: l.hazmat } as R.Load) : undefined, x.hazmat);
        if (pre) Object.assign(p, { hazmat: pre.value, hazmatNote: pre.hint });
        return { ...x, ...p };
      });
      setNote(a.note);
    } catch {
      setNote(null);
    }
  };
  const pickDriver = async (id: string) => {
    set({ driverId: id });
    if (!id || f.truckId) return;
    const a = await accApi.assignment({ driverId: id }).catch(() => null);
    if (a?.truckId) await pickTruck(a.truckId);
  };
  const pickLoad = (id: string) => {
    const l = P?.loads.find((y) => y.id === id);
    const pre = R.hazmatPrefill(l ? ({ id: l.id, number: l.number, hazmat: l.hazmat } as R.Load) : undefined, f.hazmat);
    set({ loadId: id, ...(pre ? { hazmat: pre.value, hazmatNote: pre.hint } : {}) });
  };
  const setState = (st: string) => {
    const z = R.zoneForState(st);
    set({ state: st, ...(!f.tzTouched && z.tz ? { tz: z.tz } : {}) });
  };

  const validate = (submit: boolean): boolean => {
    const e: Record<string, string> = {};
    if (conv && !conv.ok) e.occurredAtLocal = conv.message;
    if (submit) {
      if (!f.truckId && !f.driverId) e.truckId = 'Pick the truck or the driver';
      if (!f.local) e.occurredAtLocal = 'Enter the date and time it happened';
      else if (occurredIso && Date.parse(occurredIso) > nowMs() + 5 * 60_000) e.occurredAtLocal = 'This time is in the future — check the time zone';
      if (!f.city.trim() && !f.road.trim()) e.road = 'Enter a road or a city';
      if (!f.state) e.state = 'Pick the state';
      if (f.description.trim().length < 10) e.description = 'Describe what happened in a sentence or two';
      for (const issue of R.postAccidentIntakeIssues({ required: f.ptRequired, submitted: Boolean(testFile), notDoneReason: f.ptReason }, { submit })) e[issue.path] = issue.message;
    } else if (!f.truckId && !f.driverId && !f.description.trim()) e.truckId = 'Add at least the truck, driver or a line about what happened';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  /** `withTest` false for a draft re-save (PATCH carries no test answer; it is stored when the draft is submitted). */
  const body = async (withTest = true): Promise<Omit<A.ReportInput, 'submit'>> => {
    const uploads: NonNullable<A.ReportInput['uploads']> = [];
    for (const file of files) {
      const stored = await uploadFile(file);
      uploads.push({ fileId: stored.id, category: file.type.startsWith('video') ? 'Dashcam / video' : file.type.startsWith('image') ? 'Damage photo' : 'Other' });
    }
    const yes = f.ptRequired === 'yes';
    const testFileId = withTest && yes && testFile ? (await uploadFile(testFile)).id : null;
    const postAccidentTest: A.ReportInput['postAccidentTest'] = withTest && f.ptRequired
      ? {
          required: f.ptRequired,
          fileId: testFileId,
          ...(yes && canResults && f.ptAlcohol ? { alcoholResult: f.ptAlcohol as A.PostAccidentTestInput['alcoholResult'] } : {}),
          ...(yes && canResults && f.ptDrug ? { drugResult: f.ptDrug as A.PostAccidentTestInput['drugResult'] } : {}),
          notDoneReason: yes && !testFileId ? f.ptReason.trim() || null : null,
        }
      : undefined;
    return {
      truckId: f.truckId || null,
      driverId: f.driverId || null,
      trailerId: f.trailerId || null,
      loadId: f.loadId || null,
      assignmentSource: f.assignmentSource || null,
      occurredAtLocal: f.local || null,
      occurredTz: f.tz,
      ...(f.choice ? { occurredChoice: f.choice } : {}),
      publicRoad: f.publicRoad,
      road: f.road || null,
      city: f.city || null,
      state: f.state || null,
      accidentType: f.type || null,
      description: f.description,
      injuries: f.injuries,
      treatedAway: f.injuries === 'yes' ? count(f.treatedAway) : null,
      fatalities: f.injuries === 'yes' ? count(f.fatalities) : null,
      ourDriverInjured: f.ourDriver,
      towAway: f.towAway,
      truckCondition: f.truckCondition,
      cargo: f.cargo,
      hazmat: f.hazmat,
      police: f.police,
      citation: f.citation,
      uploads,
      prompts: prompts.map((p) => ({ key: p.key, create: ps(p.key).create, done: ps(p.key).done })),
      ...(postAccidentTest ? { postAccidentTest } : {}),
    };
  };

  const save = async (submit: boolean) => {
    setTried(true);
    if (!validate(submit)) return;
    setBusy(true);
    try {
      const b = await body(submit || !draft);
      let res: A.ReportResponse | { id: string; version: number };
      if (draft) {
        res = submit
          ? await accApi.submit(draft.case.id, { version: draft.version, report: b })
          : await accApi.patch(draft.case.id, { version: draft.version, ...b, uploads: undefined, prompts: undefined } as A.PatchAccidentInput);
      } else {
        res = await accApi.report({ ...b, submit }, idemKey);
      }
      await client.invalidateQueries({ queryKey: accKeys.all });
      const secs = Math.round((nowMs() - started) / 1000);
      if (submit && 'tasksCreated' in res) {
        toast({ tone: 'success', title: `Accident reported in ${secs < 120 ? `${secs}s` : `${Math.round(secs / 60)} min`} · ${res.tasksCreated} tasks assigned`, description: `${res.number}${res.requestsCreated ? ' · Dispatch asked to mark the truck unavailable' : ''}` });
      } else toast({ tone: 'success', title: 'Draft saved — finish it any time from the Drafts chip' });
      onCreated(res.id, submit);
    } catch (error) {
      const fe = fieldErrors(error);
      if (Object.keys(fe).length) setErrors(fe);
      else toast({ tone: 'danger', title: error instanceof ApiError && error.status === 409 ? 'Not saved — the draft changed' : 'Not saved', description: problemText(error) });
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await accApi.post(draft.case.id, 'discard', { version: draft.version });
      await client.invalidateQueries({ queryKey: accKeys.all });
      toast({ tone: 'success', title: 'Draft discarded', description: 'Kept on record as voided; nothing was sent to other departments.' });
      onClose();
    } catch (error) {
      toast({ tone: 'danger', title: 'Not discarded', description: problemText(error) });
    } finally {
      setBusy(false);
    }
  };

  const errCount = Object.keys(errors).length;
  const convertHint = occurredIso ? `= ${R.fmtTime(occurredIso, R.EASTERN)} · ${R.fmtTime(occurredIso, R.TASHKENT, false)} Tashkent` : undefined;
  const loads = (P?.loads ?? []).filter((l) => !f.truckId || l.truckId === f.truckId || l.id === f.loadId);

  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="lg"
      className="max-w-[1060px]"
      title={draft ? `Finish draft ${draft.case.number}` : 'Report an accident'}
      description="About a minute. Save what you know now — every answer can be completed or corrected later."
      dismissible={!busy}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {tried && errCount > 0 ? (
            <span className="text-xs font-semibold text-nw-urgent-text" role="alert">
              {errCount === 1 ? '1 thing' : `${errCount} things`} to fix before submitting
            </span>
          ) : null}
          {draft ? (
            confirmDiscard ? (
              <span className="flex items-center gap-1.5 text-xs text-nw-text-2">
                Discard {draft.case.number}? Nothing has been sent to other departments yet.
                <Button size="sm" variant="secondary" onClick={() => setConfirmDiscard(false)}>Keep</Button>
                <Button size="sm" variant="danger" loading={busy} onClick={() => void discard()}>Discard</Button>
              </span>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDiscard(true)}>Discard draft</Button>
            )
          ) : null}
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="secondary" icon={<FileText />} onClick={() => void save(false)} loading={busy} id="save-draft">Save draft</Button>
          <Button variant="primary" icon={<Check />} onClick={() => void save(true)} loading={busy} id="submit-report">Submit report</Button>
        </div>
      }
    >
      <div className="grid max-h-[70vh] grid-cols-1 gap-4 overflow-y-auto lg:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Section n={1} title="Truck & driver">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Truck" required error={errors.truckId} htmlFor="r-truck">
                <NSelect id="r-truck" value={f.truckId} onChange={(v) => void pickTruck(v)} disabled={pickers.isLoading}>
                  <option value="">{pickers.isLoading ? 'Loading…' : 'Pick a truck'}</option>
                  {(P?.trucks ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      Truck {t.unit}
                      {t.driverName ? ` — ${t.driverName}` : ''} · {t.status}
                    </option>
                  ))}
                </NSelect>
              </Field>
              <Field label="Driver" htmlFor="r-driver">
                <NSelect id="r-driver" value={f.driverId} onChange={(v) => void pickDriver(v)} disabled={pickers.isLoading}>
                  <option value="">{pickers.isLoading ? 'Loading…' : 'Pick a driver'}</option>
                  {(P?.drivers ?? []).map((d) => {
                    const t = P?.trucks.find((x) => x.id === d.truckId);
                    return (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {t ? ` · Truck ${t.unit}` : ''}
                      </option>
                    );
                  })}
                </NSelect>
              </Field>
            </div>
            {note && truck ? (
              <div className="flex items-start gap-2 rounded-md bg-nw-accent-tint px-3 py-2 text-xs text-nw-accent-ink" id="autofill">
                <Link2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{note}</span>
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Trailer" htmlFor="r-trailer">
                <NSelect id="r-trailer" value={f.trailerId} onChange={(v) => set({ trailerId: v })}>
                  <option value="">No trailer (bobtail)</option>
                  {(P?.trailers ?? []).map((t) => <option key={t.id} value={t.id}>{t.unit}</option>)}
                </NSelect>
              </Field>
              <Field label="Load" htmlFor="r-load" hint={load ? [load.customer, load.commodity].filter(Boolean).join(' · ') : undefined}>
                <NSelect id="r-load" value={f.loadId} onChange={pickLoad}>
                  <option value="">No load / empty</option>
                  {loads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.number}
                      {l.origin && l.destination ? ` · ${l.origin} → ${l.destination}` : ''}
                    </option>
                  ))}
                </NSelect>
              </Field>
            </div>
          </Section>

          <Section n={2} title="When & where">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Date and time (local to the accident)" required error={errors.occurredAtLocal} hint={convertHint} htmlFor="r-time">
                <NInput id="r-time" type="datetime-local" value={f.local} onChange={(e) => set({ local: e.target.value, choice: '' })} />
              </Field>
              <Field label="Time zone" htmlFor="r-tz" hint={zone?.confirmHint ?? (f.state ? 'Set from the state' : undefined)}>
                <NSelect id="r-tz" value={f.tz} onChange={(v) => set({ tz: v, tzTouched: true, choice: '' })}>
                  {R.TZ_CHOICES.map((z) => <option key={z.tz} value={z.tz}>{z.label}</option>)}
                </NSelect>
              </Field>
              <Field label="Road open to public travel?" hint="Public roads and private roads open to the public count (49 CFR 390.5 “highway”); gated yards and lots closed to the public do not">
                <TriField id="r-public" ariaLabel="Road open to public travel" value={f.publicRoad} onChange={(v) => set({ publicRoad: v })} />
              </Field>
            </div>
            {conv && !conv.ok && conv.error === 'ambiguous' ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-nw-warning-text">
                {conv.message}
                {conv.options.map((o) => (
                  <Button key={o.abbr} size="sm" variant="secondary" onClick={() => set({ choice: o.abbr })}>
                    {o.abbr}
                  </Button>
                ))}
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Road, mile marker or address" error={errors.road} htmlFor="r-road">
                <NInput id="r-road" value={f.road} placeholder="e.g. I-80 EB near MM 127" onChange={(e) => set({ road: e.target.value })} />
              </Field>
              <Field label="City or nearest town" htmlFor="r-city">
                <NInput id="r-city" value={f.city} onChange={(e) => set({ city: e.target.value })} />
              </Field>
              <Field label="State" required error={errors.state} htmlFor="r-state">
                <NSelect id="r-state" value={f.state} onChange={setState}>
                  <option value="">Pick…</option>
                  {R.US_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
                </NSelect>
              </Field>
            </div>
          </Section>

          <Section n={3} title="What happened">
            <Field label="In the driver’s words" required error={errors.description} htmlFor="r-what" hint="Write what is known. Don’t guess at fault — that is decided in the investigation.">
              <NTextarea id="r-what" rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="e.g. Traffic stopped suddenly near the work zone; truck hit the back of a box truck. Nobody hurt." />
            </Field>
            <Field label="Accident type (optional now)" htmlFor="r-type">
              <NSelect id="r-type" value={f.type} onChange={(v) => set({ type: v })}>
                <option value="">Decide later</option>
                {R.ACCIDENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </NSelect>
            </Field>
          </Section>

          <Section n={4} title="Injuries & condition">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Anyone injured or killed?">
                <TriField id="r-inj" ariaLabel="Anyone injured or killed" value={f.injuries} onChange={(v) => set({ injuries: v })} />
              </Field>
              <Field label="Any vehicle towed with disabling damage?" hint="Ours or the other party’s">
                <TriField id="r-tow" ariaLabel="Any vehicle towed with disabling damage" value={f.towAway} onChange={(v) => set({ towAway: v })} />
              </Field>
            </div>
            {f.injuries === 'yes' ? (
              <div className="grid grid-cols-1 gap-3 border-l-2 border-nw-border pl-3 sm:grid-cols-3">
                <Field label="People treated away from the scene" hint="Leave blank if not known yet" htmlFor="r-away">
                  <NInput id="r-away" type="number" min={0} value={f.treatedAway} onChange={(e) => set({ treatedAway: e.target.value })} />
                </Field>
                <Field label="Fatalities" hint="People killed. Leave blank if not known yet" htmlFor="r-fatal">
                  <NInput id="r-fatal" type="number" min={0} value={f.fatalities} onChange={(e) => set({ fatalities: e.target.value })} />
                </Field>
                <Field label="Is our driver injured?">
                  <TriField ariaLabel="Is our driver injured" value={f.ourDriver} onChange={(v) => set({ ourDriver: v })} />
                </Field>
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Truck condition">
                <Seg ariaLabel="Truck condition" value={f.truckCondition} onChange={(v) => set({ truckCondition: v ?? 'unknown' })} options={[{ v: 'drivable', label: 'Drivable' }, { v: 'not_drivable', label: 'Not drivable' }, { v: 'unknown', label: 'Unknown' }]} />
              </Field>
              <Field label="Cargo">
                <Seg ariaLabel="Cargo" value={f.cargo === 'loss' ? 'damaged' : f.cargo} onChange={(v) => set({ cargo: v ?? 'unknown' })} options={[{ v: 'no_damage', label: 'No damage' }, { v: 'damaged', label: 'Damaged' }, { v: 'unknown', label: 'Unknown' }, { v: 'na', label: 'Empty' }]} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Police at the scene?">
                <TriField ariaLabel="Police at the scene" value={f.police} onChange={(v) => set({ police: v })} />
              </Field>
              <Field label="Our driver cited?" hint="Affects post-accident testing">
                <TriField ariaLabel="Our driver cited" value={f.citation} onChange={(v) => set({ citation: v })} />
              </Field>
              <Field label="Hazardous material released?" hint={f.hazmatNote || 'Excludes fuel from the truck’s own tanks'}>
                <TriField ariaLabel="Hazardous material released" value={f.hazmat} onChange={(v) => set({ hazmat: v, hazmatNote: '' })} />
              </Field>
            </div>
          </Section>

          <Section n={5} title="Post-accident testing">
            <Field label={R.POST_ACCIDENT_TEST_QUESTION} required error={errors['postAccidentTest.required']} hint={ptHint.text}>
              <Seg
                id="r-pt"
                ariaLabel={R.POST_ACCIDENT_TEST_QUESTION}
                value={f.ptRequired}
                options={[{ v: 'yes', label: 'Yes' }, { v: 'no', label: 'No' }]}
                onChange={(v) => set({ ptRequired: v })}
              />
            </Field>
            {ptHint.conflict ? (
              <p className="text-xs font-semibold text-nw-warning-text" role="status" id="r-pt-conflict">
                From these facts 49 CFR 382.303 requires the tests — answering No does not switch that off; the case will still show them as required.
              </p>
            ) : null}
            {f.ptRequired === 'yes' ? (
              <div className="flex flex-col gap-3 border-l-2 border-nw-border pl-3">
                <Field label="Test submission (result or custody form)" hint="Kept as a restricted test record on the case" htmlFor="r-pt-file">
                  <label className="flex cursor-pointer flex-wrap items-center gap-2 rounded-md border border-dashed border-nw-border-strong px-3 py-2 text-sm text-nw-text-2 hover:bg-nw-hover">
                    <FileText className="size-4" aria-hidden />
                    {testFile ? testFile.name : 'Choose the test result — PDF or photo'}
                    <input id="r-pt-file" type="file" accept="image/*,application/pdf" className="sr-only" onChange={(e) => setTestFile(e.target.files?.[0] ?? null)} />
                  </label>
                </Field>
                {testFile ? (
                  <button type="button" className="self-start text-xs font-semibold text-nw-accent-ink underline" onClick={() => setTestFile(null)}>
                    Remove {testFile.name}
                  </button>
                ) : null}
                {canResults ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Alcohol result" htmlFor="r-pt-alc">
                      <NSelect id="r-pt-alc" value={f.ptAlcohol} onChange={(v) => set({ ptAlcohol: v })}>
                        {RESULT_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                      </NSelect>
                    </Field>
                    <Field label="Drug result" htmlFor="r-pt-drug">
                      <NSelect id="r-pt-drug" value={f.ptDrug} onChange={(v) => set({ ptDrug: v })}>
                        {RESULT_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                      </NSelect>
                    </Field>
                  </div>
                ) : (
                  <p className="text-xs text-nw-text-3">Results are restricted; Safety records them on the case’s Testing panel.</p>
                )}
                {!testFile ? (
                  <Field label="Why was the test not done?" required error={errors['postAccidentTest.notDoneReason']} hint="Required when the test is required but nothing is submitted (49 CFR 382.303(d))" htmlFor="r-pt-reason">
                    <NTextarea id="r-pt-reason" rows={2} value={f.ptReason} onChange={(e) => set({ ptReason: e.target.value })} placeholder="e.g. Driver was taken to hospital; collector could not reach him within 32 hours" />
                  </Field>
                ) : null}
              </div>
            ) : null}
          </Section>

          <Section n={6} title="Photos & files">
            <label className="flex cursor-pointer flex-wrap items-center gap-2 rounded-md border border-dashed border-nw-border-strong px-3 py-3 text-sm text-nw-text-2 hover:bg-nw-hover">
              <Camera className="size-4" aria-hidden />
              Drop or choose photos, video or PDF — they upload when the report is saved.
              <input type="file" multiple accept="image/*,video/*,application/pdf" className="sr-only" onChange={(e) => setFiles((x) => [...x, ...Array.from(e.target.files ?? [])].slice(0, 12))} />
            </label>
            {files.length ? (
              <ul className="flex flex-wrap gap-2">
                {files.map((file, i) => (
                  <li key={`${file.name}-${i}`} className="inline-flex items-center gap-1 rounded-md bg-nw-subtle px-2 py-1 text-xs text-nw-text-2">
                    {file.name}
                    <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>
                      <X className="size-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        </div>

        <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-0">
          <div className="rounded-[10px] border border-nw-border bg-nw-subtle p-3" id="live-check">
            <h4 className="mb-2 text-xs font-bold tracking-wide text-nw-text-2 uppercase">Live check</h4>
            <LiveRow label="DOT recordable" tone={live.dotRecordable.value === 'yes' ? 'urgent' : live.dotRecordable.value === 'no' ? 'done' : 'warning'} word={live.dotRecordable.value === 'yes' ? 'Yes' : live.dotRecordable.value === 'no' ? 'No' : 'To be determined'} why={live.dotRecordable.value === 'pending' ? `Needs: ${live.dotRecordable.missing.join('; ').toLowerCase()}` : live.dotRecordable.reasons.join('; ')} />
            {(['alcohol', 'drug'] as const).map((k) => {
              const x = live.testing[k];
              return (
                <LiveRow
                  key={k}
                  label={k === 'alcohol' ? 'Alcohol test' : 'Drug test'}
                  tone={x.required === 'yes' ? 'urgent' : x.required === 'no' ? 'neutral' : 'warning'}
                  word={x.required === 'yes' ? 'Required' : x.required === 'no' ? 'Not required' : 'Pending'}
                  why={`${x.reason}${x.required !== 'no' && occurredIso ? ` · window closes ${R.fmtTime(x.deadline, f.tz)}${x.windowOpen ? ` (${R.durationLabel(Date.parse(x.deadline) - now)} left)` : ' — closed'}` : ''}`}
                />
              );
            })}
            <LiveRow label="Suggested severity" tone={live.suggestedSeverity.value === 'minor' ? 'neutral' : live.suggestedSeverity.value === 'moderate' ? 'warning' : 'urgent'} word={R.SEVERITY_LABEL[live.suggestedSeverity.value]} why={live.suggestedSeverity.why} />
          </div>
          <div className="rounded-[10px] border border-nw-border bg-nw-panel p-3" id="prompts">
            <h4 className="mb-2 text-xs font-bold tracking-wide text-nw-text-2 uppercase">
              Do now <span className="font-semibold normal-case text-nw-text-3">· each becomes a task</span>
            </h4>
            <ul className="flex flex-col gap-2">
              {prompts.map((p) => {
                const st = ps(p.key);
                return (
                  <li key={p.key} className={cn('rounded-md border px-2 py-1.5', p.tone === 'urgent' ? 'border-nw-urgent-border bg-nw-urgent-bg' : 'border-nw-border')}>
                    <label className="flex items-start gap-2 text-sm text-nw-text">
                      <input type="checkbox" className="mt-1" checked={st.create} onChange={(e) => setPromptState((x) => ({ ...x, [p.key]: { ...st, create: e.target.checked } }))} />
                      <span>{p.label}</span>
                    </label>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-5">
                      <DeptChip dept={p.dept} />
                      <span className="text-xs text-nw-text-3">{p.why}</span>
                      <button
                        type="button"
                        aria-pressed={st.done}
                        onClick={() => setPromptState((x) => ({ ...x, [p.key]: { create: true, done: !st.done } }))}
                        className={cn('ml-auto h-6 rounded-[6px] px-2 text-xs font-semibold', st.done ? 'bg-nw-done-bg text-nw-done-text' : 'bg-nw-subtle text-nw-text-2')}
                      >
                        {st.done ? 'Done already' : 'Mark done'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 flex gap-1 text-xs text-nw-text-3">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
              These reminders support the team. They do not replace 911, the driver’s emergency steps, or any legally required report.
            </p>
          </div>
        </aside>
      </div>
    </Modal>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-sm font-bold text-nw-text">
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-nw-accent-tint text-xs text-nw-accent-ink">{n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function LiveRow({ label, tone, word, why }: { label: string; tone: string; word: string; why: string }) {
  return (
    <div className="border-b border-nw-border py-1.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2 text-sm text-nw-text">
        <span>{label}</span>
        <ToneBadge tone={tone}>{word}</ToneBadge>
      </div>
      <div className="mt-0.5 text-xs text-nw-text-3">{why}</div>
    </div>
  );
}
