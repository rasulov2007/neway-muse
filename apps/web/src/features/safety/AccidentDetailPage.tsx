import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { CheckCircle2, Search, ShieldAlert, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { accidentTransitions } from '@neway/shared';
import {
  BackButton,
  Badge,
  Button,
  Card,
  DropdownMenu,
  EmptyState,
  ErrorState,
  FormField,
  MenuItem,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
  TabsContent,
  Textarea,
  Timeline,
  useToast,
  type TimelineItem,
} from '@/design-system';
import { demoUsers, updateAccident } from '@/demo';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { CorrectiveActionTable } from './components/CorrectiveActionTable';
import { CreateClaimDialog } from './components/CreateClaimDialog';
import { CreateCorrectiveActionDialog } from './components/CreateCorrectiveActionDialog';
import {
  SafetyBlockerNotice,
  SafetyFactList,
  SafetyMetricStrip,
  SafetyPanel,
  type SafetyMetric,
} from './components/SafetyKit';
import {
  ACCIDENT_KIND_LABEL,
  ACCIDENT_SEVERITY_LABEL,
  ACCIDENT_SEVERITY_TONE,
  CLAIM_KIND_LABEL,
  DASH,
  EVIDENCE_LABEL,
  PREVENTABILITY_LABEL,
  PREVENTABILITY_TONE,
} from './safety-ui';
import { useInvalidateSafety, useSafety } from './useSafety';

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'incident', label: 'Incident' },
  { value: 'people', label: 'Driver & equipment' },
  { value: 'injuries', label: 'Injuries' },
  { value: 'damage', label: 'Damage' },
  { value: 'investigation', label: 'Investigation' },
  { value: 'claim', label: 'Insurance' },
  { value: 'actions', label: 'Corrective actions' },
  { value: 'documents', label: 'Documents' },
  { value: 'timeline', label: 'Timeline' },
];

export function AccidentDetailRoute() {
  const { accidentId } = useParams({ from: '/safety/accidents/$accidentId' });
  return <AccidentDetailPage accidentId={accidentId} />;
}

/**
 * The accident workspace — the most consequential page in Safety.
 *
 * The notice under the header is the whole point: it names exactly what stands between this file
 * and being closed, drawn from the same engine that refuses the close. A screen that lets someone
 * close a DOT recordable crash with no police report is a screen that fails an audit for them.
 */
export function AccidentDetailPage({ accidentId }: { accidentId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();
  const safetyQuery = useSafety();
  const [tab, setTab] = useState('overview');
  const [claiming, setClaiming] = useState(false);
  const [raising, setRaising] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [preventable, setPreventable] = useState<string>('undetermined');
  const [rootCause, setRootCause] = useState('');
  const [ownerId, setOwnerId] = useState('');

  const row =
    safetyQuery.data?.byAccidentId.get(accidentId) ??
    safetyQuery.data?.accidents.find((r) => r.accident.accidentNumber === accidentId);

  const change = useMutation({
    mutationFn: (patch: Parameters<typeof updateAccident>[0]) => updateAccident(patch),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({ tone: 'success', title: `${result.accident?.accidentNumber} updated` });
      setDeciding(false);
      setAssigning(false);
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
        title="That accident file is not on record"
        description="It may have been removed, or the link may be out of date."
        action={
          <Button onClick={() => void navigate({ to: '/safety/accidents' })}>
            Back to accidents
          </Button>
        }
      />
    );
  }

  const { accident, review, recordability, claim } = row;
  const money = (value: number | null) =>
    value === null ? <span className="text-faint">Not assessed</span> : formatMoney(value);

  const metrics: SafetyMetric[] = [
    { label: 'Severity', value: ACCIDENT_SEVERITY_LABEL[accident.severity] },
    { label: 'Type', value: ACCIDENT_KIND_LABEL[accident.kind] },
    {
      label: 'Days open',
      value: review.open ? formatNumber(review.daysOpen) : null,
      tone: review.daysOpen > 60 ? 'warning' : 'default',
      title: 'This file is closed.',
    },
    {
      label: 'Injuries',
      value:
        accident.fatalities > 0
          ? `${accident.fatalities} fatal`
          : accident.injuries.length > 0
            ? formatNumber(accident.injuries.length)
            : '0',
      tone: accident.fatalities > 0 || accident.injuries.length > 0 ? 'danger' : 'default',
    },
    {
      label: 'Assessed damage',
      value: row.totalDamage === null ? null : formatMoney(row.totalDamage),
      title: 'Nothing has been assessed yet.',
    },
    {
      label: 'Claim',
      value: claim ? claim.claimNumber : null,
      hint: claim ? claim.insurer : undefined,
      title: 'No claim has been opened against this accident.',
    },
  ];

  const timeline: TimelineItem[] = [
    {
      id: 'occurred',
      at: accident.at,
      title: 'Accident occurred',
      description: `${accident.location.city}, ${accident.location.state}${
        accident.location.highway ? ` · ${accident.location.highway}` : ''
      }`,
      tone: 'danger',
    },
  ];
  if (accident.investigationOpenedAt) {
    timeline.push({
      id: 'investigation',
      at: accident.investigationOpenedAt,
      title: 'Investigation opened',
      description: accident.ownerName ?? undefined,
      tone: 'info',
    });
  }
  if (accident.preventabilityDecidedAt) {
    timeline.push({
      id: 'preventability',
      at: accident.preventabilityDecidedAt,
      title: `Ruled ${(PREVENTABILITY_LABEL[accident.preventable] ?? accident.preventable).toLowerCase()}`,
      description: accident.preventabilityDecidedBy ?? undefined,
      tone: accident.preventable === 'yes' ? 'danger' : 'success',
    });
  }
  if (claim) {
    timeline.push({
      id: 'claim',
      at: claim.openedAt,
      title: `Claim ${claim.claimNumber} opened`,
      description: claim.insurer,
      tone: 'info',
    });
  }
  for (const action of row.correctiveActions) {
    timeline.push({
      id: `cap-${action.action.id}`,
      at: action.action.createdAt,
      title: `${action.action.actionNumber} raised`,
      description: action.action.title,
      tone: 'warning',
    });
  }
  if (accident.closedAt) {
    timeline.push({
      id: 'closed',
      at: accident.closedAt,
      title: 'File closed',
      description: accident.conclusion ?? undefined,
      tone: 'success',
    });
  }
  timeline.sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at)));

  const safetyStaff = demoUsers.filter((u) => u.department === 'safety');

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/safety/accidents" />}
        title={accident.accidentNumber}
        description={`${formatDateTime(accident.at)} · ${accident.location.city}, ${accident.location.state} · ${accident.driverName} on unit ${accident.unitNumber}`}
        actions={
          <>
            {accident.status === 'reported' || accident.status === 'under_review' ? (
              <Button
                variant="secondary"
                icon={<Search />}
                onClick={() =>
                  change.mutate({
                    id: accident.id,
                    status: 'investigating',
                    reason: 'Investigation opened',
                  })
                }
              >
                Start investigation
              </Button>
            ) : null}
            {!accident.claimId ? (
              <Button variant="secondary" icon={<ShieldAlert />} onClick={() => setClaiming(true)}>
                Create claim
              </Button>
            ) : null}
            <DropdownMenu trigger={<Button variant="secondary">More</Button>} align="end">
              <MenuItem
                icon={<UserPlus />}
                onSelect={() => {
                  setOwnerId(accident.ownerId ?? '');
                  setAssigning(true);
                }}
              >
                {accident.ownerId ? 'Reassign investigator' : 'Assign investigator'}
              </MenuItem>
              <MenuItem
                icon={<CheckCircle2 />}
                onSelect={() => {
                  setPreventable(accident.preventable);
                  setRootCause(accident.rootCause ?? '');
                  setDeciding(true);
                }}
              >
                Record preventability
              </MenuItem>
              <MenuItem icon={<ShieldAlert />} onSelect={() => setRaising(true)}>
                Create corrective action
              </MenuItem>
              {/* Only the transitions the flow allows, and the write path enforces the same table. */}
              {accidentTransitions(accident.status).map((status) => (
                <MenuItem
                  key={status}
                  onSelect={() =>
                    change.mutate({
                      id: accident.id,
                      status,
                      reason: `Moved to ${status.replace(/_/g, ' ')}`,
                    })
                  }
                >
                  Move to {status.replace(/_/g, ' ')}
                </MenuItem>
              ))}
            </DropdownMenu>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={accident.status} />
        <Badge tone={ACCIDENT_SEVERITY_TONE[accident.severity]}>
          {ACCIDENT_SEVERITY_LABEL[accident.severity]}
        </Badge>
        <Badge
          tone={PREVENTABILITY_TONE[accident.preventable] ?? 'neutral'}
          title={
            accident.preventabilityDecidedBy
              ? `Decided by ${accident.preventabilityDecidedBy}`
              : 'Nobody has decided this yet'
          }
        >
          {PREVENTABILITY_LABEL[accident.preventable]}
        </Badge>
        {accident.dotRecordable ? (
          <Badge tone="danger" title={recordability.reasons.join('. ')}>
            DOT recordable
          </Badge>
        ) : null}
      </div>

      <SafetyBlockerNotice
        title="This file cannot be closed yet"
        tone={accident.dotRecordable ? 'danger' : 'warning'}
        reasons={review.open ? review.blockers : []}
      />

      <SafetyMetricStrip metrics={metrics} />

      <Tabs items={TABS} value={tab} onValueChange={setTab} aria-label="Accident file">
        <TabsContent value="overview" className="pt-4">
          <div className="grid gap-4 xl:grid-cols-3">
            <SafetyPanel title="Accident">
              <SafetyFactList
                facts={[
                  { label: 'Accident #', value: accident.accidentNumber },
                  { label: 'Date and time', value: formatDateTime(accident.at) },
                  {
                    label: 'Location',
                    value: `${accident.location.city}, ${accident.location.state}`,
                  },
                  {
                    label: 'Highway',
                    value: accident.location.highway ?? <span className="text-faint">{DASH}</span>,
                  },
                  { label: 'Type', value: ACCIDENT_KIND_LABEL[accident.kind] },
                  { label: 'Severity', value: ACCIDENT_SEVERITY_LABEL[accident.severity] },
                ]}
              />
            </SafetyPanel>

            <SafetyPanel title="Conditions">
              <SafetyFactList
                facts={[
                  {
                    label: 'Weather',
                    value: accident.weather ?? <span className="text-faint">Not recorded</span>,
                  },
                  {
                    label: 'Road',
                    value: accident.roadConditions ?? (
                      <span className="text-faint">Not recorded</span>
                    ),
                  },
                  {
                    label: 'Traffic',
                    value: accident.trafficConditions ?? (
                      <span className="text-faint">Not recorded</span>
                    ),
                  },
                  {
                    label: 'Towed from scene',
                    value: accident.towedFromScene ? 'Yes' : 'No',
                  },
                ]}
              />
            </SafetyPanel>

            <SafetyPanel title="DOT recordability">
              <p className="text-sm text-secondary">
                {accident.dotRecordable
                  ? 'This crash meets the federal definition of a recordable accident.'
                  : 'This crash does not meet the federal definition of a recordable accident.'}
              </p>
              <ul className="flex flex-col gap-1">
                {recordability.reasons.map((reason) => (
                  <li key={reason} className="text-sm text-muted">
                    • {reason}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-faint">49 CFR 390.5.</p>
            </SafetyPanel>
          </div>
        </TabsContent>

        <TabsContent value="incident" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SafetyPanel title="What happened">
              <p className="text-sm text-secondary">{accident.description}</p>
              {accident.narrative ? (
                <p className="text-sm text-secondary">{accident.narrative}</p>
              ) : (
                <p className="text-sm text-faint">
                  No narrative has been written yet. It is added as the investigation proceeds.
                </p>
              )}
            </SafetyPanel>
            <SafetyPanel title="Cause">
              <SafetyFactList
                facts={[
                  {
                    label: 'Primary cause',
                    value: accident.primaryCause ?? (
                      <span className="text-faint">Not determined</span>
                    ),
                  },
                  {
                    label: 'Contributing factors',
                    value:
                      accident.contributingFactors.length > 0 ? (
                        accident.contributingFactors.join(', ')
                      ) : (
                        <span className="text-faint">None recorded</span>
                      ),
                  },
                  {
                    label: 'Police report #',
                    value: accident.policeReportNumber ?? (
                      <span className="text-faint">{DASH}</span>
                    ),
                  },
                  {
                    label: 'Agency',
                    value: accident.policeAgency ?? <span className="text-faint">{DASH}</span>,
                  },
                ]}
              />
            </SafetyPanel>
          </div>
        </TabsContent>

        <TabsContent value="people" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SafetyPanel title="Driver and equipment">
              <SafetyFactList
                facts={[
                  {
                    label: 'Driver',
                    value: (
                      <Link
                        to="/drivers"
                        search={{ driver: accident.driverId }}
                        className="text-primary-text hover:underline"
                      >
                        {accident.driverName}
                      </Link>
                    ),
                  },
                  {
                    label: 'Unit',
                    value: (
                      <Link
                        to="/fleet/trucks/$truckId"
                        params={{ truckId: accident.truckId }}
                        className="text-primary-text hover:underline"
                      >
                        {accident.unitNumber}
                      </Link>
                    ),
                  },
                  {
                    label: 'Trailer',
                    value: accident.trailerId ? (
                      <Link
                        to="/fleet/trailers/$trailerId"
                        params={{ trailerId: accident.trailerId }}
                        className="text-primary-text hover:underline"
                      >
                        {accident.trailerUnit}
                      </Link>
                    ) : (
                      <span className="text-faint">{DASH}</span>
                    ),
                  },
                ]}
              />
            </SafetyPanel>
            <SafetyPanel title="Load">
              {accident.loadNumber ? (
                <SafetyFactList
                  facts={[
                    {
                      label: 'Load',
                      value: (
                        <Link
                          to="/loads/$loadNumber"
                          params={{ loadNumber: accident.loadNumber }}
                          className="text-primary-text hover:underline"
                        >
                          {accident.loadNumber}
                        </Link>
                      ),
                    },
                    {
                      label: 'Customer',
                      value: claim?.customerName ?? <span className="text-faint">On the load</span>,
                    },
                    {
                      label: 'Broker',
                      value: claim?.brokerName ?? <span className="text-faint">{DASH}</span>,
                    },
                  ]}
                />
              ) : (
                <p className="text-sm text-faint">The unit was not on a load when this happened.</p>
              )}
            </SafetyPanel>
          </div>
        </TabsContent>

        <TabsContent value="injuries" className="pt-4">
          {accident.injuries.length === 0 && accident.fatalities === 0 ? (
            <EmptyState
              title="No injuries recorded"
              description="Whether anyone was hurt is what decides whether this crash is DOT recordable, so it is recorded even when the answer is nobody."
            />
          ) : (
            <Card className="p-4">
              <ul className="divide-y divide-line-soft">
                {accident.injuries.map((injury) => (
                  <li key={injury.id} className="py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-ink">{injury.person}</p>
                        <p className="text-xs text-muted">{injury.role.replace(/_/g, ' ')}</p>
                      </div>
                      {injury.treatedAwayFromScene ? (
                        <Badge tone="danger">Treated away from scene</Badge>
                      ) : (
                        <Badge tone="warning">Treated at scene</Badge>
                      )}
                    </div>
                    <SafetyFactList
                      className="mt-2"
                      facts={[
                        { label: 'Injury', value: injury.injuryType },
                        {
                          label: 'Hospital',
                          value: injury.hospital ?? <span className="text-faint">{DASH}</span>,
                        },
                        {
                          label: "Workers' comp",
                          value: injury.workersCompClaim ?? (
                            <span className="text-faint">{DASH}</span>
                          ),
                        },
                      ]}
                    />
                  </li>
                ))}
              </ul>
              {accident.fatalities > 0 ? (
                <p className="mt-3 border-t border-line-soft pt-3 text-sm font-medium text-danger-text">
                  {accident.fatalities} fatality recorded on this file.
                </p>
              ) : null}
            </Card>
          )}
        </TabsContent>

        <TabsContent value="damage" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SafetyPanel title="Repair">
              <SafetyFactList
                facts={[
                  { label: 'Truck estimate', value: money(accident.damage.truckRepairEstimate) },
                  { label: 'Truck final', value: money(accident.damage.truckRepairFinal) },
                  {
                    label: 'Trailer estimate',
                    value: money(accident.damage.trailerRepairEstimate),
                  },
                  { label: 'Trailer final', value: money(accident.damage.trailerRepairFinal) },
                ]}
              />
            </SafetyPanel>
            <SafetyPanel title="Other exposure">
              <SafetyFactList
                facts={[
                  { label: 'Cargo loss', value: money(accident.damage.cargoLossAmount) },
                  { label: 'Third party', value: money(accident.damage.thirdPartyEstimate) },
                  { label: 'Property', value: money(accident.damage.propertyDamageEstimate) },
                  { label: 'Towing', value: money(accident.damage.towingCost) },
                  { label: 'Storage', value: money(accident.damage.storageCost) },
                  { label: 'Other', value: money(accident.damage.otherCost) },
                ]}
              />
              <p className="text-xs text-faint">
                &ldquo;Not assessed&rdquo; is different from zero: it means nobody has put a figure
                on it yet.
              </p>
            </SafetyPanel>
          </div>
        </TabsContent>

        <TabsContent value="investigation" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SafetyPanel title="Investigation">
              <SafetyFactList
                facts={[
                  {
                    label: 'Owner',
                    value: accident.ownerName ?? (
                      <span className="font-medium text-warning-text">Unassigned</span>
                    ),
                  },
                  {
                    label: 'Opened',
                    value: accident.investigationOpenedAt ? (
                      formatDateTime(accident.investigationOpenedAt)
                    ) : (
                      <span className="text-faint">Not opened</span>
                    ),
                  },
                  {
                    label: 'Due',
                    value: accident.investigationDueOn ?? (
                      <span className="text-faint">{DASH}</span>
                    ),
                  },
                  {
                    label: 'Root cause',
                    value: accident.rootCause ?? <span className="text-faint">Not determined</span>,
                  },
                  {
                    label: 'Conclusion',
                    value: accident.conclusion ?? <span className="text-faint">Not written</span>,
                  },
                  {
                    label: 'Preventability',
                    value: PREVENTABILITY_LABEL[accident.preventable],
                  },
                ]}
              />
            </SafetyPanel>
            <SafetyPanel title="Evidence">
              <ul className="flex flex-col gap-1.5">
                {Object.entries(EVIDENCE_LABEL).map(([key, label]) => {
                  const present = accident.evidence.includes(key as never);
                  const required = review.missingEvidence.includes(key as never);
                  return (
                    <li key={key} className="flex items-center justify-between gap-3 text-sm">
                      <span className={present ? 'text-ink' : 'text-muted'}>{label}</span>
                      {present ? (
                        <Badge tone="success">On file</Badge>
                      ) : required ? (
                        <Badge tone="danger">Required</Badge>
                      ) : (
                        <span className="text-xs text-faint">Not on file</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </SafetyPanel>
          </div>
        </TabsContent>

        <TabsContent value="claim" className="pt-4">
          {claim ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <SafetyPanel title="Claim">
                <SafetyFactList
                  facts={[
                    {
                      label: 'Claim #',
                      value: (
                        <Link
                          to="/safety/claims/$claimId"
                          params={{ claimId: claim.id }}
                          className="text-primary-text hover:underline"
                        >
                          {claim.claimNumber}
                        </Link>
                      ),
                    },
                    { label: 'Cover', value: CLAIM_KIND_LABEL[claim.kind] ?? claim.kind },
                    { label: 'Insurer', value: claim.insurer },
                    {
                      label: "Insurer's reference",
                      value: claim.insurerClaimNumber ?? <span className="text-faint">{DASH}</span>,
                    },
                    { label: 'Status', value: <StatusBadge status={claim.status} /> },
                    { label: 'Opened', value: formatDateTime(claim.openedAt) },
                  ]}
                />
              </SafetyPanel>
              <SafetyPanel title="Exposure">
                <SafetyFactList
                  facts={[
                    {
                      label: 'Reserve',
                      value:
                        claim.reserveAmount === null ? (
                          <span className="text-faint">Unreserved</span>
                        ) : (
                          formatMoney(claim.reserveAmount)
                        ),
                    },
                    {
                      label: 'Paid',
                      value:
                        claim.paidAmount === null ? (
                          <span className="text-faint">{DASH}</span>
                        ) : (
                          formatMoney(claim.paidAmount)
                        ),
                    },
                    {
                      label: 'Outstanding',
                      value:
                        claim.reserveAmount === null || claim.paidAmount === null ? (
                          <span
                            className="text-faint"
                            title="An unreserved claim is an unknown liability, not a zero one."
                          >
                            Unknown
                          </span>
                        ) : (
                          formatMoney(claim.reserveAmount - claim.paidAmount)
                        ),
                    },
                    {
                      label: 'Deductible',
                      value:
                        claim.deductible === null ? (
                          <span className="text-faint">{DASH}</span>
                        ) : (
                          formatMoney(claim.deductible)
                        ),
                    },
                  ]}
                />
              </SafetyPanel>
            </div>
          ) : (
            <EmptyState
              title="No claim opened"
              description="Opening a claim carries over the driver, unit, trailer, load, customer, broker and the damage assessed here — nothing is retyped."
              action={
                <Button icon={<ShieldAlert />} onClick={() => setClaiming(true)}>
                  Create claim
                </Button>
              }
            />
          )}
        </TabsContent>

        <TabsContent value="actions" className="pt-4">
          <CorrectiveActionTable
            actions={row.correctiveActions}
            emptyDescription="A preventable accident usually earns one: coaching, re-training, or a change to how the run is planned."
          />
        </TabsContent>

        <TabsContent value="documents" className="pt-4">
          <EmptyState
            title="No documents on this file"
            description="Police reports, statements, photographs, dashcam footage and insurance correspondence attach here once the document store accepts an accident as an owner. The Evidence panel on the Investigation tab tracks what the file is still missing."
          />
        </TabsContent>

        <TabsContent value="timeline" className="pt-4">
          <Card className="p-4">
            <Timeline items={timeline} />
          </Card>
        </TabsContent>
      </Tabs>

      {claiming ? (
        <CreateClaimDialog
          open
          onOpenChange={setClaiming}
          accident={row}
          onDone={() => setClaiming(false)}
        />
      ) : null}

      {raising ? (
        <CreateCorrectiveActionDialog
          open
          onOpenChange={setRaising}
          subjectType="accident"
          subjectId={accident.id}
          subjectLabel={accident.accidentNumber}
          severity={accident.severity === 'critical' ? 'critical' : 'high'}
          defaultTitle="Driver coaching and re-training"
          defaultDescription={accident.description}
          onDone={() => setRaising(false)}
        />
      ) : null}

      <Modal
        open={deciding}
        onOpenChange={setDeciding}
        title="Record preventability"
        description="This decision goes on the driver's record and into the insurer conversation, so it is attributed to whoever makes it."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeciding(false)}>
              Cancel
            </Button>
            <Button
              loading={change.isPending}
              onClick={() =>
                change.mutate({
                  id: accident.id,
                  preventable: preventable as 'yes' | 'no' | 'undetermined',
                  rootCause: rootCause.trim() ? rootCause.trim() : null,
                  reason: `Ruled ${preventable}`,
                })
              }
            >
              Record decision
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label="Preventability" required>
            <Select
              options={[
                { value: 'yes', label: 'Preventable' },
                { value: 'no', label: 'Non-preventable' },
                { value: 'undetermined', label: 'Undetermined' },
              ]}
              value={preventable}
              onValueChange={setPreventable}
            />
          </FormField>
          <FormField label="Root cause" description="What the investigation concluded.">
            <Textarea rows={3} value={rootCause} onChange={(e) => setRootCause(e.target.value)} />
          </FormField>
        </div>
      </Modal>

      <Modal
        open={assigning}
        onOpenChange={setAssigning}
        size="sm"
        title="Assign investigator"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAssigning(false)}>
              Cancel
            </Button>
            <Button
              loading={change.isPending}
              onClick={() =>
                change.mutate({
                  id: accident.id,
                  ownerId: ownerId || null,
                  reason: 'Investigator assigned',
                })
              }
            >
              Save
            </Button>
          </>
        }
      >
        <FormField label="Investigator">
          <Select
            options={[
              { value: '', label: 'Unassigned' },
              ...safetyStaff.map((u) => ({ value: u.id, label: `${u.name} · ${u.role}` })),
            ]}
            value={ownerId}
            onValueChange={setOwnerId}
          />
        </FormField>
      </Modal>
    </div>
  );
}
