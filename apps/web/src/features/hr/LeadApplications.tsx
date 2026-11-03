import type { ReactNode } from 'react';
import type { LeadApplication } from '@neway/shared';
import { Alert, Skeleton } from '@/design-system';
import { formatDateTime, formatPhone } from '@/lib/format';
import { useLeadApplications } from './useHiring';

/**
 * What a driver said on the online application, for the lead drawer.
 *
 * The latest application is laid out in full. Earlier ones (a driver who applied again) are kept
 * underneath, each complete, because a recruiter needs to see what changed between them and the
 * record of what the driver agreed to is per application.
 */
export function LeadApplications({ leadId }: { leadId: string }) {
  const applications = useLeadApplications(leadId);
  if (applications.isPending) return <Skeleton className="h-40" />;
  if (applications.error) {
    return (
      <Alert
        tone="danger"
        title="Applications could not be loaded"
        description={applications.error instanceof Error ? applications.error.message : undefined}
      />
    );
  }
  const list = applications.data ?? [];
  if (list.length === 0) return null;
  const [latest, ...earlier] = list as [LeadApplication, ...LeadApplication[]];
  return (
    <section className="flex flex-col gap-3" aria-labelledby="lead-application-heading">
      <div className="flex flex-col gap-0.5">
        <h3 id="lead-application-heading" className="text-md font-bold text-ink">
          Online application
        </h3>
        <p className="text-xs text-muted">
          Received {formatDateTime(latest.receivedAt)} through “{latest.link.name}”
          {list.length > 1 ? ` · applied ${list.length} times` : ''}
        </p>
      </div>
      <ApplicationDetails application={latest} />
      {earlier.length > 0 ? (
        <details className="rounded-md border border-line-soft px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold text-secondary">
            Earlier applications ({earlier.length})
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            {earlier.map((a) => (
              <div key={a.id} className="flex flex-col gap-2 border-t border-line-soft pt-3">
                <p className="text-xs text-muted">
                  {formatDateTime(a.receivedAt)} through “{a.link.name}”
                </p>
                <ApplicationDetails application={a} />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function ApplicationDetails({ application: a }: { application: LeadApplication }) {
  const answers = a.answers;
  const utm = a.attribution;
  const utmRows: [string, string | null][] = [
    ['utm_source', utm.utmSource],
    ['utm_medium', utm.utmMedium],
    ['utm_campaign', utm.utmCampaign],
    ['utm_content', utm.utmContent],
    ['utm_term', utm.utmTerm],
  ];
  const hasUtm = utmRows.some(([, v]) => v) || utm.fbclid || utm.gclid;
  return (
    <div className="flex flex-col gap-3">
      {answers ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Item label="Full name">{answers.fullName}</Item>
          <Item label="Phone">{formatPhone(answers.phone)}</Item>
          <Item label="CDL driving experience">{answers.experience}</Item>
          <Item label="What are you looking for">{answers.position}</Item>
          {answers.completedInSeconds !== null ? (
            <Item label="Filled in">
              {answers.completedInSeconds} s
            </Item>
          ) : null}
        </dl>
      ) : (
        <p className="text-sm text-muted">Answers in an earlier format</p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Item label="Source">
          {a.source.replace(/_/g, ' ')}
          {a.campaignName ? ` · ${a.campaignName}` : ''}
        </Item>
        <Item label="Link">/apply/{a.link.slug}</Item>
        {hasUtm ? (
          <div className="col-span-2 flex flex-col gap-0.5">
            <dt className="text-xs font-medium text-muted">Campaign tags on the link</dt>
            <dd className="flex flex-wrap gap-x-3 gap-y-1 text-ink">
              {utmRows
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <span key={k}>
                    <span className="text-muted">{k}</span> {v}
                  </span>
                ))}
              {utm.fbclid ? <span className="text-muted">Meta click id</span> : null}
              {utm.gclid ? <span className="text-muted">Google click id</span> : null}
            </dd>
          </div>
        ) : null}
        {utm.referrer ? (
          <div className="col-span-2 flex flex-col gap-0.5">
            <dt className="text-xs font-medium text-muted">Came from</dt>
            <dd className="break-all text-ink">{utm.referrer}</dd>
          </div>
        ) : null}
      </dl>
      <div className="rounded-md bg-surface-muted px-3 py-2 text-xs text-secondary">
        <p>
          Agreed {formatDateTime(a.consent.agreedAt)} to: “{a.consent.text}”
        </p>
        <p className="mt-1 break-all text-muted">Privacy policy: {a.consent.privacyPolicyUrl}</p>
      </div>
    </div>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
