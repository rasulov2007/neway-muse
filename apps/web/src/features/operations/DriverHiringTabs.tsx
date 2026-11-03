import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { CONSENT_DOCUMENT_LABELS, CONSENT_DOCUMENT_TYPES, COST_TREATMENT_LABELS, TRAVEL_KIND_LABELS, type CandidateJourney } from '@neway/shared';
import { Card } from '@/design-system';
import { isEnabled } from '@/lib/feature-flags';
import { ProfileAccidents } from '@/features/accidents/ProfileAccidents';
import { useCandidateJourney, journeyUrls } from '@/features/hr/recruit/useJourney';
import { DocRow, Fact, Pill } from '@/features/hr/recruit/journey/JourneyKit';
import { longDate, longDateTime } from '@/features/hr/recruit/recruit-format';
import { ApiError, apiGet } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';

/**
 * The hired driver's Safety, Onboarding and Costs (step 9, owner brief 2026-10-11): read from the
 * candidate journey the driver came through, under the same driver id — nothing is copied and
 * nothing is uploaded again. A driver who did not come through hiring, or a reader without the
 * recruiting permission, sees a calm line instead of an error.
 */
function useDriverJourney(driverId: string): { key: string | null; journey: CandidateJourney | undefined; state: 'loading' | 'none' | 'forbidden' | 'error' | 'ready' } {
  const candidate = useQuery({
    queryKey: ['hr', 'recruit', 'driver-candidate', driverId],
    queryFn: () => apiGet<{ key: string } | null>(`/hiring/recruiting/drivers/${encodeURIComponent(driverId)}/candidate`),
    retry: false,
  });
  const key = candidate.data?.key ?? null;
  const journey = useCandidateJourney(key ?? '', { enabled: Boolean(key) });
  if (candidate.isPending) return { key, journey: undefined, state: 'loading' };
  if (candidate.error instanceof ApiError && candidate.error.status === 403) return { key, journey: undefined, state: 'forbidden' };
  if (candidate.isError) return { key, journey: undefined, state: 'error' };
  if (!key) return { key, journey: undefined, state: 'none' };
  if (journey.isPending) return { key, journey: undefined, state: 'loading' };
  if (journey.isError) return { key, journey: undefined, state: journey.error instanceof ApiError && journey.error.status === 403 ? 'forbidden' : 'error' };
  return { key, journey: journey.data, state: 'ready' };
}

function Quiet({ state }: { state: 'loading' | 'none' | 'forbidden' | 'error' }) {
  const text = {
    loading: 'Loading…',
    none: 'This driver did not come through the recruiting journey, so there is no hiring record here.',
    forbidden: 'The hiring record needs the recruiting permission.',
    error: 'The hiring record could not be loaded. Try again.',
  }[state];
  return (
    <Card padding="md">
      <p className="text-sm text-nw-text-3">{text}</p>
    </Card>
  );
}

function OpenRecord({ candidateKey }: { candidateKey: string }) {
  return (
    <Link to="/hr/recruiting/$candidateId" params={{ candidateId: candidateKey }} className="text-sm font-semibold text-nw-accent-ink hover:underline">
      Open the hiring record
    </Link>
  );
}

/** Safety: the reports Safety ran and the consents the driver signed, with a staff-only audit. */
/** Safety tab: the driver's accident cases (accidents_v2, SPEC §6.3) above the hiring safety reports and consents. */
export function DriverSafetyTab({ driverId }: { driverId: string }) {
  if (!isEnabled('accidents_v2')) return <DriverSafetyJourney driverId={driverId} />;
  return (
    <div className="flex flex-col gap-4">
      <ProfileAccidents kind="driver" id={driverId} />
      <DriverSafetyJourney driverId={driverId} />
    </div>
  );
}

function DriverSafetyJourney({ driverId }: { driverId: string }) {
  const { key, journey: j, state } = useDriverJourney(driverId);
  const [audit, setAudit] = useState(false);
  if (state !== 'ready' || !j || !key) return <Quiet state={state === 'ready' ? 'error' : state} />;
  const s = j.consent.submission;
  return (
    <div className="flex flex-col gap-4" data-testid="driver-safety-tab">
      <Card padding="md" title="Safety reports" actions={<OpenRecord candidateKey={key} />}>
        {j.safety.reports.length === 0 ? (
          <p className="text-sm text-nw-text-3">No reports on file.</p>
        ) : (
          <ul>
            {j.safety.reports.map((r) => (
              <DocRow
                key={r.id}
                label={r.label}
                detail={`Received ${r.receivedOn ? longDate(r.receivedOn) : longDate(r.uploadedAt)} · ${r.uploadedByName}${r.reviewedByName ? ` · reviewed by ${r.reviewedByName}` : ''}`}
                status={<Pill family={r.result === 'clear' ? 'done' : r.result === 'prohibited' ? 'urgent' : 'warning'}>{r.result === 'clear' ? 'Clear' : r.result === 'findings' ? 'Findings' : r.result === 'prohibited' ? 'Prohibited' : 'Pending'}</Pill>}
                view={r.documentId ? { url: journeyUrls.safetyReport(key, r.id), title: r.label, fileName: r.fileName ?? `${r.kind}.pdf` } : null}
                download={r.documentId ? { url: journeyUrls.safetyReport(key, r.id), fileName: r.fileName ?? `${r.kind}.pdf` } : null}
              />
            ))}
          </ul>
        )}
        {j.safety.review ? (
          <p className="mt-2 text-xs text-nw-text-3">
            Safety review {j.safety.review.status.replace(/_/g, ' ')}
            {j.safety.review.decidedByName ? ` by ${j.safety.review.decidedByName}, ${longDate(j.safety.review.decidedAt ?? j.safety.review.openedAt)}` : ''}.
          </p>
        ) : null}
      </Card>
      <Card padding="md" title="Signed consents">
        {!s ? (
          <p className="text-sm text-nw-text-3">No signed consent on file.</p>
        ) : (
          <ul>
            {CONSENT_DOCUMENT_TYPES.map((type) => {
              const d = s.documents.find((x) => x.type === type);
              return d ? (
                <DocRow
                  key={type}
                  label={d.label}
                  detail={`Signed ${longDateTime(d.signedAt)} · ${s.signatureMethod === 'typed' ? 'typed' : 'drawn'} signature`}
                  status={<Pill family="done">Signed</Pill>}
                  view={{ url: journeyUrls.consentPdf(key, d.id), title: d.label, contentType: 'application/pdf', fileName: `${type}-consent-${s.reference}.pdf` }}
                  download={{ url: journeyUrls.consentPdf(key, d.id), fileName: `${type}-consent-${s.reference}.pdf`, label: 'PDF' }}
                />
              ) : (
                <DocRow key={type} label={CONSENT_DOCUMENT_LABELS[type]} detail="Not signed" status={<Pill family="neutral">Pending</Pill>} />
              );
            })}
          </ul>
        )}
        {s ? (
          <div className="mt-3 rounded-xl border border-nw-border">
            <button type="button" onClick={() => setAudit((a) => !a)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-nw-text" aria-expanded={audit}>
              <ChevronDown aria-hidden className={`size-4 transition-transform ${audit ? '' : '-rotate-90'}`} />
              Signature & audit
              <span className="text-xs font-normal text-nw-text-3">· staff only</span>
            </button>
            {audit ? (
              <div className="flex flex-col gap-1 border-t border-nw-border px-4 py-3">
                <Fact label="Reference">{s.reference}</Fact>
                <Fact label="Signed">{longDateTime(s.confirmedAt)}</Fact>
                <Fact label="Received by the TMS">{longDateTime(s.receivedAt)}</Fact>
                <Fact label="IP address">{s.audit.ipVisible ? (s.audit.ipAddress ?? 'Not recorded') : 'Restricted'}</Fact>
                <Fact label="Browser">{s.audit.userAgent ?? '—'}</Fact>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

/** Onboarding: the pre-hire checklist and the travel, as they stood. */
export function DriverOnboardingTab({ driverId }: { driverId: string }) {
  const { key, journey: j, state } = useDriverJourney(driverId);
  if (state !== 'ready' || !j || !key) return <Quiet state={state === 'ready' ? 'error' : state} />;
  return (
    <div className="flex flex-col gap-4" data-testid="driver-onboarding-tab">
      <Card padding="md" title="Onboarding checklist" actions={<OpenRecord candidateKey={key} />}>
        {j.onboarding.tasks.length === 0 ? (
          <p className="text-sm text-nw-text-3">No checklist.</p>
        ) : (
          <ul className="flex flex-col">
            {j.onboarding.tasks.map((t) => (
              <li key={t.id} className="flex items-center gap-3 border-b border-nw-border py-2 last:border-0">
                <span className="flex-1 text-sm text-nw-text">
                  {t.label}
                  {t.result ? <span className="text-nw-text-3"> · {t.result}</span> : null}
                </span>
                <Pill family={t.status === 'done' ? 'done' : t.status === 'failed' ? 'urgent' : 'neutral'}>{t.status.replace(/_/g, ' ')}</Pill>
                <span className="w-28 text-right text-xs text-nw-text-3">{t.completedAt ? longDate(t.completedAt) : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card padding="md" title="Travel">
        {j.travel.length === 0 ? (
          <p className="text-sm text-nw-text-3">No travel booked.</p>
        ) : (
          <ul className="flex flex-col">
            {j.travel.map((t) => (
              <li key={t.id} className="flex items-center gap-3 border-b border-nw-border py-2 text-sm last:border-0">
                <span className="flex-1 text-nw-text">
                  {TRAVEL_KIND_LABELS[t.kind]}
                  {t.vendor ? ` · ${t.vendor}` : ''}
                  {t.routeFrom || t.routeTo ? ` · ${t.routeFrom ?? '?'} → ${t.routeTo ?? '?'}` : ''}
                </span>
                <Pill family={t.status === 'cancelled' ? 'urgent' : 'done'}>{t.status}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Costs: every recruiting cost with who paid, whose cost, approval, payment and Accounting state. */
export function DriverCostsTab({ driverId }: { driverId: string }) {
  const { key, journey: j, state } = useDriverJourney(driverId);
  if (state !== 'ready' || !j || !key) return <Quiet state={state === 'ready' ? 'error' : state} />;
  const s = j.costs.summary;
  return (
    <Card padding="md" title="Recruiting costs" actions={<OpenRecord candidateKey={key} />}>
      <div className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" data-testid="driver-costs-summary">
        <Fact label="Spent">{formatMoney(s.spent)}</Fact>
        <Fact label="Paid">{formatMoney(s.paid)}</Fact>
        <Fact label="Company cost">{formatMoney(s.companyCost)}</Fact>
        <Fact label="Driver cost">{formatMoney(s.driverCost)}</Fact>
      </div>
      {j.costs.entries.length === 0 ? (
        <p className="text-sm text-nw-text-3">No costs recorded.</p>
      ) : (
        <ul className="flex flex-col">
          {j.costs.entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 border-b border-nw-border py-2 text-sm last:border-0">
              <span className="flex-1 text-nw-text">
                {e.label}
                {e.vendor ? ` · ${e.vendor}` : ''} <span className="text-nw-text-3">· {longDate(e.incurredOn)} · {COST_TREATMENT_LABELS[e.treatment]}</span>
              </span>
              <Pill family={e.approvalStatus === 'approved' ? 'done' : e.approvalStatus === 'rejected' ? 'urgent' : 'neutral'}>{e.approvalStatus}</Pill>
              {e.treatment !== 'personal' && e.source === 'manual' ? <Pill family={e.paymentStatus === 'paid' ? 'done' : 'warning'}>{e.paymentStatus}</Pill> : null}
              <span className="w-24 text-right font-semibold tabular-nums text-nw-text">{formatMoney(e.amount)}</span>
              {e.accounting.note ? <span className="w-full text-xs text-nw-text-3">{e.accounting.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
