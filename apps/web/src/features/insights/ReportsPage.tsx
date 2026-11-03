import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { Ban, Download, FileText, Play, Save } from 'lucide-react';
import {
  CATEGORY_LABELS,
  REPORT_CATEGORIES,
  type ReportCell,
  type ReportColumn,
  type ReportDefinition,
  type ReportResult,
} from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Tabs,
  TabsContent,
  cn,
  useToast,
} from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { formatIsoDate, formatMoney, formatNumber } from '@/lib/format';
import { insightsSearchSchema } from './insights-search';
import {
  PERIOD_PRESETS,
  downloadCsv,
  useReportCatalog,
  useRunReport,
  useSaveReport,
  useSavedReports,
} from './useInsights';

/**
 * Reports.
 *
 * A library, a runner and a result. The library lists reports the signed-in principal is allowed to
 * see — the server omits the rest rather than the page hiding them — and a report whose source data
 * does not exist says so on its card, because "we do not collect that yet" is a more useful answer
 * than a missing entry or an empty table.
 */
export function ReportsPage() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => insightsSearchSchema.parse(raw), [raw]);
  const navigate = useNavigate();
  const { toast } = useToast();

  const catalog = useReportCatalog();
  const saved = useSavedReports();
  const run = useRunReport();
  const save = useSaveReport();

  const [result, setResult] = useState<ReportResult | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const selected = useMemo(
    () => catalog.data?.find((r) => r.key === search.report) ?? null,
    [catalog.data, search.report],
  );

  const preset = search.preset ?? 'this_month';
  const filters = useMemo(
    () => ({
      truckId: search.truck,
      driverId: search.driver,
      department: search.department,
      status: search.status,
    }),
    [search],
  );

  function update(patch: Record<string, unknown>) {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev, ...patch };
        for (const [k, v] of Object.entries(next)) {
          if (v === undefined || v === '' || v === null) delete next[k];
        }
        return next;
      },
      replace: true,
    });
  }

  // Running is explicit — a report is work, and re-running it on every keystroke is not helpful.
  function runReport(definition: ReportDefinition) {
    run.mutate({ reportKey: definition.key, preset, ...filters }, { onSuccess: setResult });
  }

  // Opening a report from the library or a saved view runs it once.
  useEffect(() => {
    if (selected && !selected.unavailable && !result && !run.isPending) runReport(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.key]);

  const grouped = useMemo(() => {
    const term = (search.q ?? '').toLowerCase();
    const matching = (catalog.data ?? []).filter(
      (r) =>
        !term ||
        r.name.toLowerCase().includes(term) ||
        r.description.toLowerCase().includes(term) ||
        CATEGORY_LABELS[r.category].toLowerCase().includes(term),
    );
    return REPORT_CATEGORIES.map((category) => ({
      category,
      reports: matching.filter((r) => r.category === category),
    })).filter((group) => group.reports.length > 0);
  }, [catalog.data, search.q]);

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Reports"
        description="Generate, analyse and export operational, financial, fleet and workforce reports."
      />

      <Tabs
        items={[
          { value: 'library', label: 'Report library' },
          { value: 'saved', label: `Saved${saved.data ? ` (${saved.data.length})` : ''}` },
        ]}
        value={search.tab ?? 'library'}
        onValueChange={(v) => update({ tab: v })}
        aria-label="Reports"
      >
        <TabsContent value="library" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
            <div className="flex flex-col gap-3">
              <Input
                value={search.q ?? ''}
                onChange={(e) => update({ q: e.target.value || undefined })}
                placeholder="Search reports…"
              />
              {catalog.isPending ? (
                <Skeleton className="h-96 w-full" />
              ) : (
                <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
                  {grouped.map((group) => (
                    <div key={group.category}>
                      <h2 className="mb-1.5 eyebrow">
                        {CATEGORY_LABELS[group.category]}
                      </h2>
                      <div className="flex flex-col gap-1.5">
                        {group.reports.map((report) => (
                          <ReportCard
                            key={report.key}
                            report={report}
                            active={report.key === search.report}
                            onSelect={() => {
                              setResult(null);
                              update({ report: report.key });
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  {grouped.length === 0 ? (
                    <p className="text-sm text-faint">No report matches that search.</p>
                  ) : null}
                </div>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              {!selected ? (
                <EmptyState
                  icon={<FileText />}
                  title="Choose a report"
                  description="Pick one from the library to set its filters and run it."
                />
              ) : selected.unavailable ? (
                <Alert
                  tone="info"
                  title={`${selected.name} cannot be produced yet`}
                  description={selected.unavailable}
                />
              ) : (
                <>
                  <Card className="flex flex-wrap items-end gap-3 p-4">
                    <span className="mr-auto min-w-0">
                      <span className="block text-sm font-semibold text-ink">{selected.name}</span>
                      <span className="block text-xs text-muted">{selected.dataSource}</span>
                    </span>
                    {selected.filters.includes('dateRange') ? (
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="font-medium text-muted">Period</span>
                        <Select
                          value={preset}
                          onValueChange={(v) => update({ preset: v })}
                          options={PERIOD_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
                        />
                      </label>
                    ) : null}
                    {selected.filters.includes('department') ? (
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="font-medium text-muted">Department</span>
                        <Input
                          value={search.department ?? ''}
                          onChange={(e) => update({ department: e.target.value || undefined })}
                          placeholder="All"
                          className="w-36"
                        />
                      </label>
                    ) : null}
                    {selected.filters.includes('status') ? (
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="font-medium text-muted">Status</span>
                        <Input
                          value={search.status ?? ''}
                          onChange={(e) => update({ status: e.target.value || undefined })}
                          placeholder="All"
                          className="w-32"
                        />
                      </label>
                    ) : null}
                    <Button
                      variant="primary"
                      icon={<Play />}
                      loading={run.isPending}
                      onClick={() => runReport(selected)}
                    >
                      Run report
                    </Button>
                  </Card>

                  {run.error ? (
                    <Alert
                      tone="danger"
                      title="Unable to generate this report"
                      description={
                        run.error instanceof ApiError ? run.error.message : 'Something went wrong.'
                      }
                    />
                  ) : null}

                  {run.isPending ? (
                    <Skeleton className="h-96 w-full" />
                  ) : result ? (
                    <ResultTable
                      result={result}
                      onExport={() => {
                        downloadCsv(result);
                        toast({ tone: 'success', title: 'Exported as CSV' });
                      }}
                      onSave={() => setSaveOpen(true)}
                    />
                  ) : null}
                </>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="saved" className="pt-4">
          {saved.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : saved.data && saved.data.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {saved.data.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  onClick={() => {
                    setResult(null);
                    update({ tab: 'library', report: view.reportKey, ...view.config });
                  }}
                  className="flex flex-col gap-1 rounded-lg border border-line-soft bg-surface p-4 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <span className="text-sm font-semibold text-ink">{view.name}</span>
                  <span className="text-xs text-muted">
                    {view.reportName} · {CATEGORY_LABELS[view.category]}
                  </span>
                  <span className="mt-1 text-xs text-faint">
                    Saved by {view.ownerName}
                    {view.lastRunAt
                      ? ` · last run ${new Date(view.lastRunAt).toLocaleDateString()}`
                      : ''}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Save />}
              title="No saved reports"
              description="Run a report, then save its configuration to come back to the same view."
            />
          )}
        </TabsContent>
      </Tabs>

      {saveOpen && selected && result ? (
        <Modal
          open
          onOpenChange={(o) => !o && setSaveOpen(false)}
          title="Save this report"
          description="The configuration is stored, not the results — reopening it runs the report again against current data."
          footer={<SaveFooter />}
        >
          <SaveForm
            reportKey={selected.key}
            config={{ preset, ...filters }}
            pending={save.isPending}
            error={save.error}
            onDone={() => {
              setSaveOpen(false);
              toast({ tone: 'success', title: 'Saved' });
            }}
            onSave={(name, config) => save.mutate({ name, reportKey: selected.key, config })}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function SaveFooter() {
  return null;
}

function SaveForm({
  config,
  pending,
  error,
  onSave,
  onDone,
}: {
  reportKey: string;
  config: Record<string, unknown>;
  pending: boolean;
  error: unknown;
  onSave: (name: string, config: Record<string, unknown>) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert
          tone="danger"
          title="Not saved"
          description={error instanceof ApiError ? error.message : 'Something went wrong.'}
        />
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Name</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Weekly truck profitability"
        />
      </label>
      <p className="text-xs text-muted">
        Storing:{' '}
        {Object.entries(config)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(', ') || 'no filters'}
      </p>
      <div className="flex justify-end">
        <Button
          loading={pending}
          disabled={!name.trim()}
          onClick={() => {
            onSave(name.trim(), config);
            onDone();
          }}
        >
          Save report
        </Button>
      </div>
    </div>
  );
}

function ReportCard({
  report,
  active,
  onSelect,
}: {
  report: ReportDefinition;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left',
        'transition-colors duration-(--duration-base) ease-(--ease-standard)',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        active
          ? 'border-primary-border bg-primary-soft'
          : 'border-line bg-surface hover:bg-surface-hover',
      )}
    >
      <span className="flex items-center gap-2">
        <span className="text-sm font-medium text-ink">{report.name}</span>
        {report.unavailable ? (
          <Badge tone="neutral" title={report.unavailable}>
            <Ban className="mr-1 size-3" aria-hidden />
            No data
          </Badge>
        ) : null}
      </span>
      <span className="text-xs text-muted">{report.description}</span>
    </button>
  );
}

/** The result: summary, rows, totals and export. */
function ResultTable({
  result,
  onExport,
  onSave,
}: {
  result: ReportResult;
  onExport: () => void;
  onSave: () => void;
}) {
  if (result.rows.length === 0) {
    return (
      <EmptyState
        icon={<FileText />}
        title="No rows for this period"
        description={`${result.name} ran successfully over ${result.range.from} to ${result.range.to} and found nothing. That is a genuinely empty period, not a failure.`}
      />
    );
  }

  return (
    <Card className="flex min-w-0 flex-col p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">{result.name}</span>
          <span className="block text-xs text-muted">
            {formatIsoDate(result.range.from)} – {formatIsoDate(result.range.to)} ·{' '}
            {formatNumber(result.total)} rows ·{' '}
            {result.source === 'database' ? 'Live records' : 'Reporting dataset'}
          </span>
        </span>
        <span className="flex gap-2">
          <Button variant="secondary" icon={<Save />} onClick={onSave}>
            Save view
          </Button>
          <Button variant="secondary" icon={<Download />} onClick={onExport}>
            Export CSV
          </Button>
        </span>
      </div>

      {result.notes.length > 0 ? (
        <ul className="border-b border-line-soft bg-surface-muted px-4 py-2 text-xs text-muted">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs font-semibold text-secondary">
            <tr className="border-b border-line-soft">
              {result.columns.map((column) => (
                <th
                  key={column.key}
                  className={cn(
                    'px-4 py-2 font-medium whitespace-nowrap',
                    column.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.id} className="border-b border-line-soft last:border-0">
                {result.columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      'px-4 py-1.5 whitespace-nowrap',
                      column.align === 'right' ? 'text-right tabular-nums' : 'text-left',
                    )}
                  >
                    <Cell value={row.cells[column.key]} column={column} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {Object.keys(result.totals).length > 0 ? (
            <tfoot>
              <tr className="border-t-2 border-line-strong font-semibold">
                {result.columns.map((column, index) => (
                  <td
                    key={column.key}
                    className={cn(
                      'px-4 py-2 whitespace-nowrap',
                      column.align === 'right' ? 'text-right tabular-nums' : 'text-left',
                    )}
                  >
                    {index === 0 ? (
                      'Total'
                    ) : (
                      <Cell value={result.totals[column.key]} column={column} />
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </Card>
  );
}

/** Renders a cell. `null` is an em dash with a reason, never a zero. */
function Cell({ value, column }: { value: ReportCell | undefined; column: ReportColumn }) {
  if (value === null || value === undefined) {
    return (
      <span className="text-faint" title="Not available for this period">
        —
      </span>
    );
  }
  if (column.type === 'money' && typeof value === 'number') {
    return <span className={cn(value < 0 && 'text-danger-text')}>{formatMoney(value)}</span>;
  }
  if (column.type === 'percent' && typeof value === 'number') {
    return <span>{value.toFixed(1)}%</span>;
  }
  if (column.type === 'number' && typeof value === 'number') {
    return <span>{formatNumber(value)}</span>;
  }
  if (column.type === 'date') return <span>{formatIsoDate(String(value))}</span>;
  if (column.type === 'status') {
    return <Badge tone="neutral">{String(value).replace(/_/g, ' ')}</Badge>;
  }
  return <span>{String(value)}</span>;
}
