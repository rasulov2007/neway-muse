import { useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download, ShieldCheck } from 'lucide-react';
import { API_PREFIX, type AuditEntry } from '@neway/shared';
import {
  Alert,
  Badge,
  Card,
  DataTable,
  DatePicker,
  Input,
  PageHeader,
  Select,
  createColumns,
} from '@/design-system';
import { formatDateTime } from '@/lib/format';
import { Absent, PermissionGate } from './components/AdminKit';
import { adminSearchSchema } from './admin-search';
import { useAuditFacets, useAuditLog, useHasPermission, usePermissionCheck } from './useAdmin';

const col = createColumns<AuditEntry>();

export function AuditLogPage() {
  const check = usePermissionCheck('audit.view');
  return (
    <PermissionGate check={check} permission="audit.view" what="the audit trail">
      <AuditLogPageContent />
    </PermissionGate>
  );
}

/**
 * The audit trail.
 *
 * Read-only, and not by convention: the API exposes list, read and export for audit records and
 * nothing else, and the service behind them has no write path for an edit endpoint to call. There
 * is no "Edit entry" and no "Delete entry" here because there is nothing on the server to call.
 *
 * Every result carries the coverage window, so a filter that finds nothing can say whether that
 * means the change never happened or happened before this trail began.
 */
function AuditLogPageContent() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => adminSearchSchema.parse(raw), [raw]);
  const navigate = useNavigate();

  const canExport = useHasPermission('audit.export');

  const params = useMemo(
    () => ({
      page: search.page,
      pageSize: search.pageSize,
      search: search.q,
      action: search.action,
      entityType: search.entityType,
      actorId: search.actorId,
      from: search.from,
      to: search.to,
    }),
    [search],
  );

  const log = useAuditLog(params);
  const facets = useAuditFacets();

  const setSearch = (patch: Record<string, unknown>) => {
    void navigate({ to: '/admin/audit-logs', search: { ...search, page: 1, ...patch } });
  };

  const columns = useMemo(
    () => [
      col.accessor('at', { header: 'When', cell: (info) => formatDateTime(info.getValue()) }),
      col.accessor('actorName', {
        header: 'Who',
        cell: (info) => (
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-ink">{info.getValue()}</span>
            {info.row.original.actorType !== 'user' ? (
              <Badge tone="neutral" variant="outline" size="sm">
                {info.row.original.actorType}
              </Badge>
            ) : null}
          </div>
        ),
      }),
      col.accessor('actionLabel', { header: 'Action' }),
      col.accessor('entityLabel', {
        header: 'Record',
        cell: (info) => (
          <div className="flex flex-col">
            <span className="text-sm text-ink">{info.getValue()}</span>
            <span className="text-xs text-muted">
              {info.row.original.entityType} · {info.row.original.entityId}
            </span>
          </div>
        ),
      }),
      col.accessor('summary', {
        header: 'What changed',
        enableSorting: false,
        cell: (info) => (
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-ink">{info.getValue()}</span>
            {info.row.original.changes.map((change) => (
              <span key={change.field} className="text-xs text-muted">
                {change.field}: {change.old ?? '—'} → {change.new ?? '—'}
              </span>
            ))}
            {info.row.original.reason ? (
              <span className="text-xs italic text-muted">“{info.row.original.reason}”</span>
            ) : null}
          </div>
        ),
      }),
    ],
    [],
  );

  const exportHref = `/${API_PREFIX}/admin/audit/export?${new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined || value === '' ? [] : [[key, String(value)]],
    ),
  ).toString()}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Audit log"
        description="Every recorded change, who made it and what it changed."
        actions={
          canExport ? (
            <a
              href={exportHref}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-sm font-medium text-ink hover:bg-surface-hover"
            >
              <Download aria-hidden className="size-4" />
              Export CSV
            </a>
          ) : null
        }
      />

      <Alert tone="neutral" title="Records here cannot be changed">
        <span className="flex items-center gap-1.5">
          <ShieldCheck aria-hidden className="size-4" />
          There is no endpoint to edit or delete an audit entry. {log.data?.coverage.note}
        </span>
      </Alert>

      <DataTable
        columns={columns}
        data={log.data?.data ?? []}
        rowKey={(row) => row.id}
        total={log.data?.total}
        serverSide
        loading={log.isLoading}
        error={log.error}
        onRetry={() => void log.refetch()}
        emptyTitle="Nothing matches"
        emptyDescription={
          log.data?.coverage.total === 0
            ? 'Nothing has been recorded yet.'
            : 'Widen the date range or clear a filter. Changes made before this trail began are not in it.'
        }
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search record, summary or person"
              defaultValue={search.q ?? ''}
              onChange={(event) => setSearch({ q: event.target.value || undefined })}
              className="w-64"
              aria-label="Search the audit log"
            />
            <Select
              options={[
                { value: '', label: 'Any action' },
                ...(facets.data?.actions ?? []).map((action) => ({
                  value: action.value,
                  label: action.label,
                })),
              ]}
              value={search.action ?? ''}
              onValueChange={(value) => setSearch({ action: value || undefined })}
              aria-label="Filter by action"
            />
            <Select
              options={[
                { value: '', label: 'Any record type' },
                ...(facets.data?.entityTypes ?? []).map((type) => ({ value: type, label: type })),
              ]}
              value={search.entityType ?? ''}
              onValueChange={(value) => setSearch({ entityType: value || undefined })}
              aria-label="Filter by record type"
            />
            <Select
              options={[
                { value: '', label: 'Anyone' },
                ...(facets.data?.actors ?? []).map((actor) => ({
                  value: actor.id,
                  label: actor.name,
                })),
              ]}
              value={search.actorId ?? ''}
              onValueChange={(value) => setSearch({ actorId: value || undefined })}
              aria-label="Filter by person"
            />
            <DatePicker
              value={search.from ?? ''}
              onIsoChange={(event) => setSearch({ from: event || undefined })}
              aria-label="From date"
            />
            <DatePicker
              value={search.to ?? ''}
              onIsoChange={(event) => setSearch({ to: event || undefined })}
              aria-label="To date"
            />
          </div>
        }
      />

      {log.data ? (
        <Card className="p-3 text-xs text-muted">
          Recording from{' '}
          {log.data.coverage.earliest ? (
            formatDateTime(log.data.coverage.earliest)
          ) : (
            <Absent>—</Absent>
          )}{' '}
          to{' '}
          {log.data.coverage.latest ? formatDateTime(log.data.coverage.latest) : <Absent>—</Absent>}
          . {log.data.coverage.total.toLocaleString()} entries in total.
        </Card>
      ) : null}
    </div>
  );
}
