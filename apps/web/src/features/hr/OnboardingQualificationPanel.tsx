import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CDL_EXTRACT_LABEL, type CdlExtract } from '@neway/shared';
import { Badge, Card, EmptyState, Skeleton } from '@/design-system';
import { listComplianceDocuments } from '@/features/safety/compliance-api';
import { DocumentRow } from '@/features/safety/EntityComplianceDrawer';
import { formatIsoDate } from '@/lib/format';

/**
 * The driver's file, on the plan that is chasing it.
 *
 * The plan says what has to happen; the qualification file says what has actually been collected.
 * Keeping them on separate screens meant the person doing the chasing had to hold both in their
 * head — so the file is here, with the same rows, the same actions and the same verdicts Safety
 * sees. There is no second copy: these are the documents, read from the same endpoint.
 *
 * The CDL details below them are what was read off the licence and confirmed when the driver was
 * added, kept on the document itself. Shown here read-only; the place to correct them is the
 * document, not a third copy.
 */

export function OnboardingQualificationPanel({
  driverId,
  driverName,
}: {
  driverId: string;
  driverName: string;
}) {
  const [showAll, setShowAll] = useState(false);

  const documents = useQuery({
    queryKey: ['compliance-documents', driverId],
    queryFn: () => listComplianceDocuments({ ownerType: 'driver', ownerId: driverId }),
  });

  const rows = documents.data ?? [];
  const extract = useMemo(() => {
    // The licence carries the template; the medical card's own extract is merged into it.
    const cdl = rows.find((doc) => doc.requirementCode === 'cdl' && doc.extracted);
    return (cdl?.extracted ?? null) as CdlExtract | null;
  }, [rows]);

  const visible = showAll ? rows : rows.filter((doc) => doc.status !== 'expired');

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-md font-bold text-ink">Documents on file</h3>
            <p className="text-xs text-muted">
              The same records Safety reviews. Uploading or replacing one is done from{' '}
              <Link
                to="/safety/compliance"
                search={{ entityId: driverId } as never}
                className="text-primary-text hover:underline"
              >
                {driverName}&rsquo;s qualification file
              </Link>
              .
            </p>
          </div>
          {rows.some((doc) => doc.status === 'expired') ? (
            <button
              type="button"
              className="text-xs text-primary-text hover:underline"
              onClick={() => setShowAll((current) => !current)}
            >
              {showAll ? 'Hide superseded' : 'Show superseded'}
            </button>
          ) : null}
        </div>

        {documents.isPending ? (
          <div className="flex flex-col gap-2" aria-busy>
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            title="Nothing collected yet"
            description="Documents filed against this driver appear here as they arrive."
          />
        ) : (
          <ul className="divide-y divide-line-soft rounded-lg border border-line">
            {visible.map((doc) => (
              <DocumentRow key={doc.id} doc={doc} />
            ))}
          </ul>
        )}
      </Card>

      {extract ? (
        <Card className="flex flex-col gap-3 p-4">
          <div>
            <h3 className="text-md font-bold text-ink">CDL and medical details</h3>
            <p className="text-xs text-muted">
              Read from the cards when the driver was added and confirmed by whoever added them.
              Kept on the licence document itself.
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
            <Detail label={CDL_EXTRACT_LABEL.legalFirstName} value={extract.legalFirstName} />
            <Detail label={CDL_EXTRACT_LABEL.legalMiddleName} value={extract.legalMiddleName} />
            <Detail label={CDL_EXTRACT_LABEL.legalLastName} value={extract.legalLastName} />
            <Detail label={CDL_EXTRACT_LABEL.dateOfBirth} value={date(extract.dateOfBirth)} />
            <Detail label={CDL_EXTRACT_LABEL.cdlNumber} value={extract.cdlNumber} />
            <Detail label={CDL_EXTRACT_LABEL.issuingState} value={extract.issuingState} />
            <Detail label={CDL_EXTRACT_LABEL.cdlClass} value={extract.cdlClass} />
            <Detail label={CDL_EXTRACT_LABEL.cdlIssuedOn} value={date(extract.cdlIssuedOn)} />
            <Detail label={CDL_EXTRACT_LABEL.cdlExpiresOn} value={date(extract.cdlExpiresOn)} />
            <Detail
              label={CDL_EXTRACT_LABEL.endorsements}
              value={extract.endorsements.join(', ') || null}
            />
            <Detail
              label={CDL_EXTRACT_LABEL.restrictions}
              value={extract.restrictions.join(', ') || null}
            />
            <Detail
              label={CDL_EXTRACT_LABEL.medicalIssuedOn}
              value={date(extract.medicalIssuedOn)}
            />
            <Detail
              label={CDL_EXTRACT_LABEL.medicalExpiresOn}
              value={date(extract.medicalExpiresOn)}
            />
            <Detail
              label={CDL_EXTRACT_LABEL.medicalCertificateNumber}
              value={extract.medicalCertificateNumber}
            />
            <Detail label="Examiner" value={extract.medicalExaminerName} />
          </dl>
          {extract.needsReview.length > 0 ? (
            <Badge tone="warning" size="sm">
              {extract.needsReview.length} field
              {extract.needsReview.length === 1 ? '' : 's'} still need reading off the card
            </Badge>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate text-sm text-ink">
        {value ?? <span className="text-faint">Not recorded</span>}
      </dd>
    </div>
  );
}

/** A date-only value, printed without ever going through a time zone. */
function date(value: string | null): string | null {
  return value ? formatIsoDate(value) : null;
}
