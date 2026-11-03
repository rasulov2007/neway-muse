import { Pencil, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DEFAULT_POLICY, policyProblems, previewCommission, type CommissionPolicy, type UnitType } from '@neway/shared';
import { Alert, Badge, Button, FormField, Input, cn, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { useCreatePolicyVersion, usePolicy } from './api';
import { AccessPill, BoardBar } from './chrome';
import { GRID, cents, money } from './sheet';

/**
 * The Commission page (owner's brief §8): the policy in force, readable - gross tiers, RPM
 * bonus bands, the RPM penalty, the soft floor, the five-day target, version and dates - and,
 * for administrators, Edit rules: the same tables as fields, validated, previewed on the worked
 * rows, and saved as a new effective-dated version. Older versions stay; finalized weeks keep theirs.
 */
export function CommissionPage() {
  const account = useAccount();
  // Accounting reads the rules (dispatch_pay.view); changing them takes dispatch_pay.edit.
  const canManage = account?.permissions.includes('dispatch_pay.edit') ?? false;
  const policy = usePolicy();
  const [editing, setEditing] = useState(false);
  const current = policy.data?.current;

  return (
    <div className="flex flex-col gap-2">
      <BoardBar current="/dispatch/commission" title="Commission" meta={current ? `${current.policy.ref} · version ${current.version} · effective ${formatIsoDate(current.effectiveFrom)}` : 'Loading…'}>
        <AccessPill canWrite={canManage} canManage={canManage} />
        {canManage && current && !editing ? (
          <Button variant="primary" size="sm" icon={<Pencil />} onClick={() => setEditing(true)}>
            Edit rules
          </Button>
        ) : null}
      </BoardBar>
      {policy.isError ? <Alert tone="danger">The policy could not be loaded.</Alert> : null}
      {!current ? <p className="text-sm text-nw-text-3">Loading…</p> : editing ? <PolicyEditor base={current.policy} onDone={() => setEditing(false)} /> : <PolicyView policy={current.policy} versions={policy.data?.versions ?? []} meta={current} />}
    </div>
  );
}

const TH = cn(GRID.headNavy, 'h-8');
const TD = 'h-8 border-r border-b border-nw-border-strong bg-nw-panel px-2 text-center align-middle text-[12.5px] text-nw-text';

function TierTable({ unit, policy }: { unit: UnitType; policy: CommissionPolicy }) {
  const u = policy[unit];
  const label = unit === 'solo' ? 'Solo' : 'Team';
  const rows = [
    { range: `Positive gross below ${money(u.softFloor)}`, name: 'Below floor', pct: policy.belowFloorPct, note: `Flat ${policy.belowFloorPct.toFixed(2)} % · no RPM rules · no bonus` },
    ...u.tiers.map((t, i) => {
      const next = u.tiers[i + 1];
      return {
        range: next ? `${money(t.from)} – ${money(next.from - 0.01)}` : `${money(t.from)} and above`,
        name: t.name,
        pct: t.pct,
        note: `RPM below $${policy.rpmNoPay.toFixed(2)} → no payment · below $${u.rpmMin.toFixed(2)} → ${policy.reducedPct.toFixed(2)} %`,
      };
    }),
  ];
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-[13px] font-extrabold text-nw-text">
        {label} gross tiers <span className="font-semibold text-nw-text-2">· weekly target {money(u.goal)} · RPM minimum ${u.rpmMin.toFixed(2)}</span>
      </h2>
      <div className={GRID.frame}>
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr>
              <th className={TH}>Weekly gross / truck</th>
              <th className={TH}>Category</th>
              <th className={TH}>Base %</th>
              <th className={cn(TH, 'border-r-0')}>RPM rule</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td className={cn(TD, 'tabular')}>{r.range}</td>
                <td className={cn(TD, 'font-semibold')}>{r.name}</td>
                <td className={cn(TD, 'tabular font-bold')}>{r.pct.toFixed(2)}%</td>
                <td className={cn(TD, 'border-r-0 text-left text-nw-text-2')}>{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BonusTable({ unit, policy }: { unit: UnitType; policy: CommissionPolicy }) {
  const u = policy[unit];
  const label = unit === 'solo' ? 'Solo' : 'Team';
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-[13px] font-extrabold text-nw-text">
        {label} RPM bonus <span className="font-semibold text-nw-text-2">· from {money(u.bonusFrom)} weekly gross · no verified complaint that week</span>
      </h2>
      <div className={GRID.frame}>
        <table className="w-full min-w-[420px] border-collapse">
          <thead>
            <tr>
              <th className={TH}>Weighted avg RPM</th>
              <th className={cn(TH, 'border-r-0')}>Added to base</th>
            </tr>
          </thead>
          <tbody>
            {u.rpmBonus.map((b, i) => {
              const next = u.rpmBonus[i + 1];
              return (
                <tr key={b.from}>
                  <td className={cn(TD, 'tabular')}>{next ? `$${b.from.toFixed(2)} – $${(next.from - 0.01).toFixed(2)}` : `$${b.from.toFixed(2)} and above`}</td>
                  <td className={cn(TD, 'tabular border-r-0 font-bold')}>+{b.addPct.toFixed(2)} pts</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PolicyView({ policy, versions, meta }: { policy: CommissionPolicy; versions: { id: string; version: string; effectiveFrom: string; note: string; createdByName: string; createdAt: string }[]; meta: { createdByName: string; createdAt: string; note: string } }) {
  const preview = useMemo(() => previewCommission(policy), [policy]);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <TierTable unit="solo" policy={policy} />
        <TierTable unit="team" policy={policy} />
        <BonusTable unit="solo" policy={policy} />
        <BonusTable unit="team" policy={policy} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Note title="RPM penalty">
          Above the floor, RPM below ${policy.rpmNoPay.toFixed(2)} pays nothing for the week. RPM from ${policy.rpmNoPay.toFixed(2)} up to the minimum (${policy.solo.rpmMin.toFixed(2)} solo / ${policy.team.rpmMin.toFixed(2)} team) reduces the base rate to {policy.reducedPct.toFixed(2)} % with no bonus. RPM is compared exactly; only its display is rounded.
        </Note>
        <Note title="Soft floor">
          A truck under {money(policy.solo.softFloor)} (solo) or {money(policy.team.softFloor)} (team) pays a flat {policy.belowFloorPct.toFixed(2)} % of gross whatever its RPM: {money(9_200)} gross pays {money(92)}. Gross is linehaul only - no fuel surcharge, detention or reimbursements.
        </Note>
        <Note title="Five-day target">
          The weekly target ({money(policy.solo.goal)} solo / {money(policy.team.goal)} team) is built around {policy.workDays} active days: {money(policy.solo.goal / policy.workDays)} a day for a solo truck. Plan Adj on the board scales the goal by days worked; HOME, VACATION, SHOP, INACTIVE, STOP and NO ANSWER take a day off, REST does not.
        </Note>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-1.5">
          <h2 className="text-[13px] font-extrabold text-nw-text">Monthly bonuses and penalties</h2>
          <div className={GRID.frame}>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={TH}>Item</th>
                  <th className={cn(TH, 'border-r-0')}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {policy.laneBonus.map((l) => (
                  <tr key={l.above}>
                    <td className={cn(TD, 'text-left')}>Dedicated lane volume above {money(l.above)} / month (approved after a verified month)</td>
                    <td className={cn(TD, 'tabular border-r-0 font-bold text-nw-done-text')}>+{money(l.amount)}</td>
                  </tr>
                ))}
                {policy.penalties.map((p) => (
                  <tr key={p.code}>
                    <td className={cn(TD, 'text-left')}>{p.label} (after management review; carries forward, never capped at earnings)</td>
                    <td className={cn(TD, 'tabular border-r-0 font-bold text-nw-urgent-text')}>−{money(p.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td className={cn(TD, 'text-left')}>Junior dispatcher: flat rate above the floor while assigned; forfeiture needs an explicit admin decision</td>
                  <td className={cn(TD, 'tabular border-r-0 font-bold')}>{policy.juniorPct.toFixed(2)}%</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section className="flex flex-col gap-1.5">
          <h2 className="text-[13px] font-extrabold text-nw-text">Worked examples under this version</h2>
          <PreviewTable rows={preview} />
        </section>
      </div>
      <section className="flex flex-col gap-1.5">
        <h2 className="text-[13px] font-extrabold text-nw-text">Versions</h2>
        <div className={GRID.frame}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>Version</th>
                <th className={TH}>Effective from</th>
                <th className={TH}>Saved by</th>
                <th className={TH}>Saved at</th>
                <th className={cn(TH, 'border-r-0')}>Note</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td className={cn(TD, 'font-semibold')}>
                    {v.version}
                    {v.version === policy.version ? (
                      <Badge tone="success" size="sm" className="ml-1">
                        in force
                      </Badge>
                    ) : null}
                  </td>
                  <td className={TD}>{formatIsoDate(v.effectiveFrom)}</td>
                  <td className={TD}>{v.createdByName}</td>
                  <td className={TD}>{v.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className={cn(TD, 'border-r-0 text-left text-nw-text-2')}>{v.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="text-[11.5px] text-nw-text-3">
          Last updated by {meta.createdByName} · {meta.createdAt.slice(0, 16).replace('T', ' ')}
        </span>
      </section>
    </div>
  );
}

function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border border-nw-border-strong bg-nw-panel p-3">
      <h3 className="text-[12px] font-extrabold tracking-[.04em] text-nw-accent-ink uppercase">{title}</h3>
      <p className="mt-1 text-[12.5px] leading-5 text-nw-text-2">{children}</p>
    </section>
  );
}

function PreviewTable({ rows }: { rows: ReturnType<typeof previewCommission> }) {
  return (
    <div className={GRID.frame}>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={TH}>Case</th>
            <th className={TH}>Rate</th>
            <th className={TH}>Commission</th>
            <th className={cn(TH, 'border-r-0')}>Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className={cn(TD, 'text-left font-semibold')}>{r.label}</td>
              <td className={cn(TD, 'tabular')}>{r.result.pct.toFixed(2)}%</td>
              <td className={cn(TD, 'tabular font-bold', r.result.status === 'needs_miles' && 'text-nw-warning-text')}>{r.result.status === 'needs_miles' ? 'Needs miles' : cents(r.result.amountCents)}</td>
              <td className={cn(TD, 'border-r-0 text-left text-[12px] text-nw-text-2')}>{r.result.formula}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------------------ the editor

type Draft = CommissionPolicy;

function PolicyEditor({ base, onDone }: { base: CommissionPolicy; onDone: () => void }) {
  const { toast } = useToast();
  const create = useCreatePolicyVersion();
  const [draft, setDraft] = useState<Draft>(() => JSON.parse(JSON.stringify(base)) as Draft);
  const [version, setVersion] = useState(() => companyToday());
  const [effectiveFrom, setEffectiveFrom] = useState(() => companyToday());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const problems = useMemo(() => policyProblems(draft), [draft]);
  const preview = useMemo(() => (problems.length === 0 ? previewCommission(draft) : []), [draft, problems]);

  const num = (v: string) => {
    const n = Number(v.replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const setUnit = (unit: UnitType, patch: Partial<CommissionPolicy['solo']>) => setDraft({ ...draft, [unit]: { ...draft[unit], ...patch } });
  const save = async () => {
    setError(null);
    if (!version.trim()) return setError('Give the version a label');
    try {
      await create.mutateAsync({ version: version.trim(), effectiveFrom, note: note.trim(), policy: draft });
      toast({ tone: 'success', title: `Policy version ${version.trim()} saved`, description: `Effective ${effectiveFrom}. Earlier weeks keep the version they were priced under.` });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not saved');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 rounded-[10px] border border-nw-border-strong bg-nw-panel p-3 sm:grid-cols-4">
        <FormField label="Version label" required>
          <Input size="sm" value={version} onChange={(e) => setVersion(e.target.value)} />
        </FormField>
        <FormField label="Effective from" required description="Weeks starting on or after this Monday use it">
          <Input size="sm" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </FormField>
        <FormField label="Note" className="sm:col-span-2">
          <Input size="sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why" />
        </FormField>
      </div>
      <div className="grid gap-3 rounded-[10px] border border-nw-border-strong bg-nw-panel p-3 sm:grid-cols-5">
        <NumberField label="No-payment RPM" value={draft.rpmNoPay} onChange={(v) => setDraft({ ...draft, rpmNoPay: v })} step="0.01" />
        <NumberField label="Below-floor %" value={draft.belowFloorPct} onChange={(v) => setDraft({ ...draft, belowFloorPct: v })} step="0.01" />
        <NumberField label="Reduced %" value={draft.reducedPct} onChange={(v) => setDraft({ ...draft, reducedPct: v })} step="0.01" />
        <NumberField label="Junior %" value={draft.juniorPct} onChange={(v) => setDraft({ ...draft, juniorPct: v })} step="0.01" />
        <NumberField label="Working days" value={draft.workDays} onChange={(v) => setDraft({ ...draft, workDays: Math.round(v) })} step="1" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {(['solo', 'team'] as UnitType[]).map((unit) => {
          const u = draft[unit];
          return (
            <section key={unit} className="flex flex-col gap-2 rounded-[10px] border border-nw-border-strong bg-nw-panel p-3">
              <h2 className="text-[13px] font-extrabold text-nw-text">{unit === 'solo' ? 'Solo' : 'Team'}</h2>
              <div className="grid grid-cols-4 gap-2">
                <NumberField label="Weekly goal $" value={u.goal} onChange={(v) => setUnit(unit, { goal: v })} />
                <NumberField label="Soft floor $" value={u.softFloor} onChange={(v) => setUnit(unit, { softFloor: v, tiers: u.tiers.map((t, i) => (i === 0 ? { ...t, from: v } : t)) })} />
                <NumberField label="RPM minimum" value={u.rpmMin} onChange={(v) => setUnit(unit, { rpmMin: v })} step="0.01" />
                <NumberField label="Bonus from $" value={u.bonusFrom} onChange={(v) => setUnit(unit, { bonusFrom: v })} />
              </div>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={TH}>From $</th>
                    <th className={TH}>Name</th>
                    <th className={TH}>Base %</th>
                    <th className={cn(TH, 'w-10 border-r-0')} />
                  </tr>
                </thead>
                <tbody>
                  {u.tiers.map((t, i) => (
                    <tr key={i}>
                      <td className={cn(TD, 'p-1')}>
                        <Input size="sm" value={String(t.from)} onChange={(e) => setUnit(unit, { tiers: u.tiers.map((x, j) => (j === i ? { ...x, from: num(e.target.value) } : x)), ...(i === 0 ? { softFloor: num(e.target.value) } : {}) })} className="text-center" />
                      </td>
                      <td className={cn(TD, 'p-1')}>
                        <Input size="sm" value={t.name} onChange={(e) => setUnit(unit, { tiers: u.tiers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                      </td>
                      <td className={cn(TD, 'p-1')}>
                        <Input size="sm" value={String(t.pct)} onChange={(e) => setUnit(unit, { tiers: u.tiers.map((x, j) => (j === i ? { ...x, pct: num(e.target.value) } : x)) })} className="text-center" />
                      </td>
                      <td className={cn(TD, 'border-r-0 p-1')}>
                        <button type="button" aria-label="Remove tier" disabled={u.tiers.length <= 1} onClick={() => setUnit(unit, { tiers: u.tiers.filter((_, j) => j !== i) })} className="text-nw-text-3 hover:text-nw-urgent-text disabled:opacity-30">
                          <X className="size-4" aria-hidden />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button size="sm" variant="secondary" className="self-start" onClick={() => setUnit(unit, { tiers: [...u.tiers, { from: (u.tiers[u.tiers.length - 1]?.from ?? 0) + 2000, pct: u.tiers[u.tiers.length - 1]?.pct ?? 1, name: 'New tier' }] })}>
                Add gross tier
              </Button>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={TH}>RPM from</th>
                    <th className={TH}>Adds pts</th>
                    <th className={cn(TH, 'w-10 border-r-0')} />
                  </tr>
                </thead>
                <tbody>
                  {u.rpmBonus.map((b, i) => (
                    <tr key={i}>
                      <td className={cn(TD, 'p-1')}>
                        <Input size="sm" value={String(b.from)} onChange={(e) => setUnit(unit, { rpmBonus: u.rpmBonus.map((x, j) => (j === i ? { ...x, from: num(e.target.value) } : x)) })} className="text-center" />
                      </td>
                      <td className={cn(TD, 'p-1')}>
                        <Input size="sm" value={String(b.addPct)} onChange={(e) => setUnit(unit, { rpmBonus: u.rpmBonus.map((x, j) => (j === i ? { ...x, addPct: num(e.target.value) } : x)) })} className="text-center" />
                      </td>
                      <td className={cn(TD, 'border-r-0 p-1')}>
                        <button type="button" aria-label="Remove band" onClick={() => setUnit(unit, { rpmBonus: u.rpmBonus.filter((_, j) => j !== i) })} className="text-nw-text-3 hover:text-nw-urgent-text">
                          <X className="size-4" aria-hidden />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button size="sm" variant="secondary" className="self-start" onClick={() => setUnit(unit, { rpmBonus: [...u.rpmBonus, { from: (u.rpmBonus[u.rpmBonus.length - 1]?.from ?? u.rpmMin) + 0.5, addPct: (u.rpmBonus[u.rpmBonus.length - 1]?.addPct ?? 0) + 0.25 }] })}>
                Add RPM band
              </Button>
            </section>
          );
        })}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2 rounded-[10px] border border-nw-border-strong bg-nw-panel p-3">
          <h2 className="text-[13px] font-extrabold text-nw-text">Lane bonus tiers</h2>
          {draft.laneBonus.map((l, i) => (
            <div key={i} className="grid grid-cols-2 gap-2">
              <NumberField label="Volume above $" value={l.above} onChange={(v) => setDraft({ ...draft, laneBonus: draft.laneBonus.map((x, j) => (j === i ? { ...x, above: v } : x)) })} />
              <NumberField label="Bonus $" value={l.amount} onChange={(v) => setDraft({ ...draft, laneBonus: draft.laneBonus.map((x, j) => (j === i ? { ...x, amount: v } : x)) })} />
            </div>
          ))}
        </section>
        <section className="flex flex-col gap-2 rounded-[10px] border border-nw-border-strong bg-nw-panel p-3">
          <h2 className="text-[13px] font-extrabold text-nw-text">Penalties</h2>
          {draft.penalties.map((p, i) => (
            <div key={p.code} className="grid grid-cols-2 gap-2">
              <FormField label="Label">
                <Input size="sm" value={p.label} onChange={(e) => setDraft({ ...draft, penalties: draft.penalties.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              </FormField>
              <NumberField label="Amount $" value={p.amount} onChange={(v) => setDraft({ ...draft, penalties: draft.penalties.map((x, j) => (j === i ? { ...x, amount: v } : x)) })} />
            </div>
          ))}
        </section>
      </div>
      {problems.length > 0 ? (
        <Alert tone="warning">
          <ul className="list-disc pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      ) : (
        <section className="flex flex-col gap-1.5">
          <h2 className="text-[13px] font-extrabold text-nw-text">Preview under the draft</h2>
          <PreviewTable rows={preview} />
        </section>
      )}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={() => setDraft(JSON.parse(JSON.stringify(DEFAULT_POLICY)) as Draft)}>
          Reset to the document
        </Button>
        <Button variant="primary" disabled={problems.length > 0} loading={create.isPending} onClick={() => void save()}>
          Save as new version
        </Button>
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step?: string }) {
  const [text, setText] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    // The parent changed the number (a reset, a linked field): show it. Set during render, the React way.
    setSeen(value);
    setText(String(value));
  }
  return (
    <FormField label={label}>
      <Input
        size="sm"
        type="number"
        step={step ?? '1'}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </FormField>
  );
}

