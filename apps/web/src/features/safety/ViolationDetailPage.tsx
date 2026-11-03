import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { CheckCircle2, Gavel, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { summarizeViolations } from '@neway/shared';
import {
  BackButton,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  Timeline,
  useToast,
  type TimelineItem,
} from '@/design-system';
import { updateViolation } from '@/demo';
import { formatDateTime, formatIsoDate, formatMoney, formatNumber } from '@/lib/format';
import { CorrectiveActionTable } from './components/CorrectiveActionTable';
import { CreateCorrectiveActionDialog } from './components/CreateCorrectiveActionDialog';
import {
  SafetyFactList,
  SafetyIndicatorRow,
  SafetyMetricStrip,
  SafetyPanel,
  type SafetyMetric,
} from './components/SafetyKit';
import {
  DASH,
  INSPECTION_KIND_LABEL,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  VIOLATION_CATEGORY_LABEL,
  VIOLATION_STATE_LABEL,
  VIOLATION_STATE_TONE,
} from './safety-ui';
import { useInvalidateSafety, useSafety } from './useSafety';

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'driver', label: 'Driver' },
  { value: 'unit', label: 'Unit' },
  { value: 'inspection', label: 'Inspection' },
  { value: 'citation', label: 'Citation' },
  { value: 'actions', label: 'Corrective action' },
  { value: 'documents', label: 'Documents' },
  { value: 'activity', label: 'Activity' },
];

export function ViolationDetailRoute() {
  const { violationId } = useParams({ from: '/safety/violations/$violationId' });
  return <ViolationDetailPage violationId={violationId} />;
}

/**
 * The violation workspace.
 *
 * The Driver tab is the one that earns its place: it shows this driver's *other* violations,
 * computed by the same engine the list page uses, so a pattern is visible on the record where the
 * pattern matters. What it does not show is a risk score — the FMCSA weights and peer percentiles
 * that would make one meaningful are not data this system holds, and a number invented to fill the
 * space would end up in a conversation with a driver about their job.
 */
export function ViolationDetailPage({ violationId }: { violationId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();
  const safetyQuery = useSafety();
  const [tab, setTab] = useState('overview');
  const [raising, setRaising] = useState(false);

  const row =
    safetyQuery.data?.byViolationId.get(violationId) ??
    safetyQuery.data?.violations.find((r) => r.violation.violationNumber === violationId);

  const change = useMutation({
    mutationFn: (patch: Parameters<typeof updateViolation>[0]) => updateViolation(patch),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({ tone: 'success', title: `${result.violation?.violationNumber} updated` });
    },
  });

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
        title="That violation is not on file"
        description="It may have been removed, or the link may be out of date."
        action={
          <Button onClick={() => void navigate({ to: '/safety/violations' })}>
            Back to violations
          </Button>
        }
      />
    );
  }

  const { violation, state, inspection } = row;
  const bundle = safetyQuery.data;
  const today = bundle?.today ?? '';

  const driverViolations = violation.driverId
    ? (bundle?.violationsByDriverId.get(violation.driverId) ?? [])
    : [];
  const unitViolations = violation.truckId
    ? (bundle?.violationsByTruckId.get(violation.truckId) ?? [])
    : [];

  const driverSummary =
    driverViolations.length > 0
      ? summarizeViolations(
          driverViolations.map((r) => ({
            id: r.violation.id,
            category: r.violation.category,
            severity: r.violation.severity,
            onDate: r.violation.onDate,
            resolvedAt: r.violation.resolvedAt,
            contested: r.violation.contested,
            points: r.violation.points,
          })),
          today,
        )
      : null;

  const metrics: SafetyMetric[] = [
    { label: 'BASIC', value: VIOLATION_CATEGORY_LABEL[violation.category] },
    { label: 'Severity', value: SEVERITY_LABEL[violation.severity] },
    {
      label: 'FMCSA weight',
      value: violation.points === null ? null : String(violation.points),
      title:
        'An internally recorded finding never went on a roadside report, so it carries no FMCSA weight.',
    },
    {
      label: 'Fine',
      value: violation.fineAmount === null ? null : formatMoney(violation.fineAmount),
      title: 'No citation was issued with this violation.',
    },
    {
      label: 'Corrective action',
      value:
        row.correctiveActions.length === 0
          ? null
          : `${row.correctiveActions.filter((a) => a.state.outstanding).length} open`,
      tone: row.correctiveActions.some((a) => a.state.state === 'overdue') ? 'danger' : 'default',
      title: 'None has been raised against this violation.',
    },
  ];

  const timeline: TimelineItem[] = [
    {
      id: 'issued',
      at: `${violation.onDate}T12:00:00Z`,
      title: `${violation.code} recorded`,
      description: violation.description,
      tone: violation.severity === 'critical' ? 'danger' : 'warning',
    },
  ];
  for (const action of row.correctiveActions) {
    timeline.push({
      id: `cap-${action.action.id}`,
      at: action.action.createdAt,
      title: `${action.action.actionNumber} raised`,
      description: action.action.title,
      tone: 'info',
    });
    if (action.action.completedAt) {
      timeline.push({
        id: `capc-${action.action.id}`,
        at: action.action.completedAt,
        title: `${action.action.actionNumber} completed`,
        description: action.action.resolution ?? undefined,
        tone: 'success',
      });
    }
  }
  if (violation.resolvedAt) {
    timeline.push({
      id: 'resolved',
      at: violation.resolvedAt,
      title: 'Violation resolved',
      description: violation.disposition ?? undefined,
      tone: 'success',
    });
  }
  timeline.sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at)));

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/safety/violations" />}
        title={violation.violationNumber}
        description={`${violation.code} · ${violation.description}`}
        actions={
          state.state === 'resolved' ? null : (
            <>
              {row.correctiveActions.every((a) => !a.state.outstanding) ? (
                <Button variant="secondary" icon={<ShieldAlert />} onClick={() => setRaising(true)}>
                  Create corrective action
                </Button>
              ) : null}
              <Button
                variant="secondary"
                icon={<Gavel />}
                onClick={() =>
                  change.mutate({
                    id: violation.id,
                    contested: !violation.contested,
                    reason: violation.contested
                      ? 'Challenge withdrawn'
                      : 'Contested by the carrier',
                  })
                }
              >
                {violation.contested ? 'Withdraw challenge' : 'Contest'}
              </Button>
              <Button
                variant="primary"
                icon={<CheckCircle2 />}
                onClick={() =>
                  change.mutate({ id: violation.id, resolved: true, reason: 'Marked resolved' })
                }
              >
                Mark resolved
              </Button>
            </>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={VIOLATION_STATE_TONE[state.state]}>{VIOLATION_STATE_LABEL[state.state]}</Badge>
        <Badge tone={SEVERITY_TONE[violation.severity]}>{SEVERITY_LABEL[violation.severity]}</Badge>
        <Badge tone="neutral">
          {violation.source === 'roadside' ? 'Roadside' : 'Internal review'}
        </Badge>
        <span className="text-sm text-muted">{state.reasons.join('. ')}</span>
      </div>

      <SafetyMetricStrip metrics={metrics} />

      <Tabs items={TABS} value={tab} onValueChange={setTab} aria-label="Violation">
        <TabsContent value="overview" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SafetyPanel title="Violation">
              <SafetyFactList
                facts={[
                  { label: 'Violation #', value: violation.violationNumber },
                  { label: 'Date', value: formatIsoDate(violation.onDate) },
                  {
                    label: 'Code',
                    value: <span className="font-mono text-xs">{violation.code}</span>,
                  },
                  { label: 'BASIC', value: VIOLATION_CATEGORY_LABEL[violation.category] },
                  { label: 'Severity', value: SEVERITY_LABEL[violation.severity] },
                  {
                    label: 'Source',
                    value:
                      violation.source === 'roadside' ? 'Roadside inspection' : 'Internal review',
                  },
                  {
                    label: 'Location',
                    value: violation.location
                      ? `${violation.location.city}, ${violation.location.state}`
                      : DASH,
                  },
                  {
                    label: 'Contested',
                    value: violation.contested ? 'Yes' : 'No',
                    title: violation.contested
                      ? 'A contested violation still counts against the carrier until the challenge succeeds.'
                      : undefined,
                  },
                ]}
              />
            </SafetyPanel>
            <SafetyPanel title="Subject">
              <SafetyFactList
                facts={[
                  {
                    label: 'Driver',
                    value: violation.driverId ? (
                      <Link
                        to="/drivers"
                        search={{ driver: violation.driverId }}
                        className="text-primary-text hover:underline"
                      >
                        {violation.driverName}
                      </Link>
                    ) : (
                      <span className="text-faint">{DASH}</span>
                    ),
                  },
                  {
                    label: 'Unit',
                    value: violation.truckId ? (
                      <Link
                        to="/fleet/trucks/$truckId"
                        params={{ truckId: violation.truckId }}
                        className="text-primary-text hover:underline"
                      >
                        {violation.unitNumber}
                      </Link>
                    ) : (
                      <span className="text-faint">{DASH}</span>
                    ),
                  },
                  {
                    label: 'Inspection',
                    value: inspection ? (
                      <Link
                        to="/safety/inspections/$inspectionId"
                        params={{ inspectionId: inspection.id }}
                        className="text-primary-text hover:underline"
                      >
                        {inspection.inspectionNumber}
                      </Link>
                    ) : (
                      <span className="text-faint">Not from an inspection</span>
                    ),
                  },
                  {
                    label: 'Resolved',
                    value: violation.resolvedAt ? (
                      formatDateTime(violation.resolvedAt)
                    ) : (
                      <span className="text-faint">Not yet</span>
                    ),
                  },
                ]}
              />
            </SafetyPanel>
          </div>
        </TabsContent>

        <TabsContent value="driver" className="pt-4">
          {violation.driverId ? (
            <div className="flex flex-col gap-4">
              <SafetyPanel
                title={`${violation.driverName} — violation history`}
                action={
                  <Link
                    to="/drivers"
                    search={{ driver: violation.driverId }}
                    className="text-sm font-medium text-primary-text hover:underline"
                  >
                    Open driver
                  </Link>
                }
              >
                {driverSummary ? (
                  <>
                    <SafetyFactList
                      facts={[
                        { label: 'Total violations', value: formatNumber(driverSummary.total) },
                        { label: 'Open', value: formatNumber(driverSummary.open) },
                        {
                          label: 'In the last 30 days',
                          value: formatNumber(driverSummary.recent),
                        },
                        {
                          label: 'Open FMCSA weight',
                          value:
                            driverSummary.openPoints === null ? (
                              <span className="text-faint">Not weighted</span>
                            ) : (
                              String(driverSummary.openPoints)
                            ),
                        },
                      ]}
                    />
                    <SafetyIndicatorRow
                      indicators={driverSummary.indicators}
                      onSelect={(ids) =>
                        void navigate({
                          to: '/safety/violations',
                          search: { ids: ids.join(',') },
                        })
                      }
                    />
                    <p className="text-xs text-faint">
                      Counts and repetition from these records. A driver risk score needs{' '}
                      {driverSummary.unavailable
                        .map((u) => u.requires.toLowerCase())
                        .join(', and ')}{' '}
                      — it is not estimated here.
                    </p>
                  </>
                ) : null}
              </SafetyPanel>

              <Card className="p-4">
                <h3 className="text-md font-bold text-ink">Every violation on this driver</h3>
                <ul className="mt-2 divide-y divide-line-soft">
                  {driverViolations.map((r) => (
                    <li
                      key={r.violation.id}
                      className="flex items-center justify-between gap-4 py-2"
                    >
                      <div className="min-w-0">
                        <Link
                          to="/safety/violations/$violationId"
                          params={{ violationId: r.violation.id }}
                          className="text-sm font-medium text-primary-text hover:underline"
                        >
                          {r.violation.violationNumber}
                        </Link>
                        <p className="truncate text-xs text-muted">
                          {formatIsoDate(r.violation.onDate)} ·{' '}
                          {VIOLATION_CATEGORY_LABEL[r.violation.category]} · {r.violation.code}
                        </p>
                      </div>
                      <Badge tone={VIOLATION_STATE_TONE[r.state.state]}>
                        {VIOLATION_STATE_LABEL[r.state.state]}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ) : (
            <EmptyState
              title="No driver on this violation"
              description="A vehicle maintenance violation found on a parked unit is written against the unit alone."
            />
          )}
        </TabsContent>

        <TabsContent value="unit" className="pt-4">
          {violation.truckId ? (
            <SafetyPanel
              title={`Unit ${violation.unitNumber} — violation history`}
              action={
                <Link
                  to="/fleet/trucks/$truckId"
                  params={{ truckId: violation.truckId }}
                  className="text-sm font-medium text-primary-text hover:underline"
                >
                  Open unit
                </Link>
              }
            >
              <SafetyFactList
                facts={[
                  { label: 'Violations on this unit', value: formatNumber(unitViolations.length) },
                  {
                    label: 'Still open',
                    value: formatNumber(
                      unitViolations.filter((r) => r.state.state !== 'resolved').length,
                    ),
                  },
                  {
                    label: 'Vehicle maintenance BASIC',
                    value: formatNumber(
                      unitViolations.filter((r) => r.violation.category === 'vehicle_maintenance')
                        .length,
                    ),
                  },
                ]}
              />
              <p className="text-xs text-faint">
                The unit&rsquo;s service schedule, open work orders and inspection history live on
                the unit, which owns them.
              </p>
            </SafetyPanel>
          ) : (
            <EmptyState
              title="No unit on this violation"
              description="A driver-fitness violation is written against the driver alone."
            />
          )}
        </TabsContent>

        <TabsContent value="inspection" className="pt-4">
          {inspection ? (
            <SafetyPanel
              title="The inspection that produced this"
              action={
                <Link
                  to="/safety/inspections/$inspectionId"
                  params={{ inspectionId: inspection.id }}
                  className="text-sm font-medium text-primary-text hover:underline"
                >
                  Open inspection
                </Link>
              }
            >
              <SafetyFactList
                facts={[
                  { label: 'Inspection #', value: inspection.inspectionNumber },
                  { label: 'Type', value: INSPECTION_KIND_LABEL[inspection.kind] },
                  { label: 'Date', value: formatDateTime(inspection.at) },
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
                    label: 'Level',
                    value: inspection.level ? `Level ${inspection.level}` : DASH,
                  },
                ]}
              />
            </SafetyPanel>
          ) : (
            <EmptyState
              title="Not from an inspection"
              description="This was recorded during an internal safety review rather than at the roadside, which is why it carries no FMCSA weight."
            />
          )}
        </TabsContent>

        <TabsContent value="citation" className="pt-4">
          {violation.citationNumber ? (
            <SafetyPanel title="Citation">
              <SafetyFactList
                facts={[
                  { label: 'Citation #', value: violation.citationNumber },
                  {
                    label: 'Issuing agency',
                    value: violation.issuingAgency ?? <span className="text-faint">{DASH}</span>,
                  },
                  {
                    label: 'State',
                    value: violation.location?.state ?? <span className="text-faint">{DASH}</span>,
                  },
                  {
                    label: 'Fine',
                    value:
                      violation.fineAmount === null ? (
                        <span className="text-faint">{DASH}</span>
                      ) : (
                        formatMoney(violation.fineAmount)
                      ),
                  },
                  {
                    label: 'Court date',
                    value: violation.courtDate ? (
                      formatIsoDate(violation.courtDate)
                    ) : (
                      <span className="text-faint">None set</span>
                    ),
                  },
                  {
                    label: 'Disposition',
                    value: violation.disposition ?? <span className="text-faint">Pending</span>,
                  },
                ]}
              />
            </SafetyPanel>
          ) : (
            <EmptyState
              title="No citation issued"
              description="A violation can be written on an inspection report without a citation being issued to the driver."
            />
          )}
        </TabsContent>

        <TabsContent value="actions" className="pt-4">
          <CorrectiveActionTable
            actions={row.correctiveActions}
            emptyDescription="Raise one to record what will stop this happening again, who owns it, and when it is due."
          />
        </TabsContent>

        <TabsContent value="documents" className="pt-4">
          <EmptyState
            title="No documents on this violation"
            description="The inspection report, citation, correspondence and court paperwork attach here once the document store accepts a violation as an owner."
          />
        </TabsContent>

        <TabsContent value="activity" className="pt-4">
          <Card className="p-4">
            <Timeline items={timeline} />
          </Card>
        </TabsContent>
      </Tabs>

      {raising ? (
        <CreateCorrectiveActionDialog
          open
          onOpenChange={setRaising}
          subjectType="violation"
          subjectId={violation.id}
          subjectLabel={violation.violationNumber}
          severity={violation.severity}
          defaultTitle={`Corrective action: ${VIOLATION_CATEGORY_LABEL[violation.category]}`}
          defaultDescription={violation.description}
          onDone={() => setRaising(false)}
        />
      ) : null}
    </div>
  );
}
