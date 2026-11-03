import { Link, useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CLAIM_KINDS, CLAIM_STATUSES } from '@neway/shared';
import {
  Button,
  Combobox,
  DataTable,
  FilterBar,
  Modal,
  PageHeader,
  StatusBadge,
  createColumns,
  getStatus,
  type FilterDefinition,
} from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import { CreateClaimDialog } from './components/CreateClaimDialog';
import { CreateStandaloneClaimDialog } from './components/CreateStandaloneClaimDialog';
import { SafetySummaryStrip, type SafetySummarySegment } from './components/SafetyKit';
import { CLAIM_KIND_LABEL, DASH } from './safety-ui';
import { useSafety, type SafetyAccident } from './useSafety';
import type { Claim } from '@/demo';

const col = createColumns<Claim>();
const PAGE_SIZE = 25;

/**
 * What the strip counts.
 *
 * A claim is *open* until somebody outside this building finishes with it: draft, submitted,
 * acknowledged, under investigation, approved-but-unpaid are all still work. Settled and closed are
 * finished; denied is finished and worth its own number, because a denial is the one outcome that
 * sends money back onto the carrier.
 */
const DONE_STATUSES = ['settled', 'closed'] as const;

type Group = 'all' | 'open' | 'done' | 'denied';

function groupOf(claim: Claim): Exclude<Group, 'all'> {
  if (claim.status === 'denied') return 'denied';
  return (DONE_STATUSES as readonly string[]).includes(claim.status) ? 'done' : 'open';
}

/**
 * The claims register.
 *
 * Until now a claim existed only as a number printed on the accident that produced it: there was
 * no way to answer "what is open with the insurer" without opening accidents one at a time. This
 * is that list — every claim the company holds, newest first, each one opening its own file.
 *
 * These are our own records of a claim, not submissions: nothing here is sent to an insurer, and
 * the page says so rather than letting a row imply a filing that never happened.
 */
export function ClaimsPage() {
  const safetyQuery = useSafety();
  // The bundle drains every page of claims before it resolves, so nothing is lost past a limit.
  const claims = useMemo(
    () => [...(safetyQuery.data?.claims ?? [])].sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1)),
    [safetyQuery.data],
  );

  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [group, setGroup] = useState<Group>('all');
  const [page, setPage] = useState(1);
  /* Opening a claim starts from the accident it belongs to, so it inherits what is already known. */
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<SafetyAccident | null>(null);
  /* A loss with no accident behind it: cargo, glass, theft off a yard. */
  const [standalone, setStandalone] = useState(false);

  const counts = useMemo(() => {
    const tally = { all: claims.length, open: 0, done: 0, denied: 0 };
    for (const claim of claims) tally[groupOf(claim)] += 1;
    return tally;
  }, [claims]);

  /* An accident that already has a claim cannot have a second one; the store refuses it too. */
  const eligible = useMemo(
    () => (safetyQuery.data?.accidents ?? []).filter((row) => !row.accident.claimId),
    [safetyQuery.data],
  );

  const segments: SafetySummarySegment[] = [
    { key: 'all', label: 'Claims', count: counts.all, onSelect: () => setGroup('all') },
    {
      key: 'open',
      label: 'Open',
      count: counts.open,
      tone: counts.open > 0 ? 'warning' : 'default',
      onSelect: () => setGroup(group === 'open' ? 'all' : 'open'),
    },
    {
      key: 'done',
      label: 'Settled or closed',
      count: counts.done,
      tone: 'success',
      onSelect: () => setGroup(group === 'done' ? 'all' : 'done'),
    },
    {
      key: 'denied',
      label: 'Denied',
      count: counts.denied,
      tone: counts.denied > 0 ? 'danger' : 'default',
      onSelect: () => setGroup(group === 'denied' ? 'all' : 'denied'),
    },
  ];

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return claims.filter((claim) => {
      if (group !== 'all' && groupOf(claim) !== group) return false;
      if (status && claim.status !== status) return false;
      if (kind && claim.kind !== kind) return false;
      if (!needle) return true;
      return [
        claim.claimNumber,
        claim.accidentNumber,
        claim.unitNumber,
        claim.driverName,
        claim.insurer,
        claim.insurerClaimNumber,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [claims, search, status, kind, group]);

  const filters: FilterDefinition[] = [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: CLAIM_STATUSES.map((value) => ({ value, label: getStatus(value).label })),
    },
    {
      key: 'kind',
      label: 'Cover',
      type: 'select',
      options: CLAIM_KINDS.map((value) => ({
        value,
        label: CLAIM_KIND_LABEL[value] ?? value,
      })),
    },
  ];

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'claimNumber',
          header: 'Claim #',
          meta: { primary: true, width: 150 },
          cell: ({ row }) => (
            <Link
              to="/safety/claims/$claimId"
              params={{ claimId: row.original.id }}
              className="font-medium text-primary-text hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {row.original.claimNumber}
            </Link>
          ),
        }),
        col.display({
          id: 'accident',
          header: 'Accident',
          meta: { width: 150 },
          cell: ({ row }) =>
            row.original.accidentId && row.original.accidentNumber ? (
              <Link
                to="/safety/accidents/$accidentId"
                params={{ accidentId: row.original.accidentId }}
                className="text-primary-text hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                {row.original.accidentNumber}
              </Link>
            ) : (
              <span className="text-faint">{DASH}</span>
            ),
        }),
        col.display({
          id: 'unit',
          header: 'Unit',
          meta: { width: 90 },
          cell: ({ row }) => row.original.unitNumber ?? <span className="text-faint">{DASH}</span>,
        }),
        col.display({
          id: 'insurer',
          header: 'Insurer',
          meta: { width: 200 },
          cell: ({ row }) => row.original.insurer,
        }),
        col.display({
          id: 'kind',
          header: 'Cover',
          meta: { width: 140 },
          cell: ({ row }) => CLAIM_KIND_LABEL[row.original.kind] ?? row.original.kind,
        }),
        col.display({
          id: 'status',
          header: 'Status',
          meta: { width: 140 },
          cell: ({ row }) => <StatusBadge status={row.original.status} />,
        }),
        col.display({
          id: 'openedAt',
          header: 'Opened',
          meta: { width: 120 },
          cell: ({ row }) => formatIsoDate(row.original.openedAt.slice(0, 10)),
        }),
        col.display({
          id: 'actions',
          header: 'Actions',
          meta: { width: 110 },
          cell: ({ row }) => (
            <Button size="sm" variant="secondary" asChild>
              <Link to="/safety/claims/$claimId" params={{ claimId: row.original.id }}>
                View claim
              </Link>
            </Button>
          ),
        }),
      ]),
    [],
  );

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Claims"
        description="Our own record of each insurance claim and the accident behind it. Nothing here is submitted to an insurer."
      />

      <SafetySummaryStrip
        segments={segments}
        activeKey={group === 'all' ? null : group}
        loading={safetyQuery.isPending}
      />

      <DataTable
        columns={columns}
        data={rows}
        rowKey={(row) => row.id}
        state={{
          sorting: [],
          pagination: { page, pageSize: PAGE_SIZE },
          rowSelection: {},
          columnVisibility: {},
          globalFilter: '',
        }}
        onStateChange={(patch) => {
          if (patch.pagination !== undefined) setPage(patch.pagination.page);
        }}
        loading={safetyQuery.isPending}
        error={safetyQuery.error ?? undefined}
        onRetry={() => void safetyQuery.refetch()}
        caption="Claims"
        emptyTitle="No claims on file"
        emptyDescription="A claim is opened from the accident it belongs to, so it inherits the driver, unit and load already recorded there."
        toolbar={
          <FilterBar
            search={{
              value: search,
              onChange: setSearch,
              placeholder: 'Search claim, accident, unit or insurer',
            }}
            filters={filters}
            values={{ status, kind }}
            onChange={(key, value) => {
              const next = value === undefined || value === null ? '' : String(value);
              if (key === 'status') setStatus(next);
              else setKind(next);
            }}
            onClear={() => {
              setSearch('');
              setStatus('');
              setKind('');
              setGroup('all');
            }}
          >
            <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setPicking(true)}>
              Create claim
            </Button>
          </FilterBar>
        }
      />

      <ChooseAccidentDialog
        open={picking}
        onOpenChange={setPicking}
        accidents={eligible}
        onChoose={(accident) => {
          setPicking(false);
          setChosen(accident);
        }}
        onWithoutAccident={() => {
          setPicking(false);
          setStandalone(true);
        }}
      />

      {standalone ? (
        <CreateStandaloneClaimDialog
          onClose={() => setStandalone(false)}
          onDone={(claim) => {
            setStandalone(false);
            void navigate({ to: '/safety/claims/$claimId', params: { claimId: claim.id } });
          }}
        />
      ) : null}

      {chosen ? (
        <CreateClaimDialog
          open
          onOpenChange={(next) => {
            if (!next) setChosen(null);
          }}
          accident={chosen}
          onDone={(claim) => {
            setChosen(null);
            // Straight to the file that was just opened: the list behind it has already been
            // invalidated, and so has every accident view that shows the claim number.
            void navigate({ to: '/safety/claims/$claimId', params: { claimId: claim.id } });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Which accident the claim is for.
 *
 * A claim is never typed from nothing: it is opened against an accident and inherits the driver,
 * unit, trailer, load and description already recorded there. Accidents that already carry a claim
 * are not offered, because a second one against the same incident is the thing that makes two
 * reserves for one loss.
 */
function ChooseAccidentDialog({
  open,
  onOpenChange,
  accidents,
  onChoose,
  onWithoutAccident,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accidents: SafetyAccident[];
  onChoose: (accident: SafetyAccident) => void;
  onWithoutAccident: () => void;
}) {
  const [id, setId] = useState<string | null>(null);
  const options = accidents.map((row) => ({
    value: row.accident.id,
    label: row.accident.accidentNumber,
    description: `${formatIsoDate(row.accident.at.slice(0, 10))} · Unit ${row.accident.unitNumber} · ${row.accident.driverName}`,
  }));

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setId(null);
        onOpenChange(next);
      }}
      size="sm"
      title="Create claim"
      description="Claims are opened against the accident they belong to, so nothing is retyped."
      footer={
        <>
          {/* Blue, because it is a real way out of this dialog rather than a footnote —
            but not filled: Continue is still the main thing this dialog is for. */}
          <Button variant="link" onClick={onWithoutAccident}>
            No accident
          </Button>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!id}
            onClick={() => {
              const chosen = accidents.find((row) => row.accident.id === id);
              if (chosen) onChoose(chosen);
            }}
          >
            Continue
          </Button>
        </>
      }
    >
      {accidents.length === 0 ? (
        <p className="text-sm text-secondary">
          Every accident on file already has a claim. Report the accident first, or press No
          accident for a loss that never produced one.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <Combobox
            aria-label="Accident"
            options={options}
            value={id}
            onValueChange={setId}
            placeholder="Choose the accident"
            searchPlaceholder="Type an accident number, unit or driver…"
            emptyMessage="No accident matches"
          />
          <p className="text-xs text-muted">
            Only accidents without a claim are listed — one claim per incident. For cargo, glass or
            a theft with no accident report, press No accident.
          </p>
        </div>
      )}
    </Modal>
  );
}
