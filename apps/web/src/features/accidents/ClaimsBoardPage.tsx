import { AlertTriangle, CheckCircle2, Clock, DollarSign, Lock, Plus, RefreshCw, Scale, Search, Shield } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, cn } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { useCan } from './api';
import { ClaimDrawer } from './ClaimDrawer';
import { claimStatusTone } from './labels';
import { useClaims, useClaimsSummary } from './claims-api';
import { NewClaimDialog } from './NewClaimDialog';
import { DueText, Empty, LoadError, Loading, NInput, NSelect, Panel, Person, Seg, ToneBadge } from './ui';

/**
 * Claims board (SPEC §1.5, prototype screens/Claims.tsx) — behind `accidents_v2`, at the existing /safety/claims URL.
 * Every number is the server's (shared claimMoney over the claim payments). `?claim=<id>` opens the drawer.
 */
const CHIPS: [A.ClaimChip, string][] = [
  ['needs_follow_up', 'Needs follow-up'],
  ['open', 'Open'],
  ['money_to_us', 'Money coming to us'],
  ['settled', 'Settled & closed'],
  ['all', 'All'],
];
const EMPTY = { q: '', type: '', status: '', insurer: '' };

export function ClaimsBoardPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { claim?: string };
  const canCreate = useCan('accidents.edit');
  const [chip, setChip] = useState<A.ClaimChip>('open');
  const [origin, setOrigin] = useState<'all' | 'accident' | 'standalone'>('all');
  const [f, setF] = useState(EMPTY);
  const [newOpen, setNewOpen] = useState(false);
  const selected = search.claim ?? null;
  const setSelected = (id: string | null) => void navigate({ to: '/safety/claims', search: id ? { claim: id } : {} } as never);
  const query = useMemo(() => {
    const q: Record<string, string> = { chip };
    if (origin !== 'all') q.origin = origin;
    for (const [k, v] of Object.entries(f)) if (v) q[k] = v;
    return q as A.ClaimListQuery;
  }, [chip, origin, f]);
  const list = useClaims(query);
  const summary = useClaimsSummary();
  const k = summary.data;
  const loading = 'Loading…';
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-nw-text-3">Safety &amp; Compliance / Claims</div>
          <h1 className="text-[22px] font-extrabold tracking-[-.022em] text-nw-text">Claims</h1>
          <p className="text-sm text-nw-text-2">Every insurance claim and recovery — linked to its accident, or standalone for cargo losses with no accident.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={<AlertTriangle />} onClick={() => void navigate({ to: '/safety/accidents' })}>
            Accident board
          </Button>
          {canCreate ? (
            <Button variant="primary" icon={<Plus />} id="new-claim" onClick={() => setNewOpen(true)}>
              New claim
            </Button>
          ) : null}
        </div>
      </header>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6" id="claim-kpis">
        <Kpi id="ck-open" icon={<Scale />} label="Open claims" value={k ? k.open.value : loading} sub={k ? `${k.open.fromAccidents} from accidents · ${k.open.standalone} standalone` : ''} onClick={() => setChip('open')} active={chip === 'open'} />
        <Kpi id="ck-recover" icon={<RefreshCw />} label="Still to recover" value={k ? R.money(k.stillToRecoverCents, { compact: true }) : loading} sub="From insurers and other parties" onClick={() => setChip('money_to_us')} active={chip === 'money_to_us'} />
        <Kpi id="ck-share" icon={<DollarSign />} label="Our share still to pay" value={k ? R.money(k.ourShareCents, { compact: true }) : loading} sub="Deductibles and direct settlements" />
        <Kpi id="ck-reserve" icon={<Shield />} label="Insurer reserves" value={k ? R.money(k.insurerReservesCents, { compact: true }) : loading} sub={k?.restrictedExcluded ? `Exposure above our deductibles · excludes ${R.plural(k.restrictedExcluded, 'restricted claim')}` : 'Exposure above our deductibles'} />
        <Kpi id="ck-ytd" icon={<CheckCircle2 />} label={`Recovered ${k?.recoveredYear.year ?? ''}`} value={k ? R.money(k.recoveredYear.cents, { compact: true }) : loading} sub="Insurance payments and recoveries received" />
        <Kpi
          id="ck-stale"
          icon={<Clock />}
          tone={k?.needsFollowUp.value ? 'warning' : undefined}
          label="Needs follow-up"
          value={k ? k.needsFollowUp.value : loading}
          sub={k ? `${k.needsFollowUp.noUpdate} no update ≥ ${k.noUpdateDays} days · ${k.needsFollowUp.followUpsOverdue} follow-ups overdue` : ''}
          onClick={() => setChip('needs_follow_up')}
          active={chip === 'needs_follow_up'}
        />
      </div>
      <Panel pad={false} id="claims-board">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-nw-border px-4 py-3">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Claims">
            {CHIPS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={chip === key}
                onClick={() => setChip(key)}
                className={cn('h-7 rounded-full px-3 text-xs font-semibold', chip === key ? 'bg-nw-accent text-nw-on-accent' : 'bg-nw-subtle text-nw-text-2 hover:text-nw-text')}
              >
                {label}
                {list.data ? <span className="ml-1 opacity-80">{list.data.counts[key]}</span> : null}
              </button>
            ))}
          </div>
          <Seg
            size="sm"
            id="claim-link-filter"
            ariaLabel="Origin"
            value={origin}
            onChange={(v) => v && setOrigin(v)}
            options={[
              { v: 'all', label: 'All' },
              { v: 'accident', label: 'From accidents' },
              { v: 'standalone', label: 'Standalone' },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-nw-border px-4 py-2.5">
          <label className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-nw-text-3" aria-hidden />
            <NInput id="claim-search" className="pl-8" placeholder="Search claim, insurer number, claimant, accident…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Search claims" />
          </label>
          <NSelect id="claim-type-filter" ariaLabel="Type" className="w-auto" value={f.type} onChange={(v) => setF({ ...f, type: v })}>
            <option value="">All types</option>
            {(['physical_damage', 'auto_liability', 'cargo', 'recovery', 'workers_comp'] as const).map((t) => <option key={t} value={t}>{R.CLAIM_TYPE_LABEL[t]}</option>)}
          </NSelect>
          <NSelect id="claim-status-filter" ariaLabel="Status" className="w-auto" value={f.status} onChange={(v) => setF({ ...f, status: v })}>
            <option value="">Any status</option>
            {R.CLAIM_STATUSES.map((x) => <option key={x}>{x}</option>)}
          </NSelect>
          <NSelect ariaLabel="Insurer" className="w-auto" value={f.insurer} onChange={(v) => setF({ ...f, insurer: v })}>
            <option value="">Any insurer</option>
            {(list.data?.insurers ?? []).map((x) => <option key={x}>{x}</option>)}
          </NSelect>
          {Object.values(f).some(Boolean) ? <Button size="sm" variant="ghost" onClick={() => setF(EMPTY)}>Clear</Button> : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-sm" id="claims-table">
            <thead className="border-b border-nw-border text-xs font-semibold text-nw-text-3">
              <tr>
                {['Claim', 'Type', 'Accident', 'Insurer / claimant', 'Status', 'Claimed', 'Reserve', 'Paid / received', 'Next follow-up', 'Updated'].map((h, i) => (
                  <th key={h} className={cn('px-3 py-2 font-semibold', i >= 5 && i <= 7 ? 'text-right' : '')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.isLoading ? (
                <tr><td colSpan={10}><Loading /></td></tr>
              ) : list.error ? (
                <tr><td colSpan={10} className="p-3"><LoadError error={list.error} /></td></tr>
              ) : (list.data?.items.length ?? 0) === 0 ? (
                <tr><td colSpan={10}><Empty title="No claims match">Change the chip or clear the filters. New claims start from an accident or as a standalone loss.</Empty></td></tr>
              ) : (
                list.data!.items.map((r) => <ClaimRowView key={r.id} r={r} selected={selected === r.id} onOpen={() => setSelected(r.id)} />)
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      {selected ? <ClaimDrawer claimId={selected} onClose={() => setSelected(null)} /> : null}
      {newOpen ? <NewClaimDialog onClose={() => setNewOpen(false)} onCreated={(r) => r.created[0] && setSelected(r.created[0].id)} /> : null}
    </div>
  );
}

function ClaimRowView({ r, selected, onOpen }: { r: A.ClaimRow; selected: boolean; onOpen: () => void }) {
  const navigate = useNavigate();
  const lock = r.redacted.length > 0;
  return (
    <tr
      tabIndex={0}
      data-claim={r.number}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className={cn('cursor-pointer border-b border-nw-border align-top last:border-b-0 hover:bg-nw-hover focus-visible:bg-nw-hover focus-visible:outline-none', selected ? 'bg-nw-selected' : '')}
    >
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5 font-bold whitespace-nowrap text-nw-accent-ink">
          {r.number}
          {r.restricted ? <Lock className="size-3 text-nw-text-3" aria-label="Restricted" /> : null}
          {r.isTest ? <ToneBadge tone="neutral">Test data</ToneBadge> : null}
        </div>
        <div className="text-xs whitespace-nowrap text-nw-text-3">Opened {R.fmtShort(r.openedAt, R.EASTERN, nowMs())}</div>
      </td>
      <td className="px-3 py-2">
        <div className="text-nw-text">{R.CLAIM_TYPE_LABEL[r.type]}</div>
        <div className="max-w-[220px] truncate text-xs text-nw-text-3" title={r.title}>{r.title}</div>
      </td>
      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
        {r.accident ? (
          <>
            <button type="button" className="font-semibold text-nw-accent-ink hover:underline" onClick={() => void navigate({ to: '/safety/accidents/$accidentId', params: { accidentId: r.accident!.id }, search: { tab: 'claims' } } as never)}>
              {r.accident.number}
            </button>
            <div className="text-xs text-nw-text-3">{R.STAGE_LABEL[r.accident.stage]}</div>
          </>
        ) : (
          <>
            <span className="text-nw-text-3">Standalone</span>
            {r.standaloneKind ? <div className="text-xs text-nw-text-3">{r.standaloneKind}</div> : null}
          </>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="max-w-[200px] truncate text-nw-text">{r.insurer || 'Insurer not set'}</div>
        <div className="max-w-[200px] truncate text-xs text-nw-text-3">
          {r.insurerClaimNo || 'No insurer # yet'}
          {r.claimant ? ` · ${r.claimant}` : ''}
        </div>
      </td>
      <td className="px-3 py-2"><ToneBadge tone={claimStatusTone(r.status)}>{r.status}</ToneBadge></td>
      <td className="px-3 py-2 text-right tabular-nums">{lock ? <Lock className="ml-auto size-3 text-nw-text-3" aria-label="Restricted" /> : R.money(r.claimedCents)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{lock ? <Lock className="ml-auto size-3 text-nw-text-3" aria-label="Restricted" /> : R.money(r.reserveCents)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{lock ? <Lock className="ml-auto size-3 text-nw-text-3" aria-label="Restricted" /> : R.money(r.paidOrReceivedCents)}</td>
      <td className="px-3 py-2">
        {r.nextFollowUp ? (
          <>
            <div className="max-w-[200px] truncate text-nw-text">{r.nextFollowUp.what ?? 'Follow-up (restricted)'}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {r.nextFollowUp.assignee ? <Person name={r.nextFollowUp.assignee.name} /> : null}
              <DueText iso={r.nextFollowUp.at} />
            </div>
          </>
        ) : (
          <span className="text-xs text-nw-text-3">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        {r.staleDays !== null ? <ToneBadge tone="warning">{r.staleDays} days</ToneBadge> : <span className="text-xs text-nw-text-3">{R.ago(r.lastUpdateAt, nowMs())}</span>}
      </td>
    </tr>
  );
}

function Kpi({ id, icon, label, value, sub, onClick, active, tone }: { id: string; icon: ReactNode; label: string; value: ReactNode; sub: ReactNode; onClick?: () => void; active?: boolean; tone?: 'warning' }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      id={id}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn('flex min-w-0 flex-col gap-1 rounded-[10px] border bg-nw-panel p-3 text-left shadow-sm', active ? 'border-nw-accent' : 'border-nw-border', onClick ? 'cursor-pointer hover:bg-nw-hover' : '')}
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold text-nw-text-2">
        <span className={cn('[&_svg]:size-3.5', tone === 'warning' ? 'text-nw-warning-icon' : 'text-nw-text-3')}>{icon}</span>
        {label}
      </span>
      <span className="text-[24px] leading-tight font-extrabold text-nw-text">{value}</span>
      <span className="text-xs text-nw-text-3">{sub}</span>
    </Tag>
  );
}
