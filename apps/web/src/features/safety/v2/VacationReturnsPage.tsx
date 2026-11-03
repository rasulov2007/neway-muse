import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { ArrowRight, CalendarDays, Check, Clock, FileText, Inbox, Info, Search, TriangleAlert, Upload } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  RETURN_DRUG_TEST_AFTER_DAYS,
  VACATION_RETURN_STATE_LABEL,
  VACATION_RETURN_STATES,
  type VacationReturnDetail,
  type VacationReturnList,
  type VacationReturnState,
} from '@neway/shared';
import { Badge, Button, Drawer, ErrorState, Input, Select, StatusSymbol, Textarea, cn, type StatusSymbolFamily } from '@/design-system';
import { apiGet } from '@/lib/api-client';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { safetyApi, useCan, useSafetyWrite } from './api';
import { fromEasternInput } from './time';

/**
 * Vacation return reviews, the owner's minimal redesign (2026-10-19): three status cards, the
 * drivers in a plain table, and Review opening a side panel with the checklist, the test-result
 * upload and notes. Clear for dispatch lights up once the required items are done. COMPANY
 * POLICY: a driver away 30+ days is drug tested before the next load; separate from the DOT
 * return-to-duty programme. Clearance is shown, not enforced on load assignment (2026-10-17).
 */

const STATE_FAMILY: Record<VacationReturnState, StatusSymbolFamily> = {
  test_required: 'warning',
  appointment_scheduled: 'moving',
  result_pending: 'moving',
  result_received: 'info',
  cleared: 'done',
  not_cleared: 'urgent',
};

function StateBadge({ state }: { state: VacationReturnState }) {
  const family = STATE_FAMILY[state];
  const tone = family === 'done' ? 'success' : family === 'urgent' ? 'danger' : family === 'warning' ? 'warning' : 'info';
  return (
    <Badge tone={tone} size="sm" icon={<StatusSymbol family={family} size={12} />}>
      {VACATION_RETURN_STATE_LABEL[state]}
    </Badge>
  );
}

const NOTE_MAX = 500;

export function VacationReturnsPage() {
  const list = useQuery({ queryKey: ['safety-v2', 'vacation-returns'], queryFn: () => apiGet<VacationReturnList>('/safety/vacation-returns') });
  const [q, setQ] = useState('');
  const [state, setState] = useState<string>('all');
  // ?vacation= opens that driver's review (from the vacation list and the driver page).
  const linked = (useSearch({ strict: false }) as { vacation?: string }).vacation ?? null;
  const [open, setOpen] = useState<string | null>(linked);
  const all = list.data?.rows ?? [];
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => (state === 'all' || r.state === state) && (!needle || `${r.vacation.driverName} ${r.vacation.unitNumber ?? ''}`.toLowerCase().includes(needle)));
  }, [all, q, state]);

  return (
    <div className="flex w-full flex-col gap-5" data-testid="vacation-returns-page">
      <header>
        <nav aria-label="Breadcrumb" className="mb-2 text-sm text-nw-text-3">
          <Link to="/safety" className="hover:text-nw-text hover:underline">
            Safety
          </Link>
          <span className="mx-2">/</span>
          <span className="text-nw-text-2">Vacation returns</span>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[28px] leading-tight font-bold text-nw-text">Vacation return reviews</h1>
          <span className="rounded-full bg-nw-segment px-2.5 py-0.5 text-xs font-semibold text-nw-text-2">{RETURN_DRUG_TEST_AFTER_DAYS}+ days away</span>
        </div>
        <p className="mt-1 text-[15px] text-nw-text-2">Review returning drivers before dispatch clearance.</p>
      </header>

      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Awaiting review" value={list.data?.counts.awaitingReview} icon={<Clock className="size-5" />} tone="warning" />
            <StatCard label="Test pending" value={list.data?.counts.testPending} icon={<FileText className="size-5" />} tone="warning" />
            <StatCard label="Cleared this week" value={list.data?.counts.clearedThisWeek} icon={<Check className="size-5" />} tone="done" />
          </div>

          {!list.isPending && all.length === 0 ? (
            <div className="flex flex-col items-center gap-1 rounded-[10px] border border-dashed border-nw-border-strong px-6 py-10 text-center" data-testid="vacation-returns-empty">
              <Inbox className="mb-1 size-7 text-nw-text-3" aria-hidden />
              <p className="font-bold text-nw-text">No vacation returns to review</p>
              <p className="text-sm text-nw-text-2">Drivers returning after {RETURN_DRUG_TEST_AFTER_DAYS}+ days away will appear here.</p>
            </div>
          ) : (
            <section aria-label="Return review queue" className="rounded-[10px] border border-nw-border bg-nw-panel">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <h2 className="text-lg font-bold text-nw-text">Return review queue</h2>
                <div className="flex flex-wrap gap-2">
                  <Input size="sm" prefix={<Search />} placeholder="Search driver or unit…" aria-label="Search driver or unit" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
                  <Select
                    size="sm"
                    aria-label="Status"
                    value={state}
                    onValueChange={setState}
                    className="w-44"
                    options={[{ value: 'all', label: 'All statuses' }, ...VACATION_RETURN_STATES.map((s) => ({ value: s, label: VACATION_RETURN_STATE_LABEL[s] }))]}
                  />
                </div>
              </div>
              {list.isPending ? (
                <p className="px-5 pb-5 text-sm text-nw-text-3">Loading…</p>
              ) : rows.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-nw-text-3">No review matches. Clear the search or the status.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="vacation-return-queue">
                    <thead className="border-y border-nw-border bg-nw-subtle text-left text-[13px] text-nw-text-2">
                      <tr>
                        <th className="px-5 py-2.5 font-semibold">Driver</th>
                        <th className="px-3 py-2.5 font-semibold">Unit</th>
                        <th className="px-3 py-2.5 font-semibold">Away</th>
                        <th className="px-3 py-2.5 font-semibold">Return date</th>
                        <th className="px-3 py-2.5 font-semibold">Status</th>
                        <th className="px-5 py-2.5 text-right font-semibold">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-nw-border">
                      {rows.map((r) => {
                        const v = r.vacation;
                        const back = v.endedOn ?? v.expectedReturnOn;
                        return (
                          <tr key={v.id} className={cn(open === v.id ? 'bg-nw-accent-tint' : 'hover:bg-nw-hover')}>
                            <td className="px-5 py-3 font-semibold text-nw-text">{v.driverName}</td>
                            <td className="px-3 py-3 tabular-nums">{v.unitNumber ?? '—'}</td>
                            <td className="px-3 py-3 tabular-nums">{v.daysAway} days</td>
                            <td className="px-3 py-3">{back ? formatIsoDate(back) : 'Not set'}</td>
                            <td className="px-3 py-3">
                              <StateBadge state={r.state} />
                            </td>
                            <td className="px-5 py-3 text-right">
                              <Button size="sm" variant="outline" onClick={() => setOpen(v.id)} data-testid={`review-${v.id}`}>
                                Review
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <p className="flex items-center gap-2 text-xs text-nw-text-3">
            <Info className="size-3.5 shrink-0" aria-hidden />
            Company vacation-return policy. Separate from the DOT return-to-duty program.
          </p>
        </>
      )}

      {open ? <ReviewPanel vacationId={open} key={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function StatCard({ label, value, icon, tone }: { label: string; value: number | undefined; icon: ReactNode; tone: 'warning' | 'done' }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[10px] border border-nw-border bg-nw-panel px-5 py-4 shadow-sm">
      <div>
        <p className="text-sm text-nw-text-2">{label}</p>
        <p className="mt-1 text-[28px] leading-none font-bold text-nw-text tabular-nums">{value === undefined ? 'Loading…' : value}</p>
      </div>
      <span className={cn('grid size-11 place-items-center rounded-full', tone === 'done' ? 'bg-nw-done-bg text-nw-done-icon' : 'bg-nw-warning-bg text-nw-warning-icon')} aria-hidden>
        {icon}
      </span>
    </div>
  );
}

function CheckItem({ done, label, children }: { done: boolean; label: string; children?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span className={cn('grid size-6 shrink-0 place-items-center rounded-full border-2', done ? 'border-nw-accent bg-nw-accent text-nw-on-accent' : 'border-nw-border-strong')} aria-hidden>
        {done ? <Check className="size-3.5" strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0 flex-1 text-sm font-medium text-nw-text">
        {label}
        <span className="sr-only">{done ? ' — done' : ' — not done'}</span>
      </span>
      {children}
    </li>
  );
}

function ReviewPanel({ vacationId, onClose }: { vacationId: string; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['safety-v2', 'vacation-returns', vacationId], queryFn: () => apiGet<VacationReturnDetail>(`/safety/vacation-returns/${encodeURIComponent(vacationId)}`) });
  const canManage = useCan('safety.manage');
  const canTest = useCan('safety_testing.manage') && canManage;
  const canLinkCost = useCan('accounting.view') && canManage;
  const [note, setNote] = useState('');
  const [collected, setCollected] = useState('');
  const [result, setResult] = useState('negative');
  const fileRef = useRef<HTMLInputElement>(null);
  const openTest = useSafetyWrite(() => safetyApi.post<VacationReturnDetail>(`/vacation-returns/${vacationId}/test`, { scheduledAt: null }), 'Vacation-return test opened');
  const patchTest = useSafetyWrite((body: Record<string, unknown>) => safetyApi.patch(`/tests/${detail.data!.test!.id}`, { version: detail.data!.test!.version, ...body }), 'Test updated');
  // The test result paper: filed on the review, opening the review first when there is none yet.
  const upload = useSafetyWrite(async (file: File) => {
    let reviewId = detail.data?.reviewId ?? null;
    if (!reviewId) reviewId = (await safetyApi.post<VacationReturnDetail>(`/vacation-returns/${vacationId}/test`, { scheduledAt: null })).reviewId;
    if (!reviewId) throw new Error('The review could not be opened');
    return safetyApi.attach('safety_review', reviewId, file, 'test_record', 'Vacation-return test result');
  }, 'Test result uploaded');
  const clear = useSafetyWrite(
    (text: string) => safetyApi.post<VacationReturnDetail>(`/vacation-returns/${vacationId}/approve`, { version: detail.data!.reviewVersion, outcome: text }),
    'Driver cleared for dispatch',
  );

  const d = detail.data;
  const v = d?.vacation;
  const t = d?.test ?? null;
  const cleared = d?.state === 'cleared';
  const docsValid = (d?.documentProblems.length ?? 1) === 0;
  const resultDone = cleared || t?.result === 'negative' || (Boolean(t?.resultRestricted) && d?.state === 'result_received');
  const uploads = (d?.documents ?? []).filter((x) => x.kind === 'test_record');
  const ready = Boolean(d) && !cleared && (d?.approveBlockers.length ?? 1) === 0 && Boolean(d?.reviewVersion);

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Return review"
      footer={
        d ? (
          <div className="flex w-full flex-col gap-2">
            {cleared ? (
              <p className="flex items-center gap-2 rounded-lg bg-nw-done-bg px-3 py-2.5 text-sm font-semibold text-nw-done-text">
                <StatusSymbol family="done" size={16} /> Cleared for dispatch{d.completedBy ? ` by ${d.completedBy}` : ''}
                {d.completedAt ? ` · ${formatIsoDate(d.completedAt.slice(0, 10))}` : ''}
              </p>
            ) : (
              <p className="flex items-center gap-2 rounded-lg bg-nw-warning-bg px-3 py-2.5 text-sm font-semibold text-nw-warning-text">
                <TriangleAlert className="size-4 shrink-0 text-nw-warning-icon" aria-hidden /> Dispatch on hold until Safety clearance.
              </p>
            )}
            {canManage && !cleared ? (
              <>
                <Button variant="primary" className="w-full" disabled={!ready} loading={clear.isPending} onClick={() => clear.mutate(note.trim() || 'Return review checklist complete')} data-testid="approve-clearance">
                  Clear for dispatch
                </Button>
                <p className="text-center text-xs text-nw-text-3">{ready ? 'All required items are done.' : `Complete required items first${d.approveBlockers.length ? `: ${d.approveBlockers.join(' · ')}` : '.'}`}</p>
              </>
            ) : null}
          </div>
        ) : null
      }
    >
      {detail.isPending ? (
        <p className="text-sm text-nw-text-3">Loading…</p>
      ) : detail.isError || !d || !v ? (
        <ErrorState onRetry={() => void detail.refetch()} />
      ) : (
        <div className="flex flex-col gap-4" data-testid="vacation-return-detail">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-bold text-nw-text">{v.driverName}</h2>
              <p className="text-sm text-nw-text-2">
                {v.unitNumber ? `Unit ${v.unitNumber}` : 'No unit'} · Away {v.daysAway} days
              </p>
              <Link to="/drivers/$driverId" params={{ driverId: v.driverId }} className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-nw-accent-ink hover:underline">
                View driver <ArrowRight className="size-3" aria-hidden />
              </Link>
            </div>
            <StateBadge state={d.state} />
          </div>

          <div className="flex items-center gap-3 rounded-[10px] border border-nw-border bg-nw-subtle px-4 py-3">
            <span className="grid size-10 place-items-center rounded-lg border border-nw-border bg-nw-panel text-nw-text-2" aria-hidden>
              <CalendarDays className="size-5" />
            </span>
            <div>
              <p className="text-xs text-nw-text-2">Vacation dates</p>
              <p className="font-bold text-nw-text">
                {formatIsoDate(v.startedOn)} – {v.endedOn ? formatIsoDate(v.endedOn) : v.expectedReturnOn ? `${formatIsoDate(v.expectedReturnOn)} (expected)` : 'still away'}
              </p>
            </div>
          </div>

          <section className="rounded-[10px] border border-nw-border px-4 py-3">
            <h3 className="border-b border-nw-border pb-2 text-base font-bold text-nw-text">Review checklist</h3>
            <ul className="divide-y divide-nw-border">
              <CheckItem done={docsValid} label="Documents valid">
                {docsValid ? <span className="text-xs text-nw-text-3">CDL and medical card in date</span> : <span className="text-xs text-nw-urgent-text">{d.documentProblems.join(' · ')}</span>}
              </CheckItem>
              <CheckItem done={resultDone} label="Required test result">
                <span className="text-xs text-nw-text-3">{uploads.length > 0 ? `${uploads.length} uploaded` : 'Not uploaded'}</span>
                {canManage && !cleared ? (
                  <>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="application/pdf,image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) upload.mutate(f);
                        e.target.value = '';
                      }}
                    />
                    <Button size="sm" variant="outline" icon={<Upload />} loading={upload.isPending} onClick={() => fileRef.current?.click()} data-testid="upload-test-result">
                      Upload
                    </Button>
                  </>
                ) : null}
              </CheckItem>
              {canTest && !cleared ? (
                <li className="flex flex-col gap-2 py-3 pl-9 text-sm">
                  {!t ? (
                    <Button size="sm" variant="secondary" className="w-fit" loading={openTest.isPending} onClick={() => openTest.mutate(undefined)} data-testid="schedule-test">
                      Open the test
                    </Button>
                  ) : !t.collectedAt ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="flex flex-col gap-1 text-xs font-medium text-nw-text-2">
                        Collected (ET)
                        <input type="datetime-local" value={collected} onChange={(e) => setCollected(e.target.value)} className="h-8 rounded-md border border-nw-border bg-nw-field px-2 text-sm text-nw-text" aria-label="Collected" />
                      </label>
                      <Button size="sm" variant="secondary" disabled={!collected} loading={patchTest.isPending} onClick={() => patchTest.mutate({ collectedAt: fromEasternInput(collected) })}>
                        Record collection
                      </Button>
                    </div>
                  ) : (t.result === 'pending' || t.result === null) && !t.resultRestricted ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <Select size="sm" aria-label="Result" value={result} onValueChange={setResult} className="w-36" options={['negative', 'positive', 'refused', 'cancelled'].map((x) => ({ value: x, label: x[0]!.toUpperCase() + x.slice(1) }))} />
                      <Button size="sm" variant="secondary" loading={patchTest.isPending} onClick={() => patchTest.mutate({ result })}>
                        Record result
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-nw-text-3">Result: {t.resultRestricted ? 'recorded (restricted)' : t.result}</span>
                  )}
                </li>
              ) : null}
              <CheckItem done={cleared} label="Safety review">
                {cleared ? <span className="text-xs text-nw-text-3">{d.completedBy ?? ''}</span> : null}
              </CheckItem>
            </ul>
          </section>

          <section className="rounded-[10px] border border-nw-border px-4 py-3">
            <h3 className="mb-2 text-base font-bold text-nw-text">Notes</h3>
            {cleared ? (
              <p className="text-sm whitespace-pre-wrap text-nw-text">{d.outcome ?? '—'}</p>
            ) : (
              <>
                <Textarea rows={4} value={note} maxLength={NOTE_MAX} disabled={!canManage} onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))} aria-label="Review note" placeholder="Add a review note…" />
                <p className="mt-1 text-right text-xs text-nw-text-3 tabular-nums">
                  {note.length}/{NOTE_MAX}
                </p>
              </>
            )}
          </section>

          <details className="rounded-[10px] border border-nw-border px-4 py-3">
            <summary className="cursor-pointer text-sm font-semibold text-nw-text-2">Cost & history</summary>
            <div className="mt-3 flex flex-col gap-4">
              <RelatedExpense detail={d} vacationId={vacationId} canLink={canLinkCost} />
              <section>
                <h3 className="mb-1 text-sm font-bold text-nw-text">History</h3>
                {d.history.length === 0 ? (
                  <p className="text-sm text-nw-text-3">Nothing recorded yet.</p>
                ) : (
                  <ul className="text-sm">
                    {d.history.map((h) => (
                      <li key={h.id} className="flex gap-3 py-1">
                        <span className="w-36 shrink-0 text-nw-text-3 tabular-nums">{new Date(h.at).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })}</span>
                        <span className="text-nw-text">
                          {h.summary} · <span className="text-nw-text-2">{h.actorName}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </details>
        </div>
      )}
    </Drawer>
  );
}

interface ExpenseOption {
  id: string;
  expenseNumber: string;
  onDate: string;
  description: string;
  amount: number;
  status: string;
  driverId?: string | null;
}

function RelatedExpense({ detail: d, vacationId, canLink }: { detail: VacationReturnDetail; vacationId: string; canLink: boolean }) {
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState('');
  const options = useQuery({
    queryKey: ['safety-v2', 'vacation-returns', 'expense-options'],
    queryFn: () => apiGet<ExpenseOption[] | { data: ExpenseOption[] }>('/accounting/expenses'),
    enabled: picking,
  });
  const link = useSafetyWrite((expenseId: string | null) => safetyApi.post<VacationReturnDetail>(`/vacation-returns/${vacationId}/expense`, { version: d.reviewVersion, expenseId }), 'Related expense saved');
  const all = Array.isArray(options.data) ? options.data : (options.data?.data ?? []);
  const forDriver = all.filter((e) => e.status !== 'void' && (!e.driverId || e.driverId === d.vacation.driverId));
  return (
    <section>
      <h3 className="mb-2 text-sm font-bold text-nw-text">Related expense</h3>
      {d.expense ? (
        <div className="overflow-x-auto rounded-lg border border-nw-border">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="bg-nw-subtle text-left text-xs text-nw-text-2">
              <tr>
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Payer</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-3 py-2">{d.expense.description || d.expense.expenseNumber}<span className="block text-xs text-nw-text-3">{d.expense.expenseNumber} · {formatIsoDate(d.expense.onDate)}</span></td>
                <td className="px-3 py-2 capitalize">{d.expense.payer ?? 'Not confirmed'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(d.expense.amountCents / 100)}</td>
                <td className="px-3 py-2 capitalize">{d.expense.status}</td>
                <td className="px-3 py-2 text-right">
                  <Link to="/accounting/expenses" search={{ q: d.expense.expenseNumber, fp: 'year' } as never} className="text-sm font-semibold text-nw-accent-ink hover:underline">
                    Open in Accounting
                  </Link>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : d.expenseRestricted ? (
        <p className="text-sm text-nw-text-3">An expense is linked; seeing it needs Accounting access.</p>
      ) : (
        <p className="text-sm text-nw-text-3">No linked expenses.</p>
      )}
      <p className="mt-1 text-xs text-nw-text-3">Approval and payment are handled in Accounting. Nothing is posted or deducted from here.</p>
      {canLink && d.reviewId ? (
        picking ? (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Select
              size="sm"
              aria-label="Accounting expense"
              placeholder={options.isPending ? 'Loading…' : 'Pick the expense'}
              value={choice || undefined}
              onValueChange={setChoice}
              className="w-80"
              options={forDriver.map((e) => ({ value: e.id, label: `${e.expenseNumber} · ${formatIsoDate(e.onDate)} · ${formatMoney(e.amount)} · ${e.description}` }))}
            />
            <Button size="sm" variant="primary" disabled={!choice} loading={link.isPending} onClick={() => link.mutate(choice, { onSuccess: () => setPicking(false) })}>
              Link expense
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>Cancel</Button>
          </div>
        ) : (
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setPicking(true)}>{d.expense ? 'Change linked expense' : 'Link an existing expense'}</Button>
            {d.expense ? <Button size="sm" variant="ghost" loading={link.isPending} onClick={() => link.mutate(null)}>Unlink</Button> : null}
          </div>
        )
      ) : null}
    </section>
  );
}
