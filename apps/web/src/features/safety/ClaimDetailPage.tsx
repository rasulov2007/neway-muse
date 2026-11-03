import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  BackButton,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  StatusBadge,
} from '@/design-system';
import { formatDateTime, formatMoney } from '@/lib/format';
import { SafetyFactList, SafetyPanel } from './components/SafetyKit';
import { CLAIM_KIND_LABEL, DASH } from './safety-ui';
import { useSafety } from './useSafety';
import type { ReactNode } from 'react';

export function ClaimDetailRoute() {
  const { claimId } = useParams({ from: '/safety/claims/$claimId' });
  return <ClaimDetailPage claimId={claimId} />;
}

/**
 * One claim, read.
 *
 * A claim number used to be plain text on the accident list — the one piece of paper an adjuster
 * asks for by name, and the only way to see what was behind it was to open the accident it came
 * from and read a panel. This is that record on its own page, reachable by its own URL, which is
 * what a person on the phone to an insurer actually needs.
 *
 * Two things it deliberately does not do. It does not compute reserve minus paid: the difference
 * between money set aside and money paid out is not an amount anybody owes, and printing it as one
 * is how a reserve ends up in a conversation as a debt. And it does not offer a button — a claim's
 * status moves when the insurer moves it, and a control here that only raised a cheerful message
 * would be a lie about a file somebody is relying on.
 *
 * Everything on the page is read through ids the records already hold. Nothing is matched by name,
 * and nothing is inferred from who happens to be driving the unit today.
 */
export function ClaimDetailPage({ claimId }: { claimId: string }) {
  const navigate = useNavigate();
  const safetyQuery = useSafety();
  const bundle = safetyQuery.data;

  const claim =
    bundle?.byClaimId.get(claimId) ?? bundle?.claims.find((c) => c.claimNumber === claimId) ?? null;

  if (safetyQuery.isPending) {
    return (
      <div className="flex flex-col gap-(--section-gap)" aria-busy>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (safetyQuery.error) {
    return (
      <Card>
        <ErrorState
          title="Unable to load this claim"
          description="The claim file could not be fetched."
          error={safetyQuery.error}
          onRetry={() => void safetyQuery.refetch()}
          retrying={safetyQuery.isFetching}
        />
      </Card>
    );
  }

  if (!claim) {
    return (
      <EmptyState
        title="That claim is not on file"
        description="It may have been removed, or the link may be out of date."
        action={
          <Button onClick={() => void navigate({ to: '/safety/claims' })}>Back to claims</Button>
        }
      />
    );
  }

  const accident = claim.accidentId ? (bundle?.byAccidentId.get(claim.accidentId) ?? null) : null;

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/safety/claims" />}
        title={`Claim ${claim.claimNumber}`}
        meta={
          <>
            <StatusBadge status={claim.status} />
            <Badge tone="neutral">{CLAIM_KIND_LABEL[claim.kind] ?? claim.kind}</Badge>
            <span className="text-xs text-muted">
              Opened {formatDateTime(claim.openedAt)}
              {claim.closedAt ? ` · closed ${formatDateTime(claim.closedAt)}` : ''}
            </span>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <SafetyPanel title="Claim">
          <SafetyFactList
            facts={[
              { label: 'Claim #', value: claim.claimNumber },
              { label: 'Cover', value: CLAIM_KIND_LABEL[claim.kind] ?? claim.kind },
              { label: 'Status', value: <StatusBadge status={claim.status} /> },
              { label: 'Opened', value: formatDateTime(claim.openedAt) },
              {
                label: 'Closed',
                value: claim.closedAt ? formatDateTime(claim.closedAt) : <Unset>Still open</Unset>,
              },
              {
                label: 'Owner',
                value: claim.ownerName ?? <Unset>Unassigned</Unset>,
              },
            ]}
          />
        </SafetyPanel>

        <SafetyPanel title="Insurer">
          <SafetyFactList
            facts={[
              { label: 'Insurer', value: claim.insurer },
              {
                label: "Insurer's reference",
                value: claim.insurerClaimNumber ?? <Unset>Not issued yet</Unset>,
              },
            ]}
          />
          <p className="text-xs text-muted">
            This is our own record of the claim. Nothing here is sent to the insurer.
          </p>
        </SafetyPanel>

        <SafetyPanel title="Exposure">
          <SafetyFactList
            facts={[
              { label: 'Reserve', value: <Money amount={claim.reserveAmount} /> },
              { label: 'Paid', value: <Money amount={claim.paidAmount} /> },
              { label: 'Deductible', value: <Money amount={claim.deductible} /> },
            ]}
          />
          <p className="text-xs text-muted">
            A reserve is money set aside against this claim, not money owed.
          </p>
        </SafetyPanel>

        <SafetyPanel title="Incident">
          <SafetyFactList
            facts={[
              {
                label: 'Accident',
                value:
                  claim.accidentId && claim.accidentNumber ? (
                    <Link
                      to="/safety/accidents/$accidentId"
                      params={{ accidentId: claim.accidentId }}
                      className="text-primary-text hover:underline"
                    >
                      {claim.accidentNumber}
                    </Link>
                  ) : (
                    <Unset>Not linked to an accident</Unset>
                  ),
              },
              {
                label: 'When',
                value: accident ? formatDateTime(accident.accident.at) : <Unset>{DASH}</Unset>,
              },
              {
                label: 'Where',
                value: accident ? (
                  `${accident.accident.location.city}, ${accident.accident.location.state}`
                ) : (
                  <Unset>{DASH}</Unset>
                ),
              },
              {
                label: 'Unit',
                value:
                  claim.truckId && claim.unitNumber ? (
                    <Link
                      to="/fleet/trucks/$truckId"
                      params={{ truckId: claim.truckId }}
                      className="text-primary-text hover:underline"
                    >
                      {claim.unitNumber}
                    </Link>
                  ) : (
                    <Unset>Not recorded</Unset>
                  ),
              },
              {
                label: 'Driver',
                value:
                  claim.driverId && claim.driverName ? (
                    <Link
                      to="/drivers/$driverId"
                      params={{ driverId: claim.driverId }}
                      className="text-primary-text hover:underline"
                    >
                      {claim.driverName}
                    </Link>
                  ) : (
                    <Unset>Not recorded</Unset>
                  ),
              },
              {
                label: 'Trailer',
                value: claim.trailerId ? (
                  <Link
                    to="/fleet/trailers/$trailerId"
                    params={{ trailerId: claim.trailerId }}
                    className="text-primary-text hover:underline"
                  >
                    {accident?.accident.trailerUnit ?? claim.trailerId}
                  </Link>
                ) : (
                  <Unset>None on the incident</Unset>
                ),
              },
              {
                label: 'Load',
                value:
                  claim.loadId && claim.loadNumber ? (
                    <Link
                      to="/loads/$loadNumber"
                      params={{ loadNumber: claim.loadNumber }}
                      className="text-primary-text hover:underline"
                    >
                      {claim.loadNumber}
                    </Link>
                  ) : (
                    <Unset>Not under load</Unset>
                  ),
              },
            ]}
          />
          {claim.accidentId ? (
            <p className="text-xs text-muted">
              Photographs and other evidence stay on the accident file.
            </p>
          ) : null}
        </SafetyPanel>

        {claim.customerName || claim.brokerName ? (
          <SafetyPanel title="Freight">
            <SafetyFactList
              facts={[
                { label: 'Customer', value: claim.customerName ?? <Unset>Not recorded</Unset> },
                { label: 'Broker', value: claim.brokerName ?? <Unset>Not recorded</Unset> },
              ]}
            />
          </SafetyPanel>
        ) : null}

        <SafetyPanel title="What was claimed" className="lg:col-span-2">
          <p className="text-sm text-secondary">{claim.description}</p>
          {claim.notes ? (
            <div className="border-t border-line-soft pt-3">
              <p className="eyebrow">Notes</p>
              <p className="mt-1 text-sm whitespace-pre-line text-secondary">{claim.notes}</p>
            </div>
          ) : (
            <p className="text-xs text-muted">No notes on this claim.</p>
          )}
        </SafetyPanel>
      </div>
    </div>
  );
}

/** Something that has no value yet, said in words rather than as a zero. */
function Unset({ children }: { children: ReactNode }) {
  return <span className="text-faint">{children}</span>;
}

/** Money, or the fact that nobody has put a figure on it. A null is never a zero. */
function Money({ amount }: { amount: number | null }) {
  return amount === null ? <Unset>Not recorded</Unset> : <>{formatMoney(amount)}</>;
}
