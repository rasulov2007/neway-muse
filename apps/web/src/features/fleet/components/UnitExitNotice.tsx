import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, StatusBadge } from '@/design-system';
import { UNIT_EXIT_REASON_LABEL, exposureOf, latestUnitExit, type UnitExitRecord } from '@/demo';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { UnitExitDialog } from './UnitExitDialog';

/**
 * Why this unit is off the road.
 *
 * Shown on the unit's own page so the account is where the question is asked. It prints only what
 * somebody actually entered: a blank field is absent rather than a zero, because "no repair
 * estimate yet" and "nothing to repair" are different answers.
 */
export function UnitExitNotice({ unitId, entity = 'truck' }: { unitId: string; entity?: 'truck' | 'trailer' }) {
  const record = latestUnitExit(unitId);
  const [editing, setEditing] = useState(false);
  if (!record) return null;
  if (record.redacted)
    return <RedactedExitNotice reason={record.reason} toStatus={record.toStatus} />;

  const lost = record.contents.filter((item) => !item.recovered);
  const exposure = exposureOf(record);

  return (
    <Card className="border-primary-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral" variant="outline" size="sm">
          {UNIT_EXIT_REASON_LABEL[record.reason]}
        </Badge>
        <span className="text-sm font-semibold text-ink">
          {formatIsoDate(record.occurredOn)} · {record.toStatus.replace(/_/g, ' ')}
        </span>
        <span className="text-xs text-muted">
          recorded by {record.recordedByName}
          {record.driverName ? ` · driver ${record.driverName}` : ''}
        </span>
        {/* Edit the account (owner, 2026-10-12): date, reason, driver, what happened, claim, losses. */}
        <Button variant="outline" size="sm" icon={<Pencil />} className="ml-auto" onClick={() => setEditing(true)} data-testid="unit-exit-edit">
          Edit
        </Button>
      </div>
      {editing ? (
        <UnitExitDialog
          entity={entity}
          unitId={unitId}
          unitNumber={record.unitNumber}
          toStatus={record.toStatus}
          actionLabel="Save changes"
          existing={record}
          onClose={() => setEditing(false)}
        />
      ) : null}

      <p className="mt-2 text-sm whitespace-pre-wrap text-secondary">{record.narrative}</p>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        {record.salePrice !== null ? (
          <Fact label="Sold for" value={formatMoney(record.salePrice)} />
        ) : null}
        {record.buyer ? <Fact label="Buyer" value={record.buyer} /> : null}
        {record.titleTransferred !== null ? (
          <Fact label="Title" value={record.titleTransferred ? 'Signed over' : 'Not transferred'} />
        ) : null}
        {record.policeReport ? <Fact label="Police report" value={record.policeReport} /> : null}
        {record.stolenFrom ? <Fact label="Taken from" value={record.stolenFrom} /> : null}
        {record.recovered !== null ? (
          <Fact label="Recovered" value={record.recovered ? 'Yes' : 'Not recovered'} />
        ) : null}
        {record.insuranceClaimNumber ? (
          <Fact label="Claim" value={record.insuranceClaimNumber} />
        ) : null}
        {record.deductible !== null ? (
          <Fact label="Deductible" value={formatMoney(record.deductible)} />
        ) : null}
        {record.odometer !== null ? (
          <Fact label="Odometer" value={record.odometer.toLocaleString()} />
        ) : null}
        {record.injuries !== null ? (
          <Fact label="Injuries" value={record.injuries ? 'Yes' : 'None reported'} />
        ) : null}
      </dl>

      {record.contents.length > 0 ? (
        <div className="mt-3">
          <p className="eyebrow">What was in it</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-sm">
            {record.contents.map((item, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3">
                <span className="text-secondary">
                  {item.label}
                  {item.recovered ? ' · recovered' : ''}
                </span>
                <span
                  className={item.recovered ? 'tabular text-muted' : 'tabular text-danger-text'}
                >
                  {formatMoney(item.value)}
                </span>
              </li>
            ))}
          </ul>
          {lost.length > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {lost.length} of {record.contents.length} not recovered.
            </p>
          ) : null}
        </div>
      ) : null}

      {record.damage.length > 0 ? (
        <div className="mt-3">
          <p className="eyebrow">What broke</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-sm">
            {record.damage.map((item, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3">
                <span className="text-secondary">
                  {item.part}
                  {item.note ? ` — ${item.note}` : ''}
                  {item.repairable ? '' : ' · beyond repair'}
                </span>
                <span className="tabular text-secondary">{formatMoney(item.estimate)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-3 text-sm">
        <span className="text-secondary">Net exposure </span>
        <span
          className={
            exposure > 0
              ? 'tabular font-semibold text-danger-text'
              : 'tabular font-semibold text-ink'
          }
        >
          {formatMoney(exposure)}
        </span>
        {record.expectedRecovery !== null ? (
          <span className="text-xs text-muted">
            {' '}
            after {formatMoney(record.expectedRecovery)} expected back
          </span>
        ) : null}
      </p>
    </Card>
  );
}

/**
 * A stolen unit, for someone without the administrator role: the word and the unit's status, and
 * nothing else. The server sent no details, so there are no blank facts to draw.
 */
function RedactedExitNotice({
  reason,
  toStatus,
}: {
  reason: UnitExitRecord['reason'];
  toStatus: string;
}) {
  return (
    <Card className="border-primary-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="danger" dot size="sm">
          {UNIT_EXIT_REASON_LABEL[reason] ?? 'Stolen'}
        </Badge>
        {toStatus ? <StatusBadge status={toStatus} size="sm" /> : null}
      </div>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  );
}
