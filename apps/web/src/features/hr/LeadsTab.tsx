import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronRight, CircleCheck, Phone, PhoneCall, UserPlus, Users, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  APPLICANT_SOURCES,
  CAMPAIGN_CHANNEL_LABELS,
  CDL_CLASSES,
  CDL_ENDORSEMENTS,
  CDL_ENDORSEMENT_LABELS,
  DRIVER_TYPES,
  LEAD_SORT_KEYS,
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  isRecruiterPosition,
  type Lead,
  type LeadSortKey,
  type Prequalification,
  type PrequalificationRules,
} from '@neway/shared';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Checkbox,
  DataTable,
  DatePicker,
  Drawer,
  EmptyState,
  FilterBar,
  FormField,
  Input,
  MenuItem,
  Modal,
  Select,
  Textarea,
  createColumns,
  type FilterDefinition,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatPhone, formatRelative } from '@/lib/format';
import type { HrSearch } from './hr-search';
import { LeadApplications } from './LeadApplications';
import { AddNoteDialog, LeadNotesHistory, RotationLine, type NoteTarget } from './LeadNotes';
import { StatCard } from './RecruitingKit';
import { fieldErrors, rangeLabel, type Period } from './recruiting-kit';
import {
  AssignRecruiterDialog,
  FollowUpDialog,
  type FollowUpTarget,
  type RecruiterTarget,
} from './RecruitingParts';
import {
  hiringApi,
  useCampaigns,
  useHiringMutation,
  useLead,
  useLeadSummary,
  useLeads,
  usePrequalificationRules,
  useUncontactedLeads,
} from './useHiring';

const col = createColumns<Lead>();

/** Lead statuses keep the families they had; each shows its symbol and its word. */
const TONE: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  // Red until somebody contacts the lead (owner, 2026-10-06): the urgent family, symbol + word.
  new: 'danger',
  contacted: 'neutral',
  prequalified: 'success',
  converted: 'success',
  dead: 'neutral',
};

export function LeadStatusBadge({ lead }: { lead: Lead }) {
  const flagged =
    lead.prequalResult !== null && !lead.prequalResult.qualifies && lead.status !== 'dead';
  if (flagged) {
    return (
      <Badge tone="warning" dot title={lead.prequalResult?.failed.map((f) => f.detail).join('; ')}>
        Does not prequalify
      </Badge>
    );
  }
  return (
    <Badge
      tone={TONE[lead.status] ?? 'neutral'}
      dot
      title={lead.status === 'converted' ? 'Converted into a candidate in the pipeline — not yet a hire' : undefined}
    >
      {lead.status === 'new' ? 'New · needs contact' : LEAD_STATUS_LABELS[lead.status]}
    </Badge>
  );
}

const sourceLabel = (source: string) => LEAD_SOURCE_LABELS[source] ?? source.replace(/_/g, ' ');

const HIDDEN_KEY = 'nw.recruiting.leads.hiddenColumns';
function readHidden(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * Recruiting › Leads (owner's redesign, 2026-10-01).
 *
 * The list and its three cards read the same cohort: leads added in the reporting period. Status,
 * source, recruiter and campaign narrow it; sorting and paging are done by the server, so the
 * count at the foot is the real count. "Converted" means converted into a candidate record in
 * the pipeline — not hired.
 */
export function LeadsTab({
  search,
  period,
  update,
  onAddLead,
}: {
  search: HrSearch;
  period: Period;
  update: (patch: Record<string, unknown>) => void;
  onAddLead: () => void;
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const canManage = useAccount()?.permissions.includes('recruiting.manage') ?? false;
  const sort: LeadSortKey = (LEAD_SORT_KEYS as readonly string[]).includes(search.sort ?? '')
    ? (search.sort as LeadSortKey)
    : 'createdAt';
  const dir = search.dir === 'asc' ? 'asc' : 'desc';
  const params = useMemo(
    () => ({
      page: search.page ?? 1,
      pageSize: search.pageSize ?? 25,
      search: search.q,
      status: search.status === 'flagged' ? undefined : search.status,
      flagged: search.status === 'flagged' ? 'true' : undefined,
      source: search.source,
      recruiterEmployeeId: search.recruiter,
      campaignId: search.campaign,
      from: period.from,
      to: period.to,
      sort,
      dir,
    }),
    [search, period.from, period.to, sort, dir],
  );
  const leads = useLeads(params);
  const summary = useLeadSummary({ from: period.from, to: period.to });
  // Every lead still New, whatever period is picked: the red alert counts them all.
  const waitingLeads = useUncontactedLeads().data?.uncontacted ?? 0;
  const selected = useLead(search.lead ?? null);
  const employees = useEmployeeDirectory();
  const campaignList = useCampaigns();
  const campaignNames = useMemo(
    () => new Map((campaignList.data ?? []).map((c) => [c.id, c.name])),
    [campaignList.data],
  );
  const [prequalFor, setPrequalFor] = useState<Lead | null>(null);
  const [disqualifyFor, setDisqualifyFor] = useState<Lead | null>(null);
  const [assign, setAssign] = useState<RecruiterTarget | null>(null);
  const [followUp, setFollowUp] = useState<FollowUpTarget | null>(null);
  const [noteFor, setNoteFor] = useState<NoteTarget | null>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>(readHidden);
  useEffect(() => {
    try {
      window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
    } catch {
      /* per-viewer convenience only */
    }
  }, [hidden]);

  const contacted = useHiringMutation((id: string) => hiringApi.markContacted(id));
  const convert = useHiringMutation((id: string) => hiringApi.convert(id));

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast({ title: label, tone: 'success' });
    } catch (error) {
      toast({ title: error instanceof ApiError ? error.message : 'Something went wrong', tone: 'danger' });
    }
  };
  const convertLead = async (lead: Lead) => {
    try {
      const done = await convert.mutateAsync(lead.id);
      toast({
        tone: 'success',
        title: `${lead.name} is now a candidate`,
        description: 'Converted into a candidate record in the pipeline. The DOT application is next.',
        action: done.applicantId
          ? {
              label: 'Open candidate',
              onClick: () =>
                void navigate({ to: '/hr/recruiting/$candidateId', params: { candidateId: done.applicantId as string } }),
            }
          : undefined,
      });
    } catch (error) {
      toast({ title: error instanceof ApiError ? error.message : 'Could not convert the lead', tone: 'danger' });
    }
  };

  const assignTarget = (l: Lead): RecruiterTarget => ({
    kind: l.hiringCaseId ? 'case' : 'lead',
    id: l.hiringCaseId ?? l.id,
    name: l.name,
    currentId: l.recruiterEmployeeId,
  });

  const s = summary.data;
  const filtersActive = Boolean(search.q || search.status || search.source || search.recruiter || search.campaign);
  const recruiterOptions = (employees.data ?? [])
    .filter((e) => e.id === search.recruiter || (e.status !== 'terminated' && isRecruiterPosition(e.position)))
    .map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` }));

  const filters: FilterDefinition[] = [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        ...LEAD_STATUSES.map((v) => ({ value: v, label: LEAD_STATUS_LABELS[v] })),
        { value: 'flagged', label: 'Does not prequalify' },
      ],
    },
    {
      key: 'source',
      label: 'Source',
      type: 'select',
      options: APPLICANT_SOURCES.map((v) => ({ value: v, label: sourceLabel(v) })),
    },
    { key: 'recruiter', label: 'Recruiter', type: 'select', options: recruiterOptions },
    ...((campaignList.data ?? []).length > 0
      ? [
          {
            key: 'campaign',
            label: 'Campaign',
            type: 'select' as const,
            options: (campaignList.data ?? []).map((c) => ({ value: c.id, label: c.name })),
          },
        ]
      : []),
  ];

  const columns = useMemo(
    () => [
      col.accessor('name', {
        id: 'name',
        header: 'Driver',
        meta: { primary: true, width: 280 },
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-3">
            <Avatar name={row.original.name} size="md" />
            <span className="min-w-0">
              <span className="block truncate font-semibold text-ink" title={row.original.name}>
                {row.original.name}
              </span>
              <span className="block truncate text-xs text-muted">
                {formatPhone(row.original.phone)} · {row.original.leadNumber}
              </span>
            </span>
          </span>
        ),
      }),
      col.accessor('status', {
        id: 'status',
        header: 'Status',
        meta: { width: 170 },
        cell: ({ row }) => <LeadStatusBadge lead={row.original} />,
      }),
      col.accessor('source', {
        id: 'source',
        header: 'Source',
        meta: { width: 160 },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{sourceLabel(row.original.source)}</span>
            {row.original.latestApplication ? (
              <span className="truncate text-xs text-muted">
                {row.original.applicationCount > 1
                  ? `Applied online ${row.original.applicationCount}×`
                  : 'Applied online'}
              </span>
            ) : null}
            {row.original.campaignId ? (
              <span className="truncate text-xs text-muted">
                {campaignNames.get(row.original.campaignId) ?? 'Campaign'}
              </span>
            ) : null}
          </span>
        ),
      }),
      col.accessor('cdlClass', {
        id: 'cdlClass',
        header: 'CDL',
        meta: { width: 70 },
        cell: (info) => info.getValue() ?? <span className="text-faint" title="Not recorded">—</span>,
      }),
      col.accessor('yearsExperience', {
        id: 'yearsExperience',
        header: 'Experience',
        meta: { width: 110 },
        cell: (info) => {
          const v = info.getValue();
          if (v !== null) return `${v} year${v === 1 ? '' : 's'}`;
          // An online applicant answers in their own words; show what they wrote.
          const said = info.row.original.latestApplication?.experience;
          return said ? (
            <span className="block truncate" title={said}>
              {said}
            </span>
          ) : (
            <span className="text-faint" title="Not recorded">—</span>
          );
        },
      }),
      col.accessor('recruiterName', {
        id: 'recruiter',
        header: 'Recruiter',
        meta: { width: 170 },
        // The recruiter is chosen here (owner, 2026-10-04): a set name opens the same picker.
        cell: ({ row }) =>
          row.original.recruiterName ? (
            canManage && row.original.status !== 'dead' && row.original.status !== 'converted' ? (
              <button
                type="button"
                title="Change recruiter"
                className="truncate text-left text-sm text-ink underline-offset-2 hover:text-primary-text hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  setAssign(assignTarget(row.original));
                }}
              >
                {row.original.recruiterName}
              </button>
            ) : (
              <span className="truncate">{row.original.recruiterName}</span>
            )
          ) : canManage && row.original.status !== 'dead' ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-text underline-offset-2 hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                setAssign(assignTarget(row.original));
              }}
            >
              <UserRound aria-hidden className="size-4 text-muted" />
              Assign
            </button>
          ) : (
            <span className="text-faint">Unassigned</span>
          ),
      }),
      col.accessor('createdAt', {
        id: 'createdAt',
        header: 'Added',
        meta: { width: 110 },
        cell: (info) => <span title={formatDateTime(info.getValue())}>{formatRelative(info.getValue())}</span>,
      }),
      col.display({
        id: 'open',
        header: () => <span className="sr-only">Open</span>,
        meta: { width: 40, align: 'right' },
        enableHiding: false,
        cell: () => <ChevronRight aria-hidden className="size-4 text-muted" />,
      }),
    ],
    [campaignNames, canManage],
  );

  const page = leads.data;

  return (
    <div className="flex flex-col gap-4" data-testid="leads-tab">
      <section className="grid gap-3 md:grid-cols-3" aria-label="Lead figures">
        <StatCard
          icon={<Users />}
          label="All leads"
          value={s ? s.total : null}
          hint={`Added ${rangeLabel(period.from, period.to)}`}
          onClick={() => update({ status: undefined })}
          active={!search.status}
          testId="leads-total"
        />
        <StatCard
          icon={<Phone />}
          tone="info"
          label="Uncontacted"
          value={s ? s.uncontacted : null}
          hint="Still New — nobody has reached them"
          onClick={() => update({ status: search.status === 'new' ? undefined : 'new' })}
          active={search.status === 'new'}
          testId="leads-uncontacted"
        />
        <StatCard
          icon={<CircleCheck />}
          label="Converted"
          value={s ? s.converted : null}
          hint="Became candidates in the pipeline (not hires)"
          onClick={() => update({ status: search.status === 'converted' ? undefined : 'converted' })}
          active={search.status === 'converted'}
          testId="leads-converted"
        />
      </section>

      <RotationLine />

      {waitingLeads > 0 ? (
        <Alert
          tone="danger"
          title={`${waitingLeads} new ${waitingLeads === 1 ? 'lead needs' : 'leads need'} contact`}
          description="The alert stays until each lead is marked contacted. Opening a lead does not clear it."
          actions={
            search.status === 'new' ? undefined : (
              <Button variant="outline" size="sm" onClick={() => update({ status: 'new' })}>
                Show them
              </Button>
            )
          }
        />
      ) : null}

      {leads.error ? (
        <Alert
          tone="danger"
          title="Leads could not be loaded"
          description={leads.error instanceof Error ? leads.error.message : 'Unknown error'}
        />
      ) : null}

      <DataTable
        columns={columns}
        data={page?.data ?? []}
        rowKey={(l) => l.id}
        caption="Leads"
        loading={leads.isPending}
        serverSide
        total={page?.total ?? 0}
        state={{
          sorting: [{ id: sort, desc: dir === 'desc' }],
          pagination: { page: search.page ?? 1, pageSize: search.pageSize ?? 25 },
          rowSelection: {},
          columnVisibility: hidden,
          globalFilter: '',
        }}
        onStateChange={(next) => {
          if (next.columnVisibility) setHidden(next.columnVisibility);
          if (next.sorting) {
            const first = next.sorting[0];
            update(
              first
                ? { sort: first.id === 'createdAt' ? undefined : first.id, dir: first.desc ? undefined : 'asc' }
                : { sort: undefined, dir: undefined },
            );
          } else if (next.pagination) {
            update({ page: next.pagination.page, pageSize: next.pagination.pageSize });
          }
        }}
        onRowClick={(l) => update({ lead: l.id })}
        toolbar={
          <FilterBar
            search={{
              value: search.q ?? '',
              onChange: (v) => update({ q: v || undefined }),
              placeholder: 'Search name, phone, email, or lead ID…',
            }}
            filters={filters}
            values={{
              status: search.status,
              source: search.source,
              recruiter: search.recruiter,
              campaign: search.campaign,
            }}
            onChange={(k, v) => update({ [k]: v })}
            onClear={() =>
              update({ q: undefined, status: undefined, source: undefined, recruiter: undefined, campaign: undefined })
            }
          />
        }
        rowActions={
          canManage
            ? (lead) => (
                <>
                  {lead.status === 'new' ? (
                    <MenuButton onClick={() => void act('Marked contacted', () => contacted.mutateAsync(lead.id))}>
                      Mark contacted
                    </MenuButton>
                  ) : null}
                  <MenuButton
                    onClick={() =>
                      setFollowUp({
                        kind: lead.hiringCaseId ? 'case' : 'lead',
                        id: lead.hiringCaseId ?? lead.id,
                        name: lead.name,
                        phone: lead.phone,
                        email: lead.email,
                        leadIsNew: lead.status === 'new',
                      })
                    }
                  >
                    Record a follow-up
                  </MenuButton>
                  {lead.status !== 'dead' ? (
                    <MenuButton onClick={() => setAssign(assignTarget(lead))}>
                      {lead.recruiterName ? 'Change recruiter' : 'Assign recruiter'}
                    </MenuButton>
                  ) : null}
                  {lead.status !== 'converted' && lead.status !== 'dead' ? (
                    <MenuButton onClick={() => setPrequalFor(lead)}>
                      {lead.prequalification ? 'Re-evaluate prequalification' : 'Prequalify'}
                    </MenuButton>
                  ) : null}
                  {lead.status === 'prequalified' ? (
                    <MenuButton onClick={() => void convertLead(lead)}>Convert to candidate</MenuButton>
                  ) : null}
                  {lead.status !== 'converted' && lead.status !== 'dead' ? (
                    <MenuButton danger onClick={() => setDisqualifyFor(lead)}>
                      Disqualify
                    </MenuButton>
                  ) : null}
                </>
              )
            : undefined
        }
        empty={
          filtersActive ? (
            <EmptyState
              icon={<PhoneCall />}
              title="No leads match these filters"
              description={`Nothing added ${rangeLabel(period.from, period.to)} matches. Clear the filters or choose a wider period.`}
              action={
                <Button
                  variant="outline"
                  onClick={() =>
                    update({ q: undefined, status: undefined, source: undefined, recruiter: undefined, campaign: undefined })
                  }
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<PhoneCall />}
              title="No leads in this period"
              description="A lead is a name and a phone number. Add one when the first call happens, or choose a wider period."
              action={
                canManage ? (
                  <Button variant="primary" icon={<UserPlus />} onClick={onAddLead}>
                    Add lead
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />

      <LeadDrawer
        lead={selected.data ?? null}
        loading={selected.isPending && Boolean(search.lead)}
        open={Boolean(search.lead)}
        canManage={canManage}
        campaignName={selected.data?.campaignId ? (campaignNames.get(selected.data.campaignId) ?? null) : null}
        onClose={() => update({ lead: undefined })}
        onPrequalify={setPrequalFor}
        onDisqualify={setDisqualifyFor}
        onConvert={(lead) => void convertLead(lead)}
        converting={convert.isPending}
        onContacted={(lead) => void act('Marked contacted', () => contacted.mutateAsync(lead.id))}
        onAssign={(lead) => setAssign(assignTarget(lead))}
        onNote={(lead) => setNoteFor({ leadId: lead.id, name: lead.name })}
        onFollowUp={(lead) =>
          setFollowUp({
            kind: lead.hiringCaseId ? 'case' : 'lead',
            id: lead.hiringCaseId ?? lead.id,
            name: lead.name,
            phone: lead.phone,
            email: lead.email,
            leadIsNew: lead.status === 'new',
          })
        }
      />

      {prequalFor ? <PrequalifyModal lead={prequalFor} onClose={() => setPrequalFor(null)} /> : null}
      {disqualifyFor ? <DisqualifyModal lead={disqualifyFor} onClose={() => setDisqualifyFor(null)} /> : null}
      {assign ? <AssignRecruiterDialog target={assign} onClose={() => setAssign(null)} /> : null}
      {followUp ? <FollowUpDialog target={followUp} onClose={() => setFollowUp(null)} /> : null}
      {noteFor ? <AddNoteDialog target={noteFor} onClose={() => setNoteFor(null)} /> : null}
    </div>
  );
}

/** A row-menu entry: a real menu item, so choosing it closes the menu before any dialog opens. */
function MenuButton({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <MenuItem onSelect={onClick}>
      <span className={danger ? 'text-danger-text' : undefined}>{children}</span>
    </MenuItem>
  );
}

// -------------------------------------------------------------------------------------- drawer

function LeadDrawer({
  lead,
  loading,
  open,
  canManage,
  campaignName,
  converting,
  onClose,
  onPrequalify,
  onDisqualify,
  onConvert,
  onContacted,
  onAssign,
  onFollowUp,
  onNote,
}: {
  lead: Lead | null;
  loading: boolean;
  open: boolean;
  canManage: boolean;
  campaignName: string | null;
  converting: boolean;
  onClose: () => void;
  onPrequalify: (lead: Lead) => void;
  onDisqualify: (lead: Lead) => void;
  onConvert: (lead: Lead) => void;
  onContacted: (lead: Lead) => void;
  onAssign: (lead: Lead) => void;
  onFollowUp: (lead: Lead) => void;
  onNote: (lead: Lead) => void;
}) {
  const p = lead?.prequalification ?? null;
  const r = lead?.prequalResult ?? null;
  const live = lead !== null && lead.status !== 'converted' && lead.status !== 'dead';
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={lead?.name ?? (loading ? 'Loading…' : 'Lead')}
      description={lead ? `${lead.leadNumber} · ${formatPhone(lead.phone)}` : undefined}
      headerExtra={lead ? <LeadStatusBadge lead={lead} /> : null}
      size="md"
      footer={
        lead && canManage ? (
          <div className="flex w-full flex-wrap justify-end gap-2">
            {lead.status === 'converted' && lead.applicantId ? (
              <Button variant="primary" asChild>
                <Link to="/hr/recruiting/$candidateId" params={{ candidateId: lead.applicantId }}>
                  Open candidate
                </Link>
              </Button>
            ) : null}
            {live ? (
              <>
                <Button variant="ghost" onClick={() => onDisqualify(lead)}>
                  Disqualify
                </Button>
                {lead.status === 'new' ? (
                  <Button variant="outline" onClick={() => onContacted(lead)}>
                    Mark contacted
                  </Button>
                ) : null}
                <Button variant={lead.status === 'prequalified' ? 'outline' : 'primary'} onClick={() => onPrequalify(lead)}>
                  {p ? 'Re-evaluate' : 'Prequalify'}
                </Button>
                {lead.status === 'prequalified' ? (
                  <Button variant="primary" loading={converting} onClick={() => onConvert(lead)}>
                    Convert to candidate
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : lead?.status === 'converted' && lead.applicantId ? (
          <Button variant="primary" asChild>
            <Link to="/hr/recruiting/$candidateId" params={{ candidateId: lead.applicantId }}>
              Open candidate
            </Link>
          </Button>
        ) : undefined
      }
    >
      {!lead ? (
        <p className="text-sm text-muted">{loading ? 'Loading…' : 'This lead could not be found.'}</p>
      ) : (
        <div className="flex flex-col gap-5">
          {lead.status === 'converted' ? (
            <Alert tone="info" title="Converted into a candidate">
              {lead.convertedAt ? `On ${formatDateTime(lead.convertedAt)}. ` : null}
              The candidate record now carries this person through the pipeline; converting is not a hire.
            </Alert>
          ) : null}
          {r && !r.qualifies ? (
            <Alert tone="warning" title="Does not prequalify">
              <ul className="list-disc pl-4">
                {r.failed.map((f) => (
                  <li key={f.rule}>
                    <strong>{f.label}</strong> — {f.detail}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs">Rules are set in Admin → Settings → Driver prequalification.</p>
            </Alert>
          ) : null}
          {lead.status === 'contacted' && !p ? (
            <p className="text-sm text-secondary">
              Next: record the prequalification answers. A lead that passes can be converted into a candidate.
            </p>
          ) : null}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Fact label="Source">
              {sourceLabel(lead.source)}
              {campaignName ? <span className="block text-xs text-muted">{campaignName}</span> : null}
            </Fact>
            <Fact label="Recruiter">
              <span className="flex flex-wrap items-center gap-2">
                {lead.recruiterName ?? <span className="text-faint">Unassigned</span>}
                {canManage && lead.status !== 'dead' ? (
                  <button
                    type="button"
                    className="text-xs font-semibold text-primary-text hover:underline"
                    onClick={() => onAssign(lead)}
                  >
                    {lead.recruiterName ? 'Change' : 'Assign'}
                  </button>
                ) : null}
              </span>
            </Fact>
            <Fact label="Email">{lead.email ?? <span className="text-faint">Not given</span>}</Fact>
            <Fact label="State">{lead.state ?? <span className="text-faint">Not given</span>}</Fact>
            <Fact label="CDL class">{lead.cdlClass ?? <span className="text-faint">Not given</span>}</Fact>
            <Fact label="Self-reported experience">
              {lead.yearsExperience !== null ? (
                `${lead.yearsExperience} yr`
              ) : lead.latestApplication?.experience ? (
                lead.latestApplication.experience
              ) : (
                <span className="text-faint">Not given</span>
              )}
            </Fact>
            <Fact label="Added">{formatDateTime(lead.createdAt)}</Fact>
            <Fact label="Contacted">
              {lead.contactedAt ? formatDateTime(lead.contactedAt) : <span className="text-faint">Not yet</span>}
            </Fact>
            {lead.deadAt ? (
              <Fact label="Disqualified">
                {formatDateTime(lead.deadAt)} — {lead.deadReason}
              </Fact>
            ) : null}
          </dl>

          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" icon={<PhoneCall />} onClick={() => onFollowUp(lead)}>
                Record a follow-up
              </Button>
            </div>
          ) : null}

          <LeadNotesHistory leadId={lead.id} canWrite={canManage} onAddNote={() => onNote(lead)} />

          {lead.applicationCount > 0 ? <LeadApplications leadId={lead.id} /> : null}

          {p ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-md font-bold text-ink">Prequalification answers</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <Fact label="23 or older">{p.age23Plus ? 'Yes' : 'No'}</Fact>
                <Fact label="CDL held">{p.cdlHeldYears} yr</Fact>
                <Fact label="OTR experience">{p.otrExperienceYears} yr</Fact>
                <Fact label="Accidents (36 mo)">{p.accidents36mo}</Fact>
                <Fact label="Moving violations (36 mo)">{p.movingViolations36mo}</Fact>
                <Fact label="DUI ever">{p.duiEver ? 'Yes' : 'No'}</Fact>
                <Fact label="Endorsements">
                  {p.endorsements.length ? p.endorsements.join(', ') : <span className="text-faint">None</span>}
                </Fact>
                <Fact label="Pay preference">
                  {p.payTypePreference?.replace(/_/g, ' ') ?? <span className="text-faint">Not given</span>}
                </Fact>
                <Fact label="Home state">{p.homeState}</Fact>
                <Fact label="Earliest start">{p.earliestStartDate ?? <span className="text-faint">Not given</span>}</Fact>
              </dl>
              <p className="text-2xs text-faint">
                Recorded {p.recordedAt ? formatDateTime(p.recordedAt) : ''}
                {p.recordedBy ? ` by ${p.recordedBy}` : ''}
              </p>
            </section>
          ) : null}

          {lead.notes ? <p className="text-sm whitespace-pre-line text-secondary">{lead.notes}</p> : null}
        </div>
      )}
    </Drawer>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------------- add

/** Campaign channels that are also lead sources, so picking a campaign can suggest its source. */
const SOURCE_OF_CHANNEL: Partial<Record<string, string>> = {
  job_board: 'job_board',
  referral: 'referral',
  social: 'social',
  website: 'website',
  agency: 'agency',
};

export function AddLeadModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const employees = useEmployeeDirectory();
  const mutation = useHiringMutation(hiringApi.createLead);
  const campaigns = useCampaigns();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    cdlClass: '',
    state: '',
    yearsExperience: '',
    source: 'job_board',
    campaignId: '',
    recruiterEmployeeId: '',
    notes: '',
  });
  const [sourceTouched, setSourceTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const server = fieldErrors(error);
  const local: Record<string, string | null> = {
    firstName: form.firstName.trim() ? null : 'First name is required',
    lastName: form.lastName.trim() ? null : 'Last name is required',
    phone: form.phone.replace(/\D/g, '').length >= 7 ? null : 'A phone number with at least 7 digits',
    email: !form.email || /^\S+@\S+\.\S+$/.test(form.email) ? null : 'That is not an email address',
    state: !form.state || /^[A-Z]{2}$/.test(form.state) ? null : 'Two letters, e.g. TX',
    yearsExperience:
      form.yearsExperience === '' || (Number(form.yearsExperience) >= 0 && Number(form.yearsExperience) <= 60)
        ? null
        : 'Between 0 and 60',
  };
  const err = (k: string) => (tried ? (local[k] ?? null) : null) ?? server[k] ?? null;
  const valid = Object.values(local).every((v) => v === null);

  const submit = async () => {
    setTried(true);
    setError(null);
    if (!valid) return;
    try {
      const lead = await mutation.mutateAsync({
        ...form,
        email: form.email || null,
        cdlClass: form.cdlClass || null,
        state: form.state || null,
        yearsExperience: form.yearsExperience === '' ? null : Number(form.yearsExperience),
        recruiterEmployeeId: form.recruiterEmployeeId || null,
        campaignId: form.campaignId || null,
        notes: form.notes || null,
      });
      toast({
        title: `${lead.name} added as ${lead.leadNumber}`,
        tone: 'success',
        action: {
          label: 'Open lead',
          onClick: () => void navigate({ to: '/hr/recruiting', search: { tab: 'leads', lead: lead.id } as never }),
        },
      });
      onClose();
    } catch (caught) {
      setError(caught);
    }
  };
  const general = error && Object.keys(server).length === 0 ? (error instanceof ApiError ? error.message : 'Could not add the lead') : null;

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add lead"
      description="A name and a phone number. Everything else can wait for the first call."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={mutation.isPending}>
            Add lead
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="add-lead-form">
        {general ? (
          <Alert tone="danger" title="Not added">
            {general}
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="First name" required error={err('firstName')}>
            <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          </FormField>
          <FormField label="Last name" required error={err('lastName')}>
            <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Phone" required error={err('phone')}>
            <Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </FormField>
          <FormField label="Email" error={err('email')}>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </FormField>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <FormField label="CDL class" error={err('cdlClass')}>
            <Select
              aria-label="CDL class"
              options={[{ value: '', label: 'Not given' }, ...CDL_CLASSES.map((c) => ({ value: c, label: `Class ${c}` }))]}
              value={form.cdlClass}
              onValueChange={(v) => setForm({ ...form, cdlClass: v })}
            />
          </FormField>
          <FormField label="State" error={err('state')}>
            <Input
              maxLength={2}
              value={form.state}
              onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })}
            />
          </FormField>
          <FormField label="Years driving" error={err('yearsExperience')}>
            <Input
              type="number"
              min={0}
              max={60}
              value={form.yearsExperience}
              onChange={(e) => setForm({ ...form, yearsExperience: e.target.value })}
            />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Source" required error={err('source')}>
            <Select
              aria-label="Source"
              options={APPLICANT_SOURCES.map((v) => ({ value: v, label: sourceLabel(v) }))}
              value={form.source}
              onValueChange={(v) => {
                setSourceTouched(true);
                setForm({ ...form, source: v });
              }}
            />
          </FormField>
          <FormField
            label="Campaign"
            error={err('campaignId')}
            description={
              campaigns.isPending
                ? 'Loading…'
                : (campaigns.data ?? []).some((c) => c.active)
                  ? 'Attributes the lead, and its cost, to a campaign.'
                  : 'No active campaigns. Add one on the Campaigns tab.'
            }
          >
            <Select
              aria-label="Campaign"
              options={[
                { value: '', label: 'None' },
                ...(campaigns.data ?? [])
                  .filter((c) => c.active)
                  .map((c) => ({ value: c.id, label: `${c.name} · ${CAMPAIGN_CHANNEL_LABELS[c.channel]}` })),
              ]}
              value={form.campaignId}
              onValueChange={(v) => {
                const channel = (campaigns.data ?? []).find((c) => c.id === v)?.channel;
                const suggested = channel ? SOURCE_OF_CHANNEL[channel] : undefined;
                setForm({ ...form, campaignId: v, source: !sourceTouched && suggested ? suggested : form.source });
              }}
            />
          </FormField>
        </div>
        <FormField
          label="Recruiter"
          error={err('recruiterEmployeeId')}
          description="Defaults to you. Recruiters are employees in HR or Management — add them in Administration › Employees."
        >
          <Select
            aria-label="Recruiter"
            options={[
              { value: '', label: 'Me' },
              ...(employees.data ?? [])
                .filter((e) => e.status !== 'terminated' && isRecruiterPosition(e.position))
                .map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` })),
            ]}
            value={form.recruiterEmployeeId}
            onValueChange={(v) => setForm({ ...form, recruiterEmployeeId: v })}
          />
        </FormField>
        <FormField label="Notes" error={err('notes')}>
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </FormField>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------- prequalify

export function PrequalifyModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const { toast } = useToast();
  const rules = usePrequalificationRules();
  const mutation = useHiringMutation((body: Prequalification) => hiringApi.prequalify(lead.id, body));
  const existing = lead.prequalification;
  const [form, setForm] = useState({
    age23Plus: existing?.age23Plus ?? true,
    cdlHeldYears: String(existing?.cdlHeldYears ?? lead.yearsExperience ?? ''),
    otrExperienceYears: String(existing?.otrExperienceYears ?? lead.yearsExperience ?? ''),
    accidents36mo: String(existing?.accidents36mo ?? 0),
    movingViolations36mo: String(existing?.movingViolations36mo ?? 0),
    duiEver: existing?.duiEver ?? false,
    endorsements: existing?.endorsements ?? [],
    payTypePreference: existing?.payTypePreference ?? '',
    homeState: existing?.homeState ?? lead.state ?? '',
    earliestStartDate: existing?.earliestStartDate ?? '',
  });
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const server = fieldErrors(error);
  const num = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
  const local: Record<string, string | null> = {
    cdlHeldYears: num(form.cdlHeldYears) ? null : 'Enter the years (0 or more)',
    otrExperienceYears: num(form.otrExperienceYears) ? null : 'Enter the years (0 or more)',
    accidents36mo: num(form.accidents36mo) ? null : 'Enter a count (0 or more)',
    movingViolations36mo: num(form.movingViolations36mo) ? null : 'Enter a count (0 or more)',
    homeState: /^[A-Z]{2}$/.test(form.homeState) ? null : 'Two letters, e.g. TX',
  };
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;

  const submit = async () => {
    setTried(true);
    setError(null);
    if (Object.values(local).some((v) => v !== null)) return;
    try {
      const result = await mutation.mutateAsync({
        age23Plus: form.age23Plus,
        cdlHeldYears: Number(form.cdlHeldYears),
        otrExperienceYears: Number(form.otrExperienceYears),
        accidents36mo: Number(form.accidents36mo),
        movingViolations36mo: Number(form.movingViolations36mo),
        duiEver: form.duiEver,
        endorsements: form.endorsements as Prequalification['endorsements'],
        payTypePreference: (form.payTypePreference || null) as Prequalification['payTypePreference'],
        homeState: form.homeState,
        earliestStartDate: form.earliestStartDate || null,
      });
      const r = result.prequalResult;
      toast({
        title: r?.qualifies
          ? `${lead.name} prequalifies`
          : `${lead.name} does not prequalify: ${r?.failed.map((f) => f.label).join(', ')}`,
        tone: r?.qualifies ? 'success' : 'warning',
      });
      onClose();
    } catch (caught) {
      setError(caught);
    }
  };

  const ruleLine = (r: PrequalificationRules) =>
    [
      r.requireAge23 ? '23+' : null,
      r.minCdlYears !== null ? `CDL ≥ ${r.minCdlYears} yr` : null,
      r.minExperienceYears !== null ? `OTR ≥ ${r.minExperienceYears} yr` : null,
      r.maxAccidents36mo !== null ? `accidents ≤ ${r.maxAccidents36mo}` : null,
      r.maxViolations36mo !== null ? `violations ≤ ${r.maxViolations36mo}` : null,
      r.duiDisqualifies ? 'no DUI' : null,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Prequalify ${lead.name}`}
      description="Record the answers as given. The verdict comes from the company's rules."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={mutation.isPending}>
            Evaluate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && Object.keys(server).length === 0 ? (
          <Alert tone="danger" title="Not recorded">
            {error instanceof ApiError ? error.message : 'Could not record the answers'}
          </Alert>
        ) : null}
        <p className="text-xs text-muted">
          {rules.isPending ? 'Loading the rules…' : rules.data ? `Judged against: ${ruleLine(rules.data)} — set in Admin → Settings.` : null}
        </p>
        <Checkbox
          label="23 or older"
          checked={form.age23Plus}
          onCheckedChange={(v) => setForm({ ...form, age23Plus: v === true })}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Years holding a CDL" required error={err('cdlHeldYears')}>
            <Input type="number" min={0} step={0.5} value={form.cdlHeldYears} onChange={(e) => setForm({ ...form, cdlHeldYears: e.target.value })} />
          </FormField>
          <FormField label="Verifiable OTR experience (yr)" required error={err('otrExperienceYears')}>
            <Input
              type="number"
              min={0}
              step={0.5}
              value={form.otrExperienceYears}
              onChange={(e) => setForm({ ...form, otrExperienceYears: e.target.value })}
            />
          </FormField>
          <FormField label="Accidents, last 36 months" required error={err('accidents36mo')}>
            <Input type="number" min={0} value={form.accidents36mo} onChange={(e) => setForm({ ...form, accidents36mo: e.target.value })} />
          </FormField>
          <FormField label="Moving violations, last 36 months" required error={err('movingViolations36mo')}>
            <Input
              type="number"
              min={0}
              value={form.movingViolations36mo}
              onChange={(e) => setForm({ ...form, movingViolations36mo: e.target.value })}
            />
          </FormField>
        </div>
        <Checkbox label="DUI, ever" checked={form.duiEver} onCheckedChange={(v) => setForm({ ...form, duiEver: v === true })} />
        <FormField label="Endorsements held">
          <div className="flex flex-wrap gap-3">
            {CDL_ENDORSEMENTS.map((e) => (
              <Checkbox
                key={e}
                label={`${e} — ${CDL_ENDORSEMENT_LABELS[e]}`}
                checked={form.endorsements.includes(e)}
                onCheckedChange={(v) =>
                  setForm({
                    ...form,
                    endorsements: v === true ? [...form.endorsements, e] : form.endorsements.filter((x) => x !== e),
                  })
                }
              />
            ))}
          </div>
        </FormField>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Pay preference">
            <Select
              aria-label="Pay preference"
              options={[{ value: '', label: 'Not given' }, ...DRIVER_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))]}
              value={form.payTypePreference}
              onValueChange={(v) => setForm({ ...form, payTypePreference: v })}
            />
          </FormField>
          <FormField label="Home state" required error={err('homeState')}>
            <Input maxLength={2} value={form.homeState} onChange={(e) => setForm({ ...form, homeState: e.target.value.toUpperCase() })} />
          </FormField>
          <FormField label="Earliest start">
            <DatePicker value={form.earliestStartDate} onIsoChange={(e) => setForm({ ...form, earliestStartDate: e })} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------- disqualify

export function DisqualifyModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const { toast } = useToast();
  const mutation = useHiringMutation((reason: string) => hiringApi.disqualify(lead.id, reason));
  const suggested =
    lead.prequalResult && !lead.prequalResult.qualifies ? lead.prequalResult.failed.map((f) => f.detail).join('; ') : '';
  const [reason, setReason] = useState(suggested);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Disqualify ${lead.name}`}
      description="The lead is kept, with the reason. It is never deleted."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              void (async () => {
                setTried(true);
                setError(null);
                if (!reason.trim()) return;
                try {
                  await mutation.mutateAsync(reason);
                  toast({ title: `${lead.name} disqualified`, tone: 'success' });
                  onClose();
                } catch (c) {
                  setError(c instanceof ApiError ? c.message : 'Could not disqualify');
                }
              })()
            }
            loading={mutation.isPending}
          >
            Disqualify
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not recorded">
            {error}
          </Alert>
        ) : null}
        <FormField label="Reason" required error={tried && !reason.trim() ? 'Say why the lead is disqualified' : null}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
