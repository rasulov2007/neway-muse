import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowRight, BookOpen, Calculator, CalendarClock, ChevronDown, Clock, Download, FileText, Info, Landmark, LineChart, ListChecks, Receipt, TrendingUp, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { reimbursableCents, type PeriodPreset } from '@neway/shared';
import {
  Badge,
  Button,
  Card,
  DataTable,
  DropdownMenu,
  ErrorState,
  KpiCard,
  MenuItem,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  cn,
  createColumns,
} from '@/design-system';
import { accountingFileUrl, listReimbursements, type JournalEntry } from '@/demo';
import { formatIsoDate, formatMoney, formatNumber } from '@/lib/format';
import {
  AccountingFactList,
  AccountingPanel,
  FinancialPeriodSelector,
  Money,
  NeedsAttentionPanel,
} from './components/AccountingKit';
import { useAccounting } from './useAccounting';
import { AccountingSettingsPanel } from './AccountingSettingsPanel';
import { PipelinePanel } from './PipelinePanel';
import { accountingSearchSchema } from './accounting-search';

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'pnl', label: 'Profit and loss' },
  { value: 'cpm', label: 'Cost per mile' },
  { value: 'ledger', label: 'General ledger' },
  { value: 'periods', label: 'Periods' },
  { value: 'settings', label: 'Settings' },
];

const journalCol = createColumns<JournalEntry>();

/**
 * The financial command centre.
 *
 * Every figure on this page is read from the ledger, so each one can be traced to the entries
 * behind it — which is what the General ledger tab is for. The trial balance is shown rather than
 * hidden, because a set of books whose balance nobody can see is a set of books nobody can trust.
 */
/**
 * What a driver has laid out and nobody has looked at yet.
 *
 * One line, and only when there is something waiting: it opens the reimbursement list already
 * filtered to what it is counting, so the number and the screen behind it can never disagree.
 */
function ReimbursementsAwaitingReview() {
  const pending = useQuery({
    queryKey: ['accounting', 'reimbursements', 'pending'],
    queryFn: () => listReimbursements({ status: 'pending' }),
    staleTime: 30_000,
  });
  if (pending.isPending || !pending.data || pending.data.length === 0) return null;
  const owed = pending.data.reduce((t, r) => t + reimbursableCents(r.reimbursement), 0);
  return (
    <Link
      to="/accounting/reimbursements"
      search={{ status: 'pending' }}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 text-sm hover:bg-surface-hover"
    >
      <span className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning-text"><Receipt className="size-4" /></span>
        <span>
          <span className="font-semibold text-ink">Reimbursements awaiting review</span>
          <span className="block text-xs text-muted">{pending.data.length} item{pending.data.length === 1 ? '' : 's'} · {formatMoney(owed / 100)} owed to drivers once approved</span>
        </span>
      </span>
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary-text">Review them <ArrowRight className="size-3" /></span>
    </Link>
  );
}

export function AccountingPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => accountingSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const [tab, setTab] = useState(typeof search.tab === 'string' && TABS.some((t) => t.value === search.tab) ? String(search.tab) : search.view === 'ledger' ? 'ledger' : 'overview');

  const preset = (search.fp as PeriodPreset) ?? 'month';
  const query = useAccounting(preset);
  const bundle = query.data;

  function setPeriod(next: PeriodPreset) {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, fp: next }),
      replace: true,
    });
  }

  const journalColumns = useMemo(
    () =>
      journalCol.columns([
        journalCol.accessor('onDate', {
          header: 'Date',
          cell: ({ getValue }) => formatIsoDate(getValue()),
          meta: { width: 110 },
        }),
        journalCol.accessor('id', { header: 'Entry', meta: { primary: true, width: 110 } }),
        journalCol.accessor('source', {
          header: 'Source',
          cell: ({ getValue }) => getValue().replace(/_/g, ' '),
          meta: { width: 150 },
        }),
        journalCol.accessor('memo', { header: 'Memo' }),
        journalCol.display({
          id: 'accounts',
          header: 'Accounts',
          cell: ({ row }) => (
            <span className="font-mono text-xs text-muted">
              {row.original.lines.map((l) => l.accountCode).join(' · ')}
            </span>
          ),
        }),
        journalCol.accessor('totalCents', {
          header: 'Amount',
          cell: ({ getValue }) => formatMoney(getValue() / 100),
          meta: { align: 'right', width: 120 },
        }),
      ]),
    [],
  );

  if (query.isPending) {
    return (
      <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (query.error || !bundle) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const ar = bundle.receivables;
  const ap = bundle.payables;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Dashboard"
        description="Financial performance, balances and cash activity"
        actions={
          <DropdownMenu trigger={<Button variant="primary" size="sm" icon={<Download />}>Export <ChevronDown className="size-3.5" /></Button>}>
            <MenuItem onSelect={() => window.open(accountingFileUrl('export/ledger.csv'), '_blank')}>General ledger (CSV)</MenuItem>
            <MenuItem onSelect={() => window.print()}>Print this page</MenuItem>
          </DropdownMenu>
        }
      />
      <FinancialPeriodSelector value={preset} onChange={setPeriod} range={bundle.range} />

      <Tabs items={TABS} value={tab} onValueChange={setTab} aria-label="Accounting">
        <TabsContent value="overview" className="pt-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-2 text-xs text-secondary">
              <span className="inline-flex items-center gap-2"><Info className="size-3.5 text-muted" /> {bundle.journal.length === 0 ? 'No journal entries posted for this period.' : `${formatNumber(bundle.journal.length)} journal entries posted for this period.`}</span>
              <button type="button" className="inline-flex items-center gap-1 font-semibold text-primary-text" onClick={() => setTab('ledger')}>Open general ledger <ArrowRight className="size-3" /></button>
            </div>
            <NeedsAttentionPanel items={bundle.exceptions} onSelect={(item) => void navigate({ to: item.target.to, search: item.target.search ?? {} })} />
            <ReimbursementsAwaitingReview />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard label="Revenue" value={bundle.figures.revenue === null ? '$0.00' : formatMoney(bundle.figures.revenue)} hint="Posted this period" icon={<TrendingUp />} iconTile variant="feature" />
              <KpiCard label="Expenses" value={bundle.cost.current === null ? '$0.00' : formatMoney(bundle.cost.current)} hint="Posted this period" icon={<Receipt />} iconTile variant="feature" />
              <KpiCard label="Gross profit" value={bundle.figures.grossProfit === null ? '$0.00' : formatMoney(bundle.figures.grossProfit)} hint={bundle.figures.grossMarginPct === null ? 'Revenue less direct costs' : `${bundle.figures.grossMarginPct}% margin`} icon={<LineChart />} iconTile variant="feature" tone={bundle.figures.grossProfit !== null && bundle.figures.grossProfit < 0 ? 'urgent' : undefined} />
              <KpiCard label="Operating profit" value={bundle.figures.operatingProfit === null ? '$0.00' : formatMoney(bundle.figures.operatingProfit)} hint="After operating expenses" icon={<Calculator />} iconTile variant="feature" tone={bundle.figures.operatingProfit !== null && bundle.figures.operatingProfit < 0 ? 'urgent' : undefined} />
            </div>
            <p className="-mt-2 text-2xs text-muted">Posted amounts only. Unbilled loads and draft bills are excluded.</p>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between"><span className="inline-flex items-center gap-2 text-sm font-semibold text-ink"><span className="flex size-7 items-center justify-center rounded-md bg-primary-soft text-primary-text"><Users className="size-4" /></span> Receivables</span><Badge tone="neutral" size="sm">As of {formatIsoDate(bundle.today)}</Badge></div>
                <p className="mt-3 text-2xl font-bold tabular-nums text-ink">{formatMoney(ar.total)} <span className="text-sm font-normal text-muted">outstanding</span></p>
                <dl className="mt-3 divide-y divide-line-soft text-xs">
                  {([['current', 'Not due'], ['1-30', '1 – 30 days overdue'], ['31-60', '31 – 60 days overdue'], ['61-90', '61 – 90 days overdue'], ['90+', '90+ days overdue']] as const).map(([k, l]) => <div key={k} className="flex justify-between py-1.5"><dt className="text-secondary">{l}</dt><dd className="tabular-nums text-ink">{formatMoney(ar[k])}</dd></div>)}
                </dl>
                <Link to="/accounting/receivables" className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary-text">View receivables <ArrowRight className="size-3" /></Link>
              </div>
              <div className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between"><span className="inline-flex items-center gap-2 text-sm font-semibold text-ink"><span className="flex size-7 items-center justify-center rounded-md bg-warning-soft text-warning-text"><FileText className="size-4" /></span> Payables</span><Badge tone="neutral" size="sm">As of {formatIsoDate(bundle.today)}</Badge></div>
                <p className="mt-3 text-2xl font-bold tabular-nums text-ink">{formatMoney(ap.total)} <span className="text-sm font-normal text-muted">outstanding</span></p>
                <dl className="mt-3 divide-y divide-line-soft text-xs">
                  <div className="flex justify-between py-1.5"><dt className="text-secondary">Due today</dt><dd className="tabular-nums text-ink">{formatMoney(ap.dueToday)}</dd></div>
                  <div className="flex justify-between py-1.5"><dt className="text-secondary">Due next 7 days</dt><dd className="tabular-nums text-ink">{formatMoney(ap.dueThisWeek)}</dd></div>
                  <div className="flex justify-between py-1.5"><dt className="text-secondary">Overdue</dt><dd className={cn('tabular-nums', ap.overdue > 0 ? 'font-semibold text-danger-text' : 'text-ink')}>{formatMoney(ap.overdue)}</dd></div>
                </dl>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-surface-muted p-2 text-xs"><span className="inline-flex items-center gap-1 text-muted"><Clock className="size-3" /> Pending approval</span><span className="block text-lg font-bold tabular-nums text-ink">{ap.ids.pendingApproval.length}</span></div>
                  <div className="rounded-lg bg-surface-muted p-2 text-xs"><span className="inline-flex items-center gap-1 text-muted"><CalendarClock className="size-3" /> Scheduled</span><span className="block text-lg font-bold tabular-nums text-ink">{ap.ids.scheduled.length}</span></div>
                </div>
                <Link to="/accounting/payables" className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary-text">View payables <ArrowRight className="size-3" /></Link>
              </div>
              <div className="rounded-xl border border-line bg-surface p-4">
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink"><span className="flex size-7 items-center justify-center rounded-md bg-success-soft text-success-text"><Landmark className="size-4" /></span> Cash activity</span>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-success-soft p-3"><span className="block text-xs text-success-text">Received</span><span className="block text-xl font-bold tabular-nums text-ink">{formatMoney(bundle.figures.cashIn ?? 0)}</span></div>
                  <div className="rounded-lg bg-danger-soft p-3"><span className="block text-xs text-danger-text">Paid</span><span className="block text-xl font-bold tabular-nums text-ink">{formatMoney(bundle.figures.cashOut ?? 0)}</span></div>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-line-soft pt-2 text-sm"><span className="text-secondary">Net cash movement</span><span className="font-semibold tabular-nums text-ink">{formatMoney((bundle.figures.cashIn ?? 0) - (bundle.figures.cashOut ?? 0))}</span></div>
                {bundle.figures.cashIn === null && bundle.figures.cashOut === null ? <div className="mt-3 rounded-lg bg-surface-muted p-4 text-center text-xs text-muted"><FileText className="mx-auto mb-1 size-4" />No posted cash activity in this period.</div> : null}
                <button type="button" className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary-text" onClick={() => setTab('ledger')}>View transactions <ArrowRight className="size-3" /></button>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between"><span className="inline-flex items-center gap-2 text-sm font-semibold text-ink"><span className="flex size-7 items-center justify-center rounded-md bg-surface-muted text-ink"><Receipt className="size-4" /></span> Expense breakdown</span><Link to="/accounting/expenses" className="inline-flex items-center gap-1 text-xs font-semibold text-primary-text">Open expenses <ArrowRight className="size-3" /></Link></div>
                {bundle.cpm.byAccount.length === 0 ? (
                  <div className="py-8 text-center text-sm"><Receipt className="mx-auto mb-2 size-6 text-muted" /><p className="font-semibold text-ink">No posted expenses</p><p className="text-xs text-muted">Approved and posted costs will appear here.</p></div>
                ) : (
                  <ul className="mt-3 divide-y divide-line-soft">
                    {bundle.cpm.byAccount.slice(0, 6).map((row) => <li key={row.code} className="flex items-baseline justify-between gap-3 py-2"><span className="truncate text-sm text-secondary">{row.name}</span><span className="text-sm font-medium tabular-nums text-ink">{formatMoney(row.amount)}</span></li>)}
                  </ul>
                )}
              </div>
              <div className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between"><span className="inline-flex items-center gap-2 text-sm font-semibold text-ink"><span className="flex size-7 items-center justify-center rounded-md bg-surface-muted text-ink"><BookOpen className="size-4" /></span> Ledger summary</span><Badge tone="neutral" size="sm">{formatNumber(bundle.journal.length)} entries</Badge></div>
                <dl className="mt-3 divide-y divide-line-soft text-xs">
                  <div className="flex justify-between py-1.5"><dt className="text-secondary">Total debits</dt><dd className="tabular-nums text-ink">{formatMoney(bundle.trial.totalDebits / 100)}</dd></div>
                  <div className="flex justify-between py-1.5"><dt className="text-secondary">Total credits</dt><dd className="tabular-nums text-ink">{formatMoney(bundle.trial.totalCredits / 100)}</dd></div>
                  <div className="flex justify-between py-1.5"><dt className="font-semibold text-ink">Difference</dt><dd className={cn('font-semibold tabular-nums', bundle.trial.balanced ? 'text-ink' : 'text-danger-text')}>{formatMoney(bundle.trial.difference / 100)}</dd></div>
                </dl>
                <div className="mt-3 flex items-center justify-between rounded-lg bg-surface-muted px-3 py-2 text-xs"><span className="inline-flex items-center gap-1 text-secondary"><Info className="size-3" /> {bundle.journal.length === 0 ? 'No entries to reconcile.' : bundle.trial.balanced ? 'Every posted entry balances.' : 'The ledger does not balance: a defect, not a data problem.'}</span><button type="button" className="inline-flex items-center gap-1 font-semibold text-primary-text" onClick={() => setTab('ledger')}>View general ledger <ArrowRight className="size-3" /></button></div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
              <span className="inline-flex items-center gap-2 font-semibold text-ink"><ListChecks className="size-4 text-muted" /> Continue accounting work</span>
              <Link to="/accounting/invoices" search={{ tab: 'queue' }} className="inline-flex items-center gap-1 text-xs font-semibold text-primary-text">Review billing queue <ArrowRight className="size-3" /></Link>
              <Link to="/accounting/payables" className="inline-flex items-center gap-1 text-xs font-semibold text-primary-text">Review bills <ArrowRight className="size-3" /></Link>
              <Link to="/accounting/settlements" className="inline-flex items-center gap-1 text-xs font-semibold text-primary-text">Open settlements <ArrowRight className="size-3" /></Link>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="pnl" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <AccountingPanel title={`Profit and loss · ${bundle.range.from} to ${bundle.range.to}`}>
              <AccountingFactList
                facts={[
                  { label: 'Revenue', value: <Money value={bundle.figures.revenue} /> },
                  { label: 'Direct costs', value: <Money value={bundle.figures.directCost} /> },
                  {
                    label: 'Gross profit',
                    value: <Money value={bundle.figures.grossProfit} />,
                    emphasis: true,
                  },
                  {
                    label: 'Gross margin',
                    value:
                      bundle.figures.grossMarginPct === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        `${bundle.figures.grossMarginPct}%`
                      ),
                  },
                  {
                    label: 'Operating expenses',
                    value: <Money value={bundle.figures.operatingCost} />,
                  },
                  {
                    label: 'Operating profit',
                    value: <Money value={bundle.figures.operatingProfit} />,
                    emphasis: true,
                  },
                  {
                    label: 'Operating margin',
                    value:
                      bundle.figures.operatingMarginPct === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        `${bundle.figures.operatingMarginPct}%`
                      ),
                  },
                ]}
              />
              <p className="text-xs text-faint">
                Computed from {formatNumber(bundle.figures.entryCount)} journal entries in this
                period. Every line is the net movement on its account group.
              </p>
            </AccountingPanel>

            <AccountingPanel title="Against the previous period">
              <AccountingFactList
                facts={[
                  {
                    label: `Revenue (${bundle.previous.from} to ${bundle.previous.to})`,
                    value: <Money value={bundle.previousFigures.revenue} />,
                  },
                  {
                    label: 'Change',
                    value:
                      bundle.revenue.changePct === null ? (
                        <span
                          className="text-faint"
                          title="The previous period has no postings to compare against."
                        >
                          No comparison
                        </span>
                      ) : (
                        <span
                          className={
                            bundle.revenue.changePct >= 0 ? 'text-success-text' : 'text-danger-text'
                          }
                        >
                          {bundle.revenue.changePct >= 0 ? '+' : ''}
                          {bundle.revenue.changePct}%
                        </span>
                      ),
                  },
                  {
                    label: 'Gross profit then',
                    value: <Money value={bundle.previousFigures.grossProfit} />,
                  },
                  {
                    label: 'Change',
                    value:
                      bundle.grossProfit.changeAbsolute === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <Money value={bundle.grossProfit.changeAbsolute} />
                      ),
                  },
                ]}
              />
            </AccountingPanel>
          </div>
        </TabsContent>

        <TabsContent value="cpm" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <AccountingPanel title="Cost per mile">
              {bundle.cpm.unavailable ? (
                <p className="text-sm text-faint">{bundle.cpm.unavailable}.</p>
              ) : (
                <AccountingFactList
                  facts={[
                    { label: 'Total cost', value: <Money value={bundle.cpm.totalCost} /> },
                    {
                      label: 'Miles',
                      value:
                        bundle.cpm.miles === null ? (
                          <span className="text-faint">—</span>
                        ) : (
                          formatNumber(bundle.cpm.miles)
                        ),
                    },
                    {
                      label: 'Cost per mile',
                      value:
                        bundle.cpm.costPerMile === null ? (
                          <span className="text-faint">—</span>
                        ) : (
                          `$${bundle.cpm.costPerMile.toFixed(3)}`
                        ),
                      emphasis: true,
                    },
                    {
                      label: 'Direct cost per mile',
                      value:
                        bundle.cpm.directCostPerMile === null ? (
                          <span className="text-faint">—</span>
                        ) : (
                          `$${bundle.cpm.directCostPerMile.toFixed(3)}`
                        ),
                    },
                    {
                      label: 'Revenue per mile',
                      value:
                        bundle.cpm.revenuePerMile === null ? (
                          <span className="text-faint">—</span>
                        ) : (
                          `$${bundle.cpm.revenuePerMile.toFixed(3)}`
                        ),
                    },
                  ]}
                />
              )}
              <p className="text-xs text-faint">
                The costs here are the same ledger movements the profit and loss uses, over the
                miles delivered loads actually turned. The two reconcile by construction.
              </p>
            </AccountingPanel>

            <AccountingPanel title="By account">
              {bundle.cpm.byAccount.length === 0 ? (
                <p className="text-sm text-faint">Nothing posted to a cost account.</p>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {bundle.cpm.byAccount.map((row) => (
                    <li key={row.code} className="flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0 truncate text-sm text-secondary">
                        <span className="font-mono text-xs text-faint">{row.code}</span> {row.name}
                      </span>
                      <span className="flex shrink-0 items-baseline gap-4">
                        <span className="text-sm tabular-nums text-ink">
                          {formatMoney(row.amount)}
                        </span>
                        <span className="w-16 text-right text-sm font-medium tabular-nums text-muted">
                          {bundle.cpm.miles === null ? '—' : `$${row.perMile.toFixed(3)}`}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </AccountingPanel>
          </div>
        </TabsContent>

        <TabsContent value="ledger" className="pt-4">
          <div className="flex flex-col gap-4">
            <Card className="p-4">
              <h3 className="text-md font-bold text-ink">Chart of accounts</h3>
              <ul className="mt-2 grid gap-x-6 gap-y-1 md:grid-cols-2 xl:grid-cols-3">
                {bundle.trial.rows.map((row) => (
                  <li key={row.account.code} className="flex items-baseline justify-between gap-3">
                    <Link
                      to="/accounting"
                      search={{ view: 'ledger', account: row.account.code, fp: preset }}
                      className={cn(
                        'truncate text-sm hover:underline',
                        search.account === row.account.code
                          ? 'font-medium text-primary-text'
                          : 'text-secondary',
                      )}
                    >
                      <span className="font-mono text-xs text-faint">{row.account.code}</span>{' '}
                      {row.account.name}
                    </Link>
                    <span className="shrink-0 text-sm tabular-nums text-ink">
                      {formatMoney(row.balance / 100)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            <DataTable
              columns={journalColumns}
              data={
                search.account
                  ? bundle.journal.filter((e) =>
                      e.lines.some((l) => l.accountCode === search.account),
                    )
                  : bundle.journal
              }
              rowKey={(entry) => entry.id}
              caption="Journal"
              emptyTitle="No journal entries"
              emptyDescription="Entries appear here as invoices, payments, bills, expenses and settlements post."
            />
          </div>
        </TabsContent>

        <TabsContent value="periods" className="pt-4">
          <AccountingPanel title="Ledger periods">
            <ul className="divide-y divide-line-soft">
              {bundle.ledgerPeriods.map((period) => (
                <li key={period.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-sm text-ink">{period.id}</span>
                  <span className="flex items-center gap-3">
                    <Badge
                      tone={
                        period.status === 'open'
                          ? 'success'
                          : period.status === 'closing'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {period.status}
                    </Badge>
                    {period.closedBy ? (
                      <span className="text-xs text-muted">closed by {period.closedBy}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-faint">
              A posting dated inside a closed period is refused rather than re-dated into an open
              one. Correcting one means raising an adjustment, which keeps the month it happened in
              describing what happened.
            </p>
          </AccountingPanel>
        </TabsContent>
        <TabsContent value="settings" className="pt-4">
          {/* Diagnostics: the completed-load pipeline and reconciliation live here, out of the main billing views. */}
          <div className="mb-4"><PipelinePanel /></div>
          <AccountingSettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
