import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ClipboardCheck, Play, Plus, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  BackButton,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  MenuItem,
  PageHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  TabsContent,
  Timeline,
  cn,
  createColumns,
  useToast,
  type TimelineItem,
} from '@/design-system';
import { startInspection, updateDefect } from '@/demo';
import { formatDateTime, formatIsoDate, formatMiles, formatNumber } from '@/lib/format';
import { AddFindingDialog } from './components/AddFindingDialog';
import { CreateCorrectiveActionDialog } from './components/CreateCorrectiveActionDialog';
import { RecordResultDialog } from './components/RecordResultDialog';
import {
  SafetyBlockerNotice,
  SafetyFactList,
  SafetyMetricStrip,
  SafetyPanel,
  type SafetyMetric,
} from './components/SafetyKit';
import { CorrectiveActionTable } from './components/CorrectiveActionTable';
import {
  DASH,
  INSPECTION_KIND_LABEL,
  INSPECTION_STATE_LABEL,
  INSPECTION_STATE_TONE,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  VIOLATION_CATEGORY_LABEL,
} from './safety-ui';
import { useInvalidateSafety, useSafety, type SafetyDefect } from './useSafety';

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'findings', label: 'Findings' },
  { value: 'violations', label: 'Violations' },
  { value: 'unit', label: 'Unit' },
  { value: 'driver', label: 'Driver' },
  { value: 'actions', label: 'Corrective actions' },
  { value: 'documents', label: 'Documents' },
  { value: 'activity', label: 'Activity' },
];

export function InspectionDetailRoute() {
  const { inspectionId } = useParams({ from: '/safety/inspections/$inspectionId' });
  return <InspectionDetailPage inspectionId={inspectionId} />;
}

const defectCol = createColumns<SafetyDefect>();

/**
 * The inspection workspace — a full page, not a modal.
 *
 * The header says what the inspection *found*; the notice under it says what is still outstanding
 * because of it. Those are different questions, and a screen that answers only the first is how a
 * critical defect survives a week.
 */
export function InspectionDetailPage({ inspectionId }: { inspectionId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();
  const safetyQuery = useSafety();
  const [tab, setTab] = useState('overview');
  const [recording, setRecording] = useState(false);
  const [addingFinding, setAddingFinding] = useState(false);
  const [raising, setRaising] = useState<SafetyDefect | null>(null);

  const row =
    safetyQuery.data?.byInspectionId.get(inspectionId) ??
    safetyQuery.data?.inspections.find((r) => r.inspection.inspectionNumber === inspectionId);

  const begin = useMutation({
    mutationFn: () => startInspection({ id: row?.inspection.id ?? '' }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That could not be started', description: result.blocked });
        return;
      }
      await invalidate();
      toast({ tone: 'success', title: 'Inspection started' });
    },
  });

  const resolveDefect = useMutation({
    mutationFn: (defectId: string) => updateDefect({ id: defectId, status: 'resolved' }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({
        tone: 'success',
        title: `${result.defect?.defectNumber} resolved`,
        description: result.defect?.outOfService
          ? 'If this was the last out-of-service defect, the unit is back in dispatch.'
          : undefined,
      });
    },
  });

  const defectColumns = useMemo(
    () =>
      defectCol.columns([
        defectCol.display({
          id: 'defectNumber',
          header: 'Finding',
          meta: { primary: true, width: 110 },
          cell: ({ row: r }) => r.original.defect.defectNumber,
        }),
        defectCol.display({
          id: 'component',
          header: 'Component',
          meta: { width: 140 },
          cell: ({ row: r }) => r.original.defect.component,
        }),
        defectCol.display({
          id: 'description',
          header: 'Description',
          cell: ({ row: r }) => r.original.defect.description,
        }),
        defectCol.display({
          id: 'regulation',
          header: 'Regulation',
          meta: { width: 120 },
          cell: ({ row: r }) =>
            r.original.defect.regulation ? (
              <span className="font-mono text-xs">{r.original.defect.regulation}</span>
            ) : (
              <span className="text-faint">{DASH}</span>
            ),
        }),
        defectCol.display({
          id: 'severity',
          header: 'Severity',
          meta: { width: 100 },
          cell: ({ row: r }) => (
            <Badge tone={SEVERITY_TONE[r.original.defect.severity]}>
              {SEVERITY_LABEL[r.original.defect.severity]}
            </Badge>
          ),
        }),
        defectCol.display({
          id: 'oos',
          header: 'Out of service',
          meta: { width: 120 },
          cell: ({ row: r }) =>
            r.original.defect.outOfService ? (
              <Badge tone="danger" title={r.original.urgency.summary}>
                Yes
              </Badge>
            ) : (
              <span className="text-faint">No</span>
            ),
        }),
        defectCol.display({
          id: 'due',
          header: 'Repair due',
          meta: { width: 120 },
          cell: ({ row: r }) =>
            r.original.defect.dueOn ? (
              <span className={cn(r.original.urgency.overdue && 'font-medium text-danger-text')}>
                {formatIsoDate(r.original.defect.dueOn)}
              </span>
            ) : (
              <span className="text-faint">{DASH}</span>
            ),
        }),
        defectCol.display({
          id: 'status',
          header: 'Status',
          meta: { width: 110 },
          cell: ({ row: r }) => <StatusBadge status={r.original.defect.status} />,
        }),
      ]),
    [],
  );

  if (safetyQuery.isPending) {
    return (
      <div className="flex flex-col gap-(--section-gap)">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (safetyQuery.error) {
    return <ErrorState error={safetyQuery.error} onRetry={() => void safetyQuery.refetch()} />;
  }

  if (!row) {
    return (
      <EmptyState
        title="That inspection is not on file"
        description="It may have been removed, or the link may be out of date."
        action={
          <Button onClick={() => void navigate({ to: '/safety/inspections' })}>
            Back to inspections
          </Button>
        }
      />
    );
  }

  const { inspection, state, defects } = row;
  const openDefects = defects.filter((d) => d.defect.status !== 'resolved');
  const blocking = openDefects.filter((d) => d.urgency.blocksDispatch);
  const overdueRepairs = openDefects.filter((d) => d.urgency.overdue);

  const metrics: SafetyMetric[] = [
    { label: 'Type', value: INSPECTION_KIND_LABEL[inspection.kind] },
    {
      label: 'Result',
      value: inspection.result ? (inspection.result === 'pass' ? 'Pass' : 'Fail') : null,
      tone: inspection.result === 'fail' ? 'danger' : 'success',
      title: 'This inspection has not been performed yet.',
    },
    {
      label: 'Findings',
      value: defects.length === 0 ? null : formatNumber(defects.length),
      hint: defects.length > 0 ? `${openDefects.length} still open` : undefined,
      tone: openDefects.length > 0 ? 'warning' : 'default',
      title: 'No findings were recorded against this inspection.',
    },
    {
      label: 'Violations',
      value: row.violations.length === 0 ? null : formatNumber(row.violations.length),
      title: 'This inspection produced no violations.',
    },
    {
      label: 'Odometer',
      value: inspection.odometer === null ? null : formatMiles(inspection.odometer),
      title: 'No odometer was recorded.',
    },
    {
      label: 'Level',
      value: inspection.level === null ? null : `Level ${inspection.level}`,
      title: 'Levels apply to roadside inspections only.',
    },
  ];

  const timeline: TimelineItem[] = [
    {
      id: 'booked',
      at: inspection.at,
      title: `${INSPECTION_KIND_LABEL[inspection.kind]} inspection ${inspection.completedAt ? 'performed' : 'booked'}`,
      description: inspection.location
        ? `${inspection.location.city}, ${inspection.location.state}`
        : undefined,
      tone: 'info',
    },
  ];
  if (inspection.startedAt) {
    timeline.push({
      id: 'started',
      at: inspection.startedAt,
      title: 'Inspection started',
      description: inspection.inspector,
      tone: 'info',
    });
  }
  if (inspection.completedAt) {
    timeline.push({
      id: 'completed',
      at: inspection.completedAt,
      title: `Recorded as ${inspection.result}`,
      description: inspection.outOfService ? 'Unit placed out of service' : undefined,
      tone: inspection.result === 'pass' ? 'success' : 'danger',
    });
  }
  for (const defect of defects) {
    timeline.push({
      id: `d-${defect.defect.id}`,
      at: defect.defect.reportedAt,
      title: `${defect.defect.defectNumber} — ${defect.defect.component}`,
      description: defect.defect.description,
      tone: defect.defect.severity === 'critical' ? 'danger' : 'warning',
    });
    if (defect.defect.resolvedAt) {
      timeline.push({
        id: `dr-${defect.defect.id}`,
        at: defect.defect.resolvedAt,
        title: `${defect.defect.defectNumber} resolved`,
        tone: 'success',
      });
    }
  }
  timeline.sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at)));

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/safety/inspections" />}
        title={inspection.inspectionNumber}
        description={`${INSPECTION_KIND_LABEL[inspection.kind]} · Unit ${inspection.unitNumber} · ${inspection.inspector}${
          inspection.inspectorAgency ? ` (${inspection.inspectorAgency})` : ''
        }`}
        actions={
          <>
            {state.state === 'scheduled' || state.state === 'overdue' ? (
              <Button variant="secondary" icon={<Play />} onClick={() => begin.mutate()}>
                Start inspection
              </Button>
            ) : null}
            {state.state === 'in_progress' ? (
              <Button
                variant="primary"
                icon={<ClipboardCheck />}
                onClick={() => setRecording(true)}
              >
                Record result
              </Button>
            ) : null}
            {inspection.completedAt ? (
              <Button variant="secondary" icon={<Plus />} onClick={() => setAddingFinding(true)}>
                Add finding
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={INSPECTION_STATE_TONE[state.state]}>
          {INSPECTION_STATE_LABEL[state.state]}
        </Badge>
        {inspection.outOfService ? <Badge tone="danger">Out of service</Badge> : null}
        <span className="text-sm text-muted">{state.reasons.join('. ')}</span>
      </div>

      <SafetyBlockerNotice
        title="This inspection is not finished"
        tone={blocking.length > 0 ? 'danger' : 'warning'}
        reasons={[
          ...blocking.map(
            (d) => `${d.defect.defectNumber} (${d.defect.component}) has the unit out of service.`,
          ),
          ...overdueRepairs
            .filter((d) => !d.urgency.blocksDispatch)
            .map((d) => `${d.defect.defectNumber} repair was due ${d.defect.dueOn}.`),
          ...(openDefects.length > blocking.length + overdueRepairs.length
            ? [
                `${openDefects.length - blocking.length - overdueRepairs.length} other finding(s) still open.`,
              ]
            : []),
        ]}
      />

      <SafetyMetricStrip metrics={metrics} />

      <Tabs items={TABS} value={tab} onValueChange={setTab} aria-label="Inspection">
        <TabsContent value="overview" className="pt-4">
          <div className="grid gap-4 xl:grid-cols-3">
            <SafetyPanel title="Inspection">
              <SafetyFactList
                facts={[
                  { label: 'Inspection #', value: inspection.inspectionNumber },
                  { label: 'Date', value: formatDateTime(inspection.at) },
                  { label: 'Type', value: INSPECTION_KIND_LABEL[inspection.kind] },
                  { label: 'Inspector', value: inspection.inspector },
                  {
                    label: 'Agency',
                    value: inspection.inspectorAgency ?? <span className="text-faint">{DASH}</span>,
                  },
                  {
                    label: 'Report #',
                    value: inspection.reportNumber ?? <span className="text-faint">{DASH}</span>,
                  },
                  {
                    label: 'Location',
                    value: inspection.location
                      ? `${inspection.location.city}, ${inspection.location.state}`
                      : DASH,
                  },
                ]}
              />
            </SafetyPanel>

            <SafetyPanel title="Compliance summary">
              <SafetyFactList
                facts={[
                  { label: 'Findings raised', value: formatNumber(defects.length) },
                  {
                    label: 'Still open',
                    value:
                      openDefects.length > 0 ? (
                        <span className="font-medium text-warning-text">
                          {formatNumber(openDefects.length)}
                        </span>
                      ) : (
                        '0'
                      ),
                  },
                  {
                    label: 'Critical',
                    value: formatNumber(
                      defects.filter((d) => d.defect.severity === 'critical').length,
                    ),
                  },
                  {
                    label: 'Out of service',
                    value:
                      blocking.length > 0 ? (
                        <span className="font-medium text-danger-text">
                          {formatNumber(blocking.length)}
                        </span>
                      ) : (
                        '0'
                      ),
                  },
                  { label: 'Violations written', value: formatNumber(row.violations.length) },
                  {
                    label: 'Corrective actions',
                    value: formatNumber(
                      defects.reduce((sum, d) => sum + d.correctiveActions.length, 0) +
                        row.correctiveActions.length,
                    ),
                  },
                ]}
              />
            </SafetyPanel>

            <SafetyPanel title="Subject">
              <SafetyFactList
                facts={[
                  {
                    label: 'Unit',
                    value: (
                      <Link
                        to="/fleet/trucks/$truckId"
                        params={{ truckId: inspection.assetId }}
                        className="text-primary-text hover:underline"
                      >
                        {inspection.unitNumber}
                      </Link>
                    ),
                  },
                  {
                    label: 'Trailer',
                    value: inspection.trailerId ? (
                      <Link
                        to="/fleet/trailers/$trailerId"
                        params={{ trailerId: inspection.trailerId }}
                        className="text-primary-text hover:underline"
                      >
                        {inspection.trailerUnit}
                      </Link>
                    ) : (
                      <span className="text-faint">{DASH}</span>
                    ),
                  },
                  {
                    label: 'Driver',
                    value: inspection.driverId ? (
                      <Link
                        to="/drivers"
                        search={{ driver: inspection.driverId }}
                        className="text-primary-text hover:underline"
                      >
                        {inspection.driverName}
                      </Link>
                    ) : (
                      <span className="text-faint">{DASH}</span>
                    ),
                  },
                  {
                    label: 'Odometer',
                    value:
                      inspection.odometer === null ? (
                        <span className="text-faint">{DASH}</span>
                      ) : (
                        formatMiles(inspection.odometer)
                      ),
                  },
                ]}
              />
            </SafetyPanel>
          </div>
        </TabsContent>

        <TabsContent value="findings" className="pt-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-md font-bold text-ink">
                Findings ({formatNumber(defects.length)})
              </h3>
              <Button
                size="sm"
                variant="secondary"
                icon={<Plus />}
                onClick={() => setAddingFinding(true)}
              >
                Add finding
              </Button>
            </div>
            <DataTable
              columns={defectColumns}
              data={defects}
              rowKey={(d) => d.defect.id}
              caption="Findings"
              showColumnChooser={false}
              emptyTitle="No findings recorded"
              emptyDescription="An inspection with no findings is a clean inspection. Add one if something was found."
              rowActions={(d) =>
                d.defect.status === 'resolved' ? null : (
                  <>
                    <MenuItem
                      icon={<ClipboardCheck />}
                      onSelect={() => resolveDefect.mutate(d.defect.id)}
                    >
                      Mark resolved
                    </MenuItem>
                    {d.correctiveActions.every((a) => !a.state.outstanding) ? (
                      <MenuItem icon={<ShieldAlert />} onSelect={() => setRaising(d)}>
                        Create corrective action
                      </MenuItem>
                    ) : null}
                  </>
                )
              }
            />
          </div>
        </TabsContent>

        <TabsContent value="violations" className="pt-4">
          {row.violations.length === 0 ? (
            <EmptyState
              title="No violations came from this inspection"
              description="A roadside inspection that finds a regulatory breach writes a violation against the driver and the unit. This one wrote none."
            />
          ) : (
            <Card className="p-4">
              <ul className="divide-y divide-line-soft">
                {row.violations.map((violation) => (
                  <li key={violation.id} className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <Link
                        to="/safety/violations/$violationId"
                        params={{ violationId: violation.id }}
                        className="text-sm font-medium text-primary-text hover:underline"
                      >
                        {violation.violationNumber}
                      </Link>
                      <p className="mt-0.5 text-sm text-secondary">{violation.description}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        <span className="font-mono">{violation.code}</span> ·{' '}
                        {VIOLATION_CATEGORY_LABEL[violation.category]}
                      </p>
                    </div>
                    <Badge tone={SEVERITY_TONE[violation.severity]}>
                      {SEVERITY_LABEL[violation.severity]}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="unit" className="pt-4">
          <Card className="p-4">
            <p className="text-sm text-secondary">
              Everything about unit {inspection.unitNumber} — its service schedule, its open work
              orders, its economics and its own inspection history — lives on the unit, which owns
              those facts.{' '}
              <Link
                to="/fleet/trucks/$truckId"
                params={{ truckId: inspection.assetId }}
                className="font-medium text-primary-text hover:underline"
              >
                Open unit {inspection.unitNumber}
              </Link>
              .
            </p>
          </Card>
        </TabsContent>

        <TabsContent value="driver" className="pt-4">
          {inspection.driverId ? (
            <Card className="p-4">
              <p className="text-sm text-secondary">
                {inspection.driverName}&rsquo;s qualification file, hours and violation history live
                on the driver record.{' '}
                <Link
                  to="/drivers"
                  search={{ driver: inspection.driverId }}
                  className="font-medium text-primary-text hover:underline"
                >
                  Open the driver
                </Link>
                .
              </p>
            </Card>
          ) : (
            <EmptyState
              title="No driver on this inspection"
              description="An annual or shop inspection is performed on the unit, not on a driver."
            />
          )}
        </TabsContent>

        <TabsContent value="actions" className="pt-4">
          <CorrectiveActionTable
            actions={[...row.correctiveActions, ...defects.flatMap((d) => d.correctiveActions)]}
            emptyDescription="Raise one from a finding to track the repair through to completion."
          />
        </TabsContent>

        <TabsContent value="documents" className="pt-4">
          <EmptyState
            title="No documents on this inspection"
            description="Inspection reports, photographs and repair paperwork attach here once the document store accepts an inspection as an owner. Nothing is stored against one today."
          />
        </TabsContent>

        <TabsContent value="activity" className="pt-4">
          <Card className="p-4">
            <Timeline items={timeline} />
          </Card>
        </TabsContent>
      </Tabs>

      {recording ? (
        <RecordResultDialog
          open
          onOpenChange={setRecording}
          inspection={row}
          onDone={() => setRecording(false)}
        />
      ) : null}

      {addingFinding ? (
        <AddFindingDialog
          open
          onOpenChange={setAddingFinding}
          inspection={row}
          onDone={() => setAddingFinding(false)}
        />
      ) : null}

      {raising ? (
        <CreateCorrectiveActionDialog
          open
          onOpenChange={(next) => {
            if (!next) setRaising(null);
          }}
          subjectType="defect"
          subjectId={raising.defect.id}
          subjectLabel={raising.defect.defectNumber}
          severity={raising.defect.severity}
          defaultTitle={`Repair: ${raising.defect.component.toLowerCase()}`}
          defaultDescription={raising.defect.description}
          onDone={() => setRaising(null)}
        />
      ) : null}
    </div>
  );
}
