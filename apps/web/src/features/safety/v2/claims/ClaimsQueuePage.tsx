import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  CHARGE_QUEUE_SECTIONS,
  CLAIM_KINDS,
  CLAIM_KIND_LABEL,
  DRIVER_CHARGE_BASIS_LABEL,
  isActiveCharge,
  type DriverCharge,
  type SafetyClaim,
} from '@neway/shared';
import { Button, Input, Select, cn } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { NewClaimDialogV2 } from './NewClaimDialog';
import { useCan, useClaims, useDriverCharges } from '../api';
import { LoadError, Loading, money, td, th } from '../ui';
import { ageBuckets, attentionOf, exposureByKind, finOf, isOpen, kpisOf } from './model';
import { BarRow, Kpi, Pill, chargePill, claimStatusOf } from './parts';

/**
 * Claims, one page with queue tabs (Claims v2, owner mockup 2026-10-13): the number cards, then
 * Needs attention / All open / Driver charges / Recoveries / Disputed / My actions / Closed. The
 * queue lives in the URL so a link lands on the same list. Accounting opens on Recoveries.
 */
const QUEUES = ['attention', 'open', 'charges', 'recoveries', 'disputed', 'mine', 'closed'] as const;
type Queue = (typeof QUEUES)[number];
const SUBTITLE: Record<Queue, string> = {
  attention: 'Ranked by risk: what needs someone today.',
  open: 'Every open claim with its next action and owner.',
  charges: 'Every driver deductible and chargeback, from the claim to the last settlement deduction.',
  recoveries: 'Everything owed to us: insurers and drivers.',
  disputed: 'Claims with a disputed charge or decision.',
  mine: 'Claims you own.',
  closed: 'Closed claims.',
};

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function ClaimsQueuePage() {
  const account = useAccount();
  const navigate = useNavigate();
  const raw = useSearch({ strict: false }) as { queue?: string };
  const canAccounting = useCan('accounting.edit');
  const canSafety = useCan('safety.manage');
  const isAccounting = canAccounting && !canSafety;
  const queue: Queue = (QUEUES as readonly string[]).includes(raw.queue ?? '') ? (raw.queue as Queue) : isAccounting ? 'recoveries' : 'attention';
  const setQueue = (q: Queue) => void navigate({ to: '.', search: { queue: q } as never, replace: true });
  const claims = useClaims();
  const charges = useDriverCharges();
  const canWrite = canSafety;
  const [creating, setCreating] = useState(false);
  const today = companyToday();

  const all = claims.data ?? [];
  const allCharges = charges.data ?? [];
  // Test data is listed, never counted: the cards and the attention queue read live claims only.
  const live = useMemo(() => all.filter((c) => !c.isTest), [all]);
  const liveCharges = useMemo(() => allCharges.filter((c) => !c.isTest), [allCharges]);
  const k = useMemo(() => kpisOf(live, liveCharges), [live, liveCharges]);
  const attention = useMemo(() => attentionOf(live, liveCharges, today), [live, liveCharges, today]);
  const [showAll, setShowAll] = useState(false);
  const open = all.filter(isOpen);
  const disputedClaims = open.filter((c) => allCharges.some((x) => x.claimId === c.id && x.state === 'disputed'));
  const mine = open.filter((c) => account && (c.ownerId === account.userId || c.ownerName === account.name));
  const recoveryRows = recoveriesOf(open, allCharges);
  const counts: Record<Queue, number | null> = {
    attention: null,
    open: open.length,
    charges: allCharges.filter((c) => isActiveCharge(c.state)).length,
    recoveries: recoveryRows.length,
    disputed: disputedClaims.length,
    mine: mine.length,
    closed: all.filter((c) => c.stage === 'closed').length,
  };
  const loading = claims.isLoading || charges.isLoading;
  const tile = (v: string | number) => (loading ? '…' : v);

  return (
    <div className="flex w-full flex-col gap-4" data-testid="claims-v2">
      {creating ? <NewClaimDialogV2 onClose={() => setCreating(false)} /> : null}
      <div className="text-xs text-nw-text-3">Safety &amp; Compliance / Claims</div>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-extrabold tracking-[-.02em] text-nw-text">Claims</h1>
          <p className="text-sm text-nw-text-2">{SUBTITLE[queue]}</p>
        </div>
        {canWrite ? (
          <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
            New claim
          </Button>
        ) : null}
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Open claims" value={tile(k.open)} sub={k.openSub} onClick={() => setQueue('open')} active={queue === 'open'} />
        <Kpi label="Total gross exposure" value={tile(dollars(k.gross))} sub="All open claims, incl. insurer-paid" />
        <Kpi label="Projected company net cost" value={tile(dollars(k.net))} sub="If every expected dollar is collected" />
        <Kpi label="Awaiting insurance" value={tile(k.awaitingInsurance)} sub={`${dollars(k.awaitingExpected)} expected to us`} onClick={() => setQueue('recoveries')} />
        <Kpi label="Driver notification pending" value={tile(k.onHold)} sub={`${dollars(k.onHoldCents)} on hold`} tone={k.onHold > 0 ? 'urgent' : 'plain'} onClick={() => setQueue('charges')} />
        <Kpi label="Pending Accounting approval" value={tile(k.pendingAccounting)} sub={dollars(k.pendingAccountingCents)} tone={k.pendingAccounting > 0 ? 'warning' : 'plain'} onClick={() => setQueue('charges')} />
        <Kpi label="Outstanding recoveries" value={tile(dollars(k.outstanding))} sub="Drivers + insurers" tone={k.outstanding > 0 ? 'warning' : 'plain'} onClick={() => setQueue('recoveries')} />
        <Kpi label="Disputed" value={tile(k.disputed)} sub="Driver, broker or carrier disputes" tone={k.disputed > 0 ? 'urgent' : 'plain'} onClick={() => setQueue('disputed')} active={queue === 'disputed'} />
        <Kpi label="No update ≥ 7 days" value={tile(k.stale)} sub="Owner gets a daily reminder" tone={k.stale > 0 ? 'warning' : 'plain'} onClick={() => setQueue('attention')} />
        <Kpi label="Recovered YTD" value={tile(dollars(k.recoveredYtd))} sub="Insurance payments + driver recoveries" tone="good" />
      </div>

      <nav role="tablist" aria-label="Claim queues" className="flex w-full max-w-full gap-0.5 overflow-x-auto rounded-[12px] bg-nw-segment p-1 sm:w-fit">
        {QUEUES.map((q) => (
          <button
            key={q}
            type="button"
            role="tab"
            aria-selected={queue === q}
            onClick={() => setQueue(q)}
            className={cn('inline-flex h-9 shrink-0 items-center gap-2 rounded-[9px] px-3.5 text-[13.5px] font-semibold whitespace-nowrap text-nw-text-2', queue === q && 'bg-nw-panel text-nw-text shadow-(--nw-shadow-segment)')}
            data-testid={`queue-${q}`}
          >
            {{ attention: 'Needs attention', open: 'All open', charges: 'Driver charges', recoveries: 'Recoveries', disputed: 'Disputed', mine: 'My actions', closed: 'Closed' }[q]}
            {counts[q] !== null ? <span className={cn('tabular text-xs font-bold', (q === 'charges' || q === 'disputed') && (counts[q] ?? 0) > 0 ? 'text-nw-urgent-text' : 'text-nw-text-3')}>{loading ? '' : counts[q]}</span> : null}
          </button>
        ))}
      </nav>

      {claims.error ? (
        <LoadError error={claims.error} />
      ) : loading ? (
        <Loading />
      ) : queue === 'attention' ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <section className="overflow-hidden rounded-[12px] border border-nw-border bg-nw-panel" aria-label="Needs attention">
            <header className="flex items-center justify-between border-b border-nw-border px-4 py-3">
              <h2 className="text-[15px] font-bold text-nw-text">Needs attention</h2>
              <span className="text-xs text-nw-text-3">{attention.length} items · sorted by risk</span>
            </header>
            {attention.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-nw-text-3">Nothing needs anyone today.</p>
            ) : (
              <ul className="divide-y divide-nw-border">
                {(showAll ? attention : attention.slice(0, 20)).map((a) => (
                  <li key={a.key} className="flex items-center gap-3 px-4 py-3">
                    <span className={cn('h-10 w-1 shrink-0 rounded-full', a.severity === 2 ? 'bg-nw-urgent-icon' : a.severity === 1 ? 'bg-nw-warning-icon' : 'bg-nw-neutral-icon')} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-bold text-nw-text">{a.title}</span>
                      <span className="block truncate text-xs text-nw-text-3">{a.detail}</span>
                    </span>
                    <Button size="sm" variant="outline" onClick={() => void navigate({ to: '/safety/claims/$claimId', params: { claimId: a.claim.id } })}>
                      Open
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {attention.length > 20 ? (
              <div className="border-t border-nw-border px-4 py-2 text-center">
                <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show the top 20' : `Show all ${attention.length}`}
                </Button>
              </div>
            ) : null}
          </section>
          <div className="flex flex-col gap-4">
            <SideCard title="Open exposure by claim type">
              <ul>
                {(() => {
                  const rows = exposureByKind(live, liveCharges);
                  const max = Math.max(1, ...rows.map((r) => r.cents));
                  return rows.map((r) => <BarRow key={r.label} label={r.label} value={r.cents} share={r.cents / max} display={dollars(r.cents)} />);
                })()}
              </ul>
            </SideCard>
            <SideCard title="Open claim age">
              <ul>
                {(() => {
                  const rows = ageBuckets(live);
                  const max = Math.max(1, ...rows.map((r) => r.count));
                  return rows.map((r) => <BarRow key={r.label} label={r.label} value={r.count} share={r.count / max} display={String(r.count)} />);
                })()}
              </ul>
            </SideCard>
          </div>
        </div>
      ) : queue === 'charges' ? (
        <ChargeSections charges={allCharges} />
      ) : queue === 'recoveries' ? (
        <RecoveriesTable rows={recoveryRows} />
      ) : (
        <ClaimsTable rows={queue === 'open' ? open : queue === 'disputed' ? disputedClaims : queue === 'mine' ? mine : all.filter((c) => c.stage === 'closed')} total={all.length} today={today} />
      )}
    </div>
  );
}

function SideCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[12px] border border-nw-border bg-nw-panel">
      <h2 className="border-b border-nw-border px-4 py-3 text-[15px] font-bold text-nw-text">{title}</h2>
      <div className="px-4 py-2">{children}</div>
    </section>
  );
}

function ClaimsTable({ rows, total, today }: { rows: SafetyClaim[]; total: number; today: string }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  const shown = rows.filter((c) => {
    if (kind !== 'all' && c.kind !== kind) return false;
    if (status !== 'all' && claimStatusOf(c).label !== status) return false;
    const n = q.trim().toLowerCase();
    if (!n) return true;
    return [c.number, c.driverName ?? '', c.truckNumber ?? '', c.loadNumber ?? '', c.insurer ?? '', c.insurerReference ?? '', c.accidentNumber ?? ''].join(' ').toLowerCase().includes(n);
  });
  const statuses = [...new Set(rows.map((c) => claimStatusOf(c).label))];
  return (
    <>
      <section className="overflow-hidden rounded-[12px] border border-nw-border bg-nw-panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-nw-border px-4 py-3">
          <Input size="sm" type="search" prefix={<Search />} aria-label="Search claims" placeholder="Search claim, driver, unit, load, insurer #" value={q} onChange={(e) => setQ(e.target.value)} className="w-80" />
          <Select size="sm" value={kind} onValueChange={setKind} className="w-48" options={[{ value: 'all', label: 'All types' }, ...CLAIM_KINDS.map((k) => ({ value: k, label: CLAIM_KIND_LABEL[k] }))]} />
          <Select size="sm" value={status} onValueChange={setStatus} className="w-48" options={[{ value: 'all', label: 'All statuses' }, ...statuses.map((s) => ({ value: s, label: s }))]} />
          <Button size="sm" variant="outline" onClick={() => { setQ(''); setKind('all'); setStatus('all'); }}>
            Clear
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] border-collapse">
            <thead className="border-b border-nw-border bg-nw-subtle">
              <tr>
                <th className={th}>Claim</th>
                <th className={th}>Type</th>
                <th className={th}>Incident</th>
                <th className={th}>Driver · unit · load</th>
                <th className={th}>Status</th>
                <th className={th}>Driver charge</th>
                <th className={cn(th, 'text-right')}>Exposure</th>
                <th className={cn(th, 'text-right')}>Outstanding</th>
                <th className={th}>Next action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-nw-border">
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-sm text-nw-text-3">
                    {rows.length === 0 ? 'No claims recorded.' : 'No claims match these filters.'}
                  </td>
                </tr>
              ) : (
                shown.map((c) => {
                  const f = finOf(c, c.driverCharge);
                  const st = claimStatusOf(c);
                  const overdue = Boolean(c.nextActionDueOn && c.nextActionDueOn < today);
                  return (
                    <tr key={c.id} className="hover:bg-nw-hover">
                      <td className={td}>
                        <Link to="/safety/claims/$claimId" params={{ claimId: c.id }} className="font-bold whitespace-nowrap text-nw-text hover:underline">
                          {c.number}
                        </Link>
                        {c.isTest ? <span className="ml-1 text-[11px] text-nw-text-3">test</span> : null}
                      </td>
                      <td className={cn(td, 'max-w-[140px]')}>{CLAIM_KIND_LABEL[c.kind]}</td>
                      <td className={cn(td, 'whitespace-nowrap')}>
                        {formatIsoDate(c.openedOn)}
                        {c.accidentNumber ? <span className="block text-xs text-nw-text-3">{c.accidentNumber}</span> : null}
                      </td>
                      <td className={td}>
                        {c.driverName ?? <span className="text-nw-text-3">—</span>}
                        <span className="block text-xs text-nw-text-3">
                          Unit {c.truckNumber ?? '—'} · {c.loadNumber ?? '—'}
                        </span>
                      </td>
                      <td className={td}>
                        <Pill tone={st.tone}>{st.label}</Pill>
                      </td>
                      <td className={td}>
                        {c.driverCharge ? (
                          <>
                            {chargePill(c.driverCharge.state)}
                            <span className="block text-xs text-nw-text-3">{money(c.driverCharge.amountCents)}</span>
                          </>
                        ) : (
                          <span className="text-nw-text-3">None</span>
                        )}
                      </td>
                      <td className={cn(td, 'tabular text-right font-semibold')}>{dollars(f.gross)}</td>
                      <td className={cn(td, 'tabular text-right')}>{f.outstanding > 0 ? dollars(f.outstanding) : '—'}</td>
                      <td className={cn(td, 'max-w-[260px]')}>
                        <span className={cn('block', overdue ? 'font-semibold text-nw-urgent-text' : 'text-nw-text')}>{c.nextAction ?? '—'}</span>
                        <span className="block text-xs text-nw-text-3">
                          {c.ownerName ?? 'Unassigned'}
                          {c.nextActionDueOn ? ` · due ${formatIsoDate(c.nextActionDueOn)}` : ''}
                          {overdue ? ' · overdue' : ''}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
      <div className="text-right text-xs text-nw-text-3">
        Showing {shown.length} of {total} claims
      </div>
    </>
  );
}

function ChargeSections({ charges }: { charges: DriverCharge[] }) {
  return (
    <div className="flex flex-col gap-4" data-testid="charge-sections">
      {CHARGE_QUEUE_SECTIONS.map((section) => {
        const rows = charges.filter((c) => (section.states as readonly string[]).includes(c.state));
        const openCents = rows.reduce((s, c) => s + c.remainingCents, 0);
        return (
          <section key={section.key} className="overflow-hidden rounded-[12px] border border-nw-border bg-nw-panel">
            <header className="flex items-center justify-between border-b border-nw-border px-4 py-3">
              <h2 className="text-[15px] font-bold text-nw-text">{section.label}</h2>
              <span className="text-xs text-nw-text-3">
                {rows.length} · {dollars(openCents)} open
              </span>
            </header>
            {section.note ? <p className="border-b border-nw-border px-4 py-2 text-xs text-nw-text-3">{section.note}</p> : null}
            {rows.length === 0 ? (
              <p className="px-4 py-4 text-sm text-nw-text-3">None.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse">
                  <thead className="bg-nw-subtle">
                    <tr>
                      <th className={th}>Claim</th>
                      <th className={th}>Driver</th>
                      <th className={th}>Basis</th>
                      <th className={th}>Status</th>
                      <th className={cn(th, 'text-right')}>Amount</th>
                      <th className={cn(th, 'text-right')}>Left</th>
                      <th className={cn(th, 'text-right')}>Age</th>
                      <th className={th} />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-nw-border">
                    {rows.map((c) => (
                      <tr key={c.id}>
                        <td className={td}>
                          {c.claimId ? (
                            <Link to="/safety/claims/$claimId" params={{ claimId: c.claimId }} className="font-bold text-nw-accent-ink underline underline-offset-2">
                              {c.claimNumber}
                            </Link>
                          ) : (
                            c.number
                          )}
                          <span className="block text-xs text-nw-text-3">{c.number}</span>
                        </td>
                        <td className={td}>
                          {c.driverName}
                          <span className="block text-xs text-nw-text-3">{c.driverKind === 'company' ? 'Company driver' : 'Owner-operator'}</span>
                        </td>
                        <td className={cn(td, 'max-w-[260px]')}>{DRIVER_CHARGE_BASIS_LABEL[c.basis]}</td>
                        <td className={td}>{chargePill(c.state)}</td>
                        <td className={cn(td, 'tabular text-right')}>{money(c.amountCents)}</td>
                        <td className={cn(td, 'tabular text-right')}>{money(c.remainingCents)}</td>
                        <td className={cn(td, 'tabular text-right', c.state === 'on_hold' && c.ageDays >= 3 && 'font-bold text-nw-urgent-text')}>{c.ageDays}d</td>
                        <td className={cn(td, 'text-right')}>
                          {c.claimId ? (
                            <Button size="sm" variant="outline" asChild>
                              <Link to="/safety/claims/$claimId" params={{ claimId: c.claimId }}>
                                Open
                              </Link>
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

interface RecoveryRow {
  key: string;
  claim: SafetyClaim;
  from: string;
  status: { tone: 'warning' | 'moving' | 'urgent'; label: string };
  expected: number;
}

function recoveriesOf(open: SafetyClaim[], charges: DriverCharge[]): RecoveryRow[] {
  const out: RecoveryRow[] = [];
  for (const c of open) {
    const expected = c.decision && c.decision !== 'denied' ? Math.max(0, (c.approvedCents ?? 0) - c.receivedCents) : 0;
    if (expected > 0) out.push({ key: `${c.id}:ins`, claim: c, from: `${c.insurer ?? 'Insurer'} (insurer)`, status: { tone: 'moving', label: c.receivedCents > 0 ? 'Partly paid' : 'Approved, not paid' }, expected });
    for (const ch of charges.filter((x) => x.claimId === c.id && isActiveCharge(x.state) && x.remainingCents > 0))
      out.push({ key: ch.id, claim: c, from: `${ch.driverName} (driver)`, status: { tone: ch.state === 'disputed' ? 'urgent' : ch.state === 'on_hold' || ch.state === 'pending_accounting' ? 'warning' : 'moving', label: ch.state.replace(/_/g, ' ') }, expected: ch.remainingCents });
  }
  return out;
}

function RecoveriesTable({ rows }: { rows: RecoveryRow[] }) {
  return (
    <section className="overflow-hidden rounded-[12px] border border-nw-border bg-nw-panel">
      <header className="flex items-center justify-between border-b border-nw-border px-4 py-3">
        <h2 className="text-[15px] font-bold text-nw-text">Owed to us</h2>
        <span className="text-xs text-nw-text-3">
          {rows.length} · {dollars(rows.reduce((s, r) => s + r.expected, 0))} expected
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-nw-text-3">Nothing is owed to us on an open claim.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse">
            <thead className="bg-nw-subtle">
              <tr>
                <th className={th}>Claim</th>
                <th className={th}>From</th>
                <th className={th}>Status</th>
                <th className={cn(th, 'text-right')}>Expected</th>
                <th className={th}>Follow-up</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-nw-border">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className={td}>
                    <Link to="/safety/claims/$claimId" params={{ claimId: r.claim.id }} className="font-bold text-nw-accent-ink underline underline-offset-2">
                      {r.claim.number}
                    </Link>
                    <span className="block text-xs text-nw-text-3">{CLAIM_KIND_LABEL[r.claim.kind]}</span>
                  </td>
                  <td className={td}>{r.from}</td>
                  <td className={td}>
                    <Pill tone={r.status.tone} className="capitalize">
                      {r.status.label}
                    </Pill>
                  </td>
                  <td className={cn(td, 'tabular text-right font-semibold')}>{money(r.expected)}</td>
                  <td className={cn(td, 'max-w-[300px]')}>
                    {r.claim.nextAction ?? '—'}
                    <span className="block text-xs text-nw-text-3">{r.claim.ownerName ?? 'Unassigned'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
