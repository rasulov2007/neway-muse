import { AlertTriangle, Link2, Lock } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, Modal, cn } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { ApiError } from '@/lib/api-client';
import { useAccWrite, useBoard, useCase, useCan, usePickers } from './api';
import { claimsApi, dollarsToCents } from './claims-api';
import { newIdempotencyKey } from './labels';
import { Field, NInput, NSelect, Seg } from './ui';

const TYPES: R.ClaimType[] = ['physical_damage', 'auto_liability', 'cargo', 'recovery', 'workers_comp'];
const STANDALONE_TYPES: R.ClaimType[] = ['cargo', 'physical_damage', 'recovery'];

interface LineForm {
  insurer: string;
  claimed: string;
  deductible: string;
  claimant: string;
}
const EMPTY_LINE: LineForm = { insurer: '', claimed: '', deductible: '', claimant: '' };

/**
 * New claim(s) dialog (SPEC §1.5): start from an accident (or one preset by the case) or from no accident; pick every
 * coverage involved — each becomes its own claim, all linked to the same accident. Blank amounts stay "not known".
 * Restricted defaults (workers' comp; auto liability on an accident with injuries) come from the server.
 */
export function NewClaimDialog({ accidentId, onClose, onCreated }: { accidentId?: string; onClose: () => void; onCreated?: (r: A.CreateClaimsResponse) => void }) {
  const canMoney = useCan('accidents.claim_money');
  const [from, setFrom] = useState<'accident' | 'standalone'>('accident');
  const [caseId, setCaseId] = useState(accidentId ?? '');
  const [types, setTypes] = useState<R.ClaimType[]>([]);
  const [lines, setLines] = useState<Partial<Record<R.ClaimType, LineForm>>>({});
  const [kind, setKind] = useState<(typeof A.STANDALONE_KINDS)[number]>('Cargo shortage');
  const [loadId, setLoadId] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<{ number: string; type: string }[] | null>(null);
  const key = useRef(newIdempotencyKey());
  const cases = useBoard({ chip: 'all', range: '12m', pageSize: 200 });
  const openCases = useBoard({ chip: 'open', pageSize: 200 });
  const preset = useCase(caseId);
  const pickers = usePickers(from === 'standalone');
  const caseOptions = useMemo(() => {
    const m = new Map<string, A.BoardRow>();
    for (const r of [...(openCases.data?.items ?? []), ...(cases.data?.items ?? [])]) if (!r.isDraft) m.set(r.id, r);
    return [...m.values()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  }, [cases.data, openCases.data]);
  const existing = preset.data?.computed.claims ?? [];
  const injured = preset.data?.case.injuries.status === 'yes';
  const avail = from === 'standalone' ? STANDALONE_TYPES : TYPES;

  const create = useAccWrite(
    (body: A.CreateClaimsInput) => claimsApi.create(body, key.current),
    (r: A.CreateClaimsResponse) => `${R.plural(r.created.length, 'claim')} opened${r.accidentId ? ` and linked to ${preset.data?.case.number ?? 'the accident'}` : ' (standalone)'} — ${r.created.map((k) => k.number).join(', ')}`,
  );

  const toggle = (t: R.ClaimType) => {
    setTypes((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]));
    setLines((l) => ({ ...l, [t]: l[t] ?? { ...EMPTY_LINE } }));
  };
  const setLine = (t: R.ClaimType, patch: Partial<LineForm>) => setLines((l) => ({ ...l, [t]: { ...(l[t] ?? EMPTY_LINE), ...patch } }));

  const submit = (confirmDuplicate = false) => {
    setError('');
    if (from === 'accident' && !caseId) return setError('Pick the accident');
    if (!types.length) return setError('Pick at least one coverage');
    if (from === 'standalone' && !title.trim()) return setError('Describe what was lost');
    const body: A.CreateClaimsInput = {
      ...(from === 'accident' ? { accidentId: caseId } : { standaloneKind: kind, title: title.trim(), ...(loadId ? { loadId } : {}) }),
      ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
      lines: types.map((t) => {
        const f = lines[t] ?? EMPTY_LINE;
        return {
          type: t,
          ...(f.insurer.trim() ? { insurer: f.insurer.trim() } : {}),
          ...(canMoney && dollarsToCents(f.claimed) !== null ? { claimedCents: dollarsToCents(f.claimed) } : {}),
          ...(canMoney && dollarsToCents(f.deductible) !== null ? { deductibleCents: dollarsToCents(f.deductible) } : {}),
          ...(f.claimant.trim() ? { claimant: f.claimant.trim() } : {}),
        };
      }),
    };
    create.mutate(body, {
      onSuccess: (r) => {
        onCreated?.(r);
        onClose();
      },
      onError: (e) => {
        if (e instanceof ApiError && (e.problem as { type?: string } | null)?.type === '/problems/duplicate-claim-type') {
          setDuplicate(((e.problem as { existing?: { number: string; type: string }[] }).existing ?? []).map((x) => ({ number: x.number, type: x.type })));
        }
      },
    });
  };

  const presetCase = preset.data?.case;
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="lg"
      title={accidentId && presetCase ? `Add claims to ${presetCase.number}` : 'New claim'}
      description="Pick every coverage involved. Each becomes its own claim with its own insurer number, adjuster, reserve and status — all linked to the same accident."
      footer={
        <>
          {error ? (
            <span className="mr-auto inline-flex items-center gap-1 text-xs font-semibold text-nw-urgent-text" role="alert">
              <AlertTriangle className="size-3.5" aria-hidden />
              {error}
            </span>
          ) : (
            <span className="mr-auto" />
          )}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {duplicate ? (
            <Button variant="primary" loading={create.isPending} onClick={() => submit(true)} id="confirm-duplicate">
              Open anyway
            </Button>
          ) : (
            <Button variant="primary" loading={create.isPending} onClick={() => submit(false)} id="open-claims">
              {types.length > 1 ? `Open ${types.length} claims` : 'Open claim'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3" id="new-claim-dialog">
        {!accidentId ? (
          <Field label="Start from">
            <Seg
              id="claim-from"
              ariaLabel="Start from"
              value={from}
              onChange={(v) => {
                if (!v) return;
                setFrom(v);
                setTypes([]);
                setDuplicate(null);
              }}
              options={[
                { v: 'accident', label: 'An accident' },
                { v: 'standalone', label: 'No accident (cargo shortage, theft, damaged freight…)' },
              ]}
            />
          </Field>
        ) : null}
        {from === 'accident' ? (
          accidentId && presetCase ? (
            <div className="flex items-start gap-2 rounded-md bg-nw-subtle px-3 py-2 text-sm text-nw-text">
              <Link2 className="mt-0.5 size-4 text-nw-text-3" aria-hidden />
              <span>
                <b>{presetCase.number}</b> · {preset.data?.display.truck ? `Truck ${preset.data.display.truck.unit} · ` : ''}
                {R.fmtShort(presetCase.occurredAt, presetCase.tz, nowMs())}
                <span className="block text-xs text-nw-text-3">
                  {existing.length ? `Already linked: ${existing.map((k) => `${k.number} (${R.CLAIM_TYPE_LABEL[k.type]})`).join(', ')}` : 'No claims yet'}
                </span>
              </span>
            </div>
          ) : (
            <Field label="Accident" htmlFor="claim-case">
              <NSelect id="claim-case" value={caseId} onChange={(v) => { setCaseId(v); setDuplicate(null); }}>
                <option value="">Pick the accident…</option>
                {caseOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.number} · {r.truck ? `Truck ${r.truck.unit}` : 'no truck'} · {R.fmtShort(r.occurredAt, r.occurredTz, nowMs())} · {r.location.city}, {r.location.state}
                  </option>
                ))}
              </NSelect>
            </Field>
          )
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Kind of loss" htmlFor="standalone-kind">
                <NSelect id="standalone-kind" value={kind} onChange={(v) => setKind(v as (typeof A.STANDALONE_KINDS)[number])}>
                  {(['Cargo shortage', 'Cargo theft', 'Damaged freight', 'Concealed damage', 'Equipment theft / vandalism', 'Other loss'] as const).map((x) => <option key={x}>{x}</option>)}
                </NSelect>
              </Field>
              <Field label="Load (optional)" htmlFor="standalone-load">
                <NSelect id="standalone-load" value={loadId} onChange={setLoadId}>
                  <option value="">None</option>
                  {(pickers.data?.loads ?? []).map((l) => <option key={l.id} value={l.id}>{l.number}{l.customer ? ` · ${l.customer}` : ''}</option>)}
                </NSelect>
              </Field>
            </div>
            <Field label="What was lost" htmlFor="standalone-title" required>
              <NInput id="standalone-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 6 pallets short at delivery, seal intact" />
            </Field>
          </>
        )}
        <div className="text-xs font-bold tracking-wide text-nw-text-2 uppercase">Coverage — pick all that apply</div>
        <div className="flex flex-col gap-2">
          {avail.map((t) => {
            const on = types.includes(t);
            const f = lines[t] ?? EMPTY_LINE;
            const dup = existing.some((k) => k.type === t && R.OPEN_CLAIM(k.status)) || duplicate?.some((x) => x.type === t);
            const restrictedByDefault = t === 'workers_comp' || (t === 'auto_liability' && injured);
            return (
              <div key={t} className={cn('rounded-[10px] border px-3 py-2', on ? 'border-nw-accent bg-nw-accent-tint' : 'border-nw-border bg-nw-panel')}>
                <label className="flex cursor-pointer items-start gap-2">
                  <input type="checkbox" className="mt-1 size-4 accent-[var(--color-nw-accent)]" checked={on} onChange={() => toggle(t)} id={`type-${t}`} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-nw-text">
                      {R.CLAIM_TYPE_LABEL[t]}
                      {restrictedByDefault ? <Lock className="size-3.5 text-nw-text-3" aria-label="Restricted" /> : null}
                    </span>
                    <span className="text-xs text-nw-text-3">
                      {R.CLAIM_TYPE_HINT[t]}
                      {restrictedByDefault ? ' · opened restricted (bodily injury)' : ''}
                      {dup ? <b className="text-nw-warning-text"> · an open claim of this type already exists</b> : null}
                    </span>
                  </span>
                </label>
                {on ? (
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-4">
                    <Field label="Insurer" hint="Blank = the company default">
                      <NInput value={f.insurer} onChange={(e) => setLine(t, { insurer: e.target.value })} aria-label={`Insurer for ${R.CLAIM_TYPE_LABEL[t]}`} />
                    </Field>
                    <Field label={t === 'recovery' ? 'Amount to recover ($)' : 'Claimed amount ($)'} hint={canMoney ? 'Blank = not known yet' : 'Entered by Claims or Accounting'}>
                      <NInput inputMode="decimal" disabled={!canMoney} value={f.claimed} onChange={(e) => setLine(t, { claimed: e.target.value })} id={`claimed-${t}`} />
                    </Field>
                    {t !== 'recovery' ? (
                      <Field label="Deductible ($)" hint="Blank = settings default">
                        <NInput inputMode="decimal" disabled={!canMoney} placeholder={R.money(R.defaultDeductibleCents(t) ?? 0).replace('$', '')} value={f.deductible} onChange={(e) => setLine(t, { deductible: e.target.value })} />
                      </Field>
                    ) : null}
                    {t === 'auto_liability' || t === 'cargo' ? (
                      <Field label="Claimant">
                        <NInput value={f.claimant} onChange={(e) => setLine(t, { claimant: e.target.value })} />
                      </Field>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {duplicate ? (
          <div className="rounded-md bg-nw-warning-bg px-3 py-2 text-xs text-nw-warning-text" role="alert">
            An open claim of this type already exists: {duplicate.map((x) => x.number).join(', ')}. Open another only if it is a separate coverage.
          </div>
        ) : null}
        <p className="text-xs text-nw-text-3">Documents each coverage needs are added to the claim’s checklist automatically. The first follow-up is set for 3 days out.</p>
      </div>
    </Modal>
  );
}
