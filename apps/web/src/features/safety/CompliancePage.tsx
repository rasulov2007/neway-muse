import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ComplianceScope, EntityCompliance } from '@neway/shared';
import { FileText, ShieldOff } from 'lucide-react';
import { useMemo } from 'react';
import type { ComplianceDocumentStatus } from '@neway/shared';
import { listComplianceDocuments } from './compliance-api';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  PageHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  cn,
  createColumns,
  getStatus,
  type FilterDefinition,
} from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import { ConsentCenter } from './ConsentCenter';
import { DocumentRow, EntityComplianceDrawer } from './EntityComplianceDrawer';
import { VerificationPipeline } from './VerificationPipeline';
import {
  ROLE_LABEL,
  SCOPE_LABEL,
  daysLabel,
  deadlineDays,
  entityKey,
  openItems,
} from './compliance-ui';
import {
  COMPLIANCE_FOCUSES,
  FOCUS_LABEL,
  complianceSearchSchema,
  type ComplianceFocus,
  type ComplianceSearch,
  type ComplianceTab,
} from './safety-search';
import { useCompliance, type ComplianceBundle } from './useCompliance';
import { ExpiryBadge } from '@/features/documents/ExpiryBadge';

const EXPIRING_WINDOW_DAYS = 30;

const TAB_SCOPE: Partial<Record<ComplianceTab, ComplianceScope>> = {
  drivers: 'driver',
  trucks: 'truck',
  trailers: 'trailer',
};

function matchesFocus(entity: EntityCompliance, focus: ComplianceFocus | undefined): boolean {
  if (!focus) return true;
  switch (focus) {
    case 'held':
      return !entity.dispatchable;
    case 'expiring':
      return entity.items.some(
        (i) =>
          i.status === 'expiring' &&
          i.daysRemaining !== null &&
          i.daysRemaining <= EXPIRING_WINDOW_DAYS,
      );
    case 'expired':
      return entity.items.some((i) => i.status === 'expired');
    case 'missing':
      return entity.items.some((i) => i.status === 'missing');
    case 'pending':
      return entity.items.some((i) => i.status === 'pending_verification');
    case 'failed':
      return entity.items.some((i) => i.status === 'verification_failed');
    case 'critical':
      return entity.severity === 'critical';
    default:
      return true;
  }
}

/**
 * The compliance workbench: one tab per entity type plus documents, consent and verification.
 * Every filter lives in the URL so a number on the command centre opens exactly its rows.
 */
export function CompliancePage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => complianceSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const compliance = useCompliance();
  const tab: ComplianceTab = search.tab ?? 'drivers';

  function updateSearch(patch: Partial<ComplianceSearch>) {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const key of Object.keys(next)) {
          if (next[key] === undefined || next[key] === '') delete next[key];
        }
        return next;
      },
      replace: true,
    });
  }

  const bundle = compliance.data;
  const openEntity = search.entity && bundle ? (bundle.byKey.get(search.entity) ?? null) : null;

  const tabItems = useMemo(
    () => [
      { value: 'drivers', label: 'Drivers', count: bundle?.byScope.driver.entities },
      { value: 'trucks', label: 'Units', count: bundle?.byScope.truck.entities },
      { value: 'trailers', label: 'Trailers', count: bundle?.byScope.trailer.entities },
      { value: 'documents', label: 'Documents' },
      { value: 'consents', label: 'Consent' },
      { value: 'verification', label: 'Verification' },
    ],
    [bundle],
  );

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Driver Qualifications"
        description={
          bundle
            ? `Every driver, unit and trailer against the requirement catalog, as of ${formatIsoDate(bundle.today)}.`
            : 'Driver qualification, vehicle documents, consent and verification.'
        }
        tabs={
          <Tabs
            aria-label="Compliance sections"
            items={tabItems}
            value={tab}
            onValueChange={(value) =>
              updateSearch({
                tab: value as ComplianceTab,
                focus: undefined,
                state: undefined,
                q: undefined,
              })
            }
            listClassName="scroll-quiet overflow-x-auto border-b-0"
          />
        }
      />

      {compliance.isError ? (
        <ErrorState
          title="Compliance couldn't be loaded"
          description="Please try again."
          error={compliance.error}
          onRetry={() => void compliance.refetch()}
          retrying={compliance.isFetching}
        />
      ) : TAB_SCOPE[tab] ? (
        bundle ? (
          <EntityTable
            bundle={bundle}
            scope={TAB_SCOPE[tab] as ComplianceScope}
            search={search}
            onSearch={updateSearch}
          />
        ) : (
          <Skeleton className="h-96" />
        )
      ) : tab === 'documents' ? (
        <DocumentsTab search={search} onSearch={updateSearch} />
      ) : tab === 'consents' ? (
        <ConsentCenter />
      ) : (
        <VerificationPipeline
          caseId={search.case}
          onOpenCase={(id) => updateSearch({ case: id })}
        />
      )}

      <EntityComplianceDrawer
        entity={openEntity}
        onClose={() => updateSearch({ entity: undefined })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const col = createColumns<EntityCompliance>();

const makeEntityColumns = (today: string) =>
  col.columns([
    col.accessor('entityLabel', {
      header: 'Name',
      meta: { primary: true, width: 200 },
    }),
    col.accessor('state', {
      header: 'Status',
      cell: ({ getValue }) => <StatusBadge status={getValue()} size="sm" />,
      meta: { width: 130 },
    }),
    col.accessor('dispatchable', {
      header: 'Dispatch',
      cell: ({ row }) =>
        row.original.dispatchable ? (
          <span className="text-xs text-muted">Clear</span>
        ) : (
          <Badge tone="danger" size="sm" icon={<ShieldOff />}>
            Hold
          </Badge>
        ),
      meta: { width: 100 },
    }),
    col.display({
      id: 'issues',
      header: 'Open items',
      cell: ({ row }) => {
        const issues = openItems(row.original);
        if (issues.length === 0) return <span className="text-xs text-muted">None</span>;
        return (
          <span className="flex flex-wrap gap-1">
            {issues.slice(0, 3).map((item) => (
              <span key={item.requirementCode} className="inline-flex items-center gap-1 text-xs">
                <StatusBadge status={item.status} size="sm" />
                <span className="text-ink">{item.requirementName}</span>
              </span>
            ))}
            {issues.length > 3 ? (
              <span className="text-xs text-muted">+{issues.length - 3} more</span>
            ) : null}
          </span>
        );
      },
    }),
    col.accessor('nextDeadline', {
      header: 'Next deadline',
      cell: ({ row }) => {
        const first = openItems(row.original)[0];
        if (!row.original.nextDeadline || !first) return <span className="text-muted">—</span>;
        // When the deadline is an expiry date, the colour and words are the shared expiry bands.
        if ((first.status === 'expiring' || first.status === 'expired') && first.expiresOn) {
          return (
            <span className="whitespace-nowrap">
              <ExpiryBadge expiresOn={first.expiresOn} today={today} variant="text" />
              <span className="block text-xs font-normal text-muted">
                {formatIsoDate(first.expiresOn)}
              </span>
            </span>
          );
        }
        return (
          <span
            className={cn(
              'whitespace-nowrap',
              first.severity === 'critical'
                ? 'font-medium text-danger-text'
                : first.severity === 'warning'
                  ? 'font-medium text-warning-text'
                  : 'text-secondary',
            )}
          >
            {daysLabel(deadlineDays(first, today))}
            <span className="block text-xs font-normal text-muted">
              {formatIsoDate(row.original.nextDeadline)}
            </span>
          </span>
        );
      },
      meta: { width: 140 },
    }),
    col.display({
      id: 'owner',
      header: 'Owner',
      cell: ({ row }) => {
        const first = openItems(row.original)[0];
        return (
          <span className="text-xs whitespace-nowrap text-secondary">
            {first ? ROLE_LABEL[first.owner] : '—'}
          </span>
        );
      },
      meta: { width: 150 },
    }),
    col.display({
      id: 'satisfied',
      header: 'Satisfied',
      cell: ({ row }) => (
        <span className="tabular text-xs text-secondary">
          {row.original.counts.satisfied}/{row.original.counts.total}
        </span>
      ),
      meta: { align: 'right', width: 90 },
    }),
  ]);

function EntityTable({
  bundle,
  scope,
  search,
  onSearch,
}: {
  bundle: ComplianceBundle;
  scope: ComplianceScope;
  search: ComplianceSearch;
  onSearch: (patch: Partial<ComplianceSearch>) => void;
}) {
  const columns = useMemo(() => makeEntityColumns(bundle.today), [bundle.today]);
  const rows = useMemo(() => {
    const q = (search.q ?? '').trim().toLowerCase();
    return bundle.entities
      .filter((e) => e.scope === scope)
      .filter((e) => !search.state || e.state === search.state)
      .filter((e) => matchesFocus(e, search.focus))
      .filter((e) => !q || e.entityLabel.toLowerCase().includes(q))
      .sort((a, b) => {
        const rank = { critical: 0, warning: 1, info: 2, ok: 3 } as const;
        if (a.dispatchable !== b.dispatchable) return a.dispatchable ? 1 : -1;
        if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
        return a.entityLabel.localeCompare(b.entityLabel);
      });
  }, [bundle.entities, scope, search]);

  const filters: FilterDefinition[] = [
    {
      key: 'state',
      label: 'Status',
      type: 'select',
      options: ['non_compliant', 'at_risk', 'compliant'].map((code) => ({
        value: code,
        label: getStatus(code).label,
      })),
    },
    {
      key: 'focus',
      label: 'Focus',
      type: 'select',
      options: COMPLIANCE_FOCUSES.map((focus) => ({ value: focus, label: FOCUS_LABEL[focus] })),
    },
  ];

  const summary = bundle.byScope[scope];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span>
          <span className="font-medium text-ink">{summary.compliant}</span> compliant
        </span>
        <span>
          <span className="font-medium text-warning-text">{summary.atRisk}</span> at risk
        </span>
        <span>
          <span className="font-medium text-danger-text">{summary.nonCompliant}</span> non-compliant
        </span>
        <span>
          <span className="font-medium text-danger-text">{summary.notDispatchable}</span> on hold
        </span>
        {search.focus ? (
          <Badge tone="info" size="sm">
            {FOCUS_LABEL[search.focus]}
          </Badge>
        ) : null}
      </div>
      {/* The test id sits on a wrapper: DataTable takes a fixed prop set and does not
          forward unknown attributes to the DOM. */}
      <div data-testid={`compliance-${scope}-table`}>
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(row) => entityKey(row.scope, row.entityId)}
          dense
          onRowClick={(row) => onSearch({ entity: entityKey(row.scope, row.entityId) })}
          toolbar={
            <FilterBar
              search={{
                value: search.q ?? '',
                onChange: (value) => onSearch({ q: value || undefined }),
                placeholder: `Search ${SCOPE_LABEL[scope].toLowerCase()}s`,
              }}
              filters={filters}
              values={{ state: search.state, focus: search.focus }}
              onChange={(key, value) =>
                onSearch({ [key]: (value as string | undefined) || undefined })
              }
              onClear={() => onSearch({ state: undefined, focus: undefined, q: undefined })}
            />
          }
          emptyTitle="No records match"
          emptyDescription="Try clearing the status or focus filter."
          caption={`${SCOPE_LABEL[scope]} compliance`}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const DOCUMENT_STATUSES: ComplianceDocumentStatus[] = [
  'pending_review',
  'verified',
  'rejected',
  'expired',
];

function DocumentsTab({
  search,
  onSearch,
}: {
  search: ComplianceSearch;
  onSearch: (patch: Partial<ComplianceSearch>) => void;
}) {
  const query = useQuery({
    queryKey: ['compliance-documents', 'all'],
    queryFn: () => listComplianceDocuments(),
  });
  const status = search.state as string | undefined; // reuse the slot; documents have their own statuses
  const rows = useMemo(() => {
    const q = (search.q ?? '').trim().toLowerCase();
    return (query.data ?? [])
      .filter((d) => !status || d.status === status)
      .filter(
        (d) =>
          !q ||
          d.ownerLabel.toLowerCase().includes(q) ||
          d.title.toLowerCase().includes(q) ||
          d.fileName.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const rank: Record<ComplianceDocumentStatus, number> = {
          pending_review: 0,
          rejected: 1,
          expired: 2,
          verified: 3,
        };
        return rank[a.status] - rank[b.status] || b.uploadedAt.localeCompare(a.uploadedAt);
      });
  }, [query.data, status, search.q]);

  if (query.isPending) return <Skeleton className="h-96" />;
  if (query.isError) {
    return (
      <ErrorState
        title="Documents couldn't be loaded"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const pending = (query.data ?? []).filter((d) => d.status === 'pending_review').length;
  return (
    <Card
      padding="none"
      title="Compliance documents"
      description={`${query.data?.length ?? 0} on file · ${pending} waiting for review`}
      actions={
        <FilterBar
          search={{
            value: search.q ?? '',
            onChange: (value) => onSearch({ q: value || undefined }),
            placeholder: 'Search owner, title or file',
          }}
          filters={[
            {
              key: 'state',
              label: 'Status',
              type: 'select',
              options: DOCUMENT_STATUSES.map((s) => ({ value: s, label: getStatus(s).label })),
            },
          ]}
          values={{ state: status }}
          onChange={(key, value) => onSearch({ [key]: (value as string | undefined) || undefined })}
          onClear={() => onSearch({ state: undefined, q: undefined })}
        />
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title="No documents match"
          description="Try clearing the filter."
        />
      ) : (
        <ul className="divide-y divide-line-soft">
          {rows.map((doc) => (
            <li key={doc.id} className="flex flex-col">
              <div className="px-4 pt-3 eyebrow">
                {doc.ownerType} · {doc.ownerLabel} · {doc.requirementCode.replace(/_/g, ' ')}
              </div>
              <ul>
                <DocumentRow doc={doc} />
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
