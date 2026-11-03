import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Check, ShieldQuestion, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  API_PREFIX,
  CONSENT_DOCUMENT_LABELS,
  type SafetyDeskDetail,
  type SafetyDeskList,
  type SafetyDeskRow,
} from '@neway/shared';
import { Alert, Button, FormField, Modal, PageHeader, Select, Textarea, cn, useToast } from '@/design-system';
import { PermissionGate } from '@/features/admin/components/AdminKit';
import { usePermissionCheck } from '@/features/admin/useAdmin';
import { DocRow, Pill } from '@/features/hr/recruit/journey/JourneyKit';
import { errorText } from '@/features/hr/recruit/journey/journey-utils';
import { longDate, longDateTime } from '@/features/hr/recruit/recruit-format';
import { apiGet, apiPost } from '@/lib/api-client';
import { prefetchFileBlobs } from '@/lib/files';
import { ScreeningReports } from './ScreeningReports';

const D = '/hiring/safety-desk';
const enc = encodeURIComponent;
const fileUrl = (path: string) => `/${API_PREFIX}${D}${path}`;
function useDesk() {
  return useQuery({ queryKey: ['safety-desk'], queryFn: () => apiGet<SafetyDeskList>(D), refetchInterval: 60_000 });
}
function useDeskDetail(caseId: string | null) {
  return useQuery({ queryKey: ['safety-desk', caseId], queryFn: () => apiGet<SafetyDeskDetail>(`${D}/${enc(caseId as string)}`), enabled: Boolean(caseId) });
}
function useDeskMutation<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['safety-desk'] });
      void qc.invalidateQueries({ queryKey: ['hr'] });
    },
  });
}

export function SafetyHiringPage() {
  const check = usePermissionCheck('compliance.manage');
  return (
    <PermissionGate check={check} permission="compliance.manage" what="hiring decisions">
      <SafetyHiringContent />
    </PermissionGate>
  );
}

/**
 * Safety › Hiring decisions (owner, 2026-10-11): everyone Recruiting sent to Safety, waiting for one
 * decision — Qualified or Not qualified — with the consents they signed and the reports Safety adds.
 * Until Safety qualifies a candidate, Recruiting cannot send the application.
 */
function SafetyHiringContent() {
  const desk = useDesk();
  const raw = useSearch({ strict: false }) as { case?: string; view?: string };
  const navigate = useNavigate();
  const view = raw.view === 'decided' ? 'decided' : 'waiting';
  const rows = desk.data ? desk.data[view] : [];
  const selected = raw.case ?? (rows[0]?.caseId ?? null);
  const go = (patch: { case?: string; view?: string }) => void navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, ...patch })) as never, replace: true });

  return (
    <div className="flex flex-col gap-5" data-testid="safety-hiring">
      <PageHeader title="Hiring decisions" description="Candidates Recruiting sent to Safety, with the signed consents and the reports Recruiting filed. Mark Qualified or Not qualified, or check with insurance first." />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <section className="flex h-fit flex-col rounded-[10px] border border-nw-border bg-nw-panel">
          <div className="flex border-b border-nw-border" role="tablist">
            {(['waiting', 'decided'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => go({ view: v === 'waiting' ? undefined : v, case: undefined })}
                className={cn('-mb-px flex h-11 flex-1 items-center justify-center gap-2 border-b-2 text-sm', view === v ? 'border-nw-accent font-semibold text-nw-text' : 'border-transparent text-nw-text-3 hover:text-nw-text-2')}
                data-testid={`desk-tab-${v}`}
              >
                {v === 'waiting' ? 'Waiting for decision' : 'Decided'}
                {desk.data ? (
                  <span className={cn('rounded-full px-2 text-xs font-bold', v === 'waiting' && desk.data.waiting.length > 0 ? 'bg-nw-urgent-bg text-nw-urgent-text' : 'bg-nw-subtle text-nw-text-3')}>{desk.data[v].length}</span>
                ) : null}
              </button>
            ))}
          </div>
          {desk.isPending ? (
            <p className="px-4 py-6 text-sm text-nw-text-3">Loading…</p>
          ) : desk.isError ? (
            <p className="px-4 py-6 text-sm text-nw-urgent-text">The list could not be loaded. {errorText(desk.error)}</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-nw-text-3">{view === 'waiting' ? 'Nobody is waiting for Safety.' : 'No decisions yet.'}</p>
          ) : (
            <ul data-testid="desk-list">
              {rows.map((r) => (
                <li key={r.caseId}>
                  <button
                    type="button"
                    onClick={() => go({ case: r.caseId })}
                    className={cn('flex w-full flex-col items-start gap-1 border-b border-nw-border px-4 py-3 text-left last:border-0', selected === r.caseId ? 'bg-nw-accent-tint' : 'hover:bg-nw-subtle')}
                    data-testid="desk-row"
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-nw-text">{r.name}</span>
                      <DecisionPill row={r} />
                    </span>
                    <span className="text-xs text-nw-text-3">
                      Sent {longDate(r.sentAt)} by {r.sentByName} · {r.consentsSigned.length} consents signed · {r.reportsWithResult} reports reviewed
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="min-w-0">{selected ? <DeskDetail caseId={selected} /> : <p className="text-sm text-nw-text-3">Choose a candidate.</p>}</div>
      </div>
    </div>
  );
}

function DecisionPill({ row }: { row: SafetyDeskRow }) {
  if (row.status === 'approved') return <Pill family="done">Qualified</Pill>;
  if (row.status === 'declined') return <Pill family="urgent">Not qualified</Pill>;
  if (row.insuranceStatus === 'pending') return <Pill family="info">Checking with insurance</Pill>;
  return <Pill family="warning">Waiting</Pill>;
}

function DeskDetail({ caseId }: { caseId: string }) {
  const { toast } = useToast();
  const detail = useDeskDetail(caseId);
  // The reports and consent files start loading as the case opens, so View shows them at once
  // instead of after a long wait on a slow link (owner, 2026-10-23). Memory only.
  const data = detail.data;
  useEffect(() => {
    if (!data) return;
    const reports = data.safety.reports.filter((r) => r.documentId).map((r) => `/${API_PREFIX}${D}/${enc(caseId)}/reports/${encodeURIComponent(r.id)}/file`);
    const sub = data.consent.submission;
    const consent = sub ? [...sub.files.map((f) => fileUrl(`/${enc(caseId)}/consent/files/${enc(f.id)}`)), ...sub.documents.map((d) => fileUrl(`/${enc(caseId)}/consent/documents/${enc(d.id)}/pdf`))] : [];
    void prefetchFileBlobs([...reports, ...consent]);
  }, [data, caseId]);
  const [declining, setDeclining] = useState(false);
  const [insurance, setInsurance] = useState<'ask' | 'answer' | null>(null);
  const qualify = useDeskMutation((version: number) => apiPost<SafetyDeskRow>(`${D}/${enc(caseId)}/decision`, { status: 'approved', note: null, version }));
  if (detail.isPending) return <p className="text-sm text-nw-text-3">Loading…</p>;
  if (detail.isError || !detail.data) return <Alert tone="danger" title="This candidate could not be loaded" description={errorText(detail.error)} />;
  const { row, consent, safety } = detail.data;
  const review = safety.review;
  const decided = row.status === 'approved' || row.status === 'declined';
  const missing = (['mvr', 'psp'] as const).filter((k) => !safety.reports.some((r) => r.kind === k && r.result !== 'pending'));
  const prohibited = safety.reports.some((r) => r.result === 'prohibited');
  const ins = review?.insurance ?? null;
  const insuranceBlocks = ins?.status === 'pending' || ins?.status === 'declined';
  const canQualify = !decided && missing.length === 0 && !prohibited && !insuranceBlocks;
  const s = consent.submission;

  return (
    <section className="flex flex-col gap-5 rounded-[10px] border border-nw-border bg-nw-panel p-6" data-testid="desk-detail">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold text-nw-text">{row.name}</h2>
          <p className="mt-1 text-sm text-nw-text-3">
            {[row.phone, row.email].filter(Boolean).join(' · ')}
          </p>
          <p className="mt-1 text-sm text-nw-text-2">
            Sent to Safety {longDateTime(row.sentAt)} by {row.sentByName}
            {row.requestNote ? ` · “${row.requestNote}”` : ''}
          </p>
        </div>
        <Link to="/hr/recruiting/$candidateId" params={{ candidateId: row.key }} className="text-sm font-semibold text-nw-accent-ink hover:underline">
          Open candidate
        </Link>
      </header>

      {decided ? (
        <Alert tone={row.status === 'approved' ? 'success' : 'danger'} title={row.status === 'approved' ? 'Qualified' : 'Not qualified'}>
          {`${row.decidedByName ?? 'Safety'}, ${row.decidedAt ? longDateTime(row.decidedAt) : ''}${row.decisionNote ? ` — ${row.decisionNote}` : ''}`}
        </Alert>
      ) : null}

      <div>
        <h3 className="mb-1 text-xs font-bold tracking-wide text-nw-text-3 uppercase">Signed consents</h3>
        {!s ? (
          <p className="text-sm text-nw-text-3">No signed consent on file.</p>
        ) : (
          <ul className="rounded-[10px] border border-nw-border px-3" data-testid="desk-consents">
            {s.documents.map((d) => (
              <DocRow
                key={d.id}
                label={CONSENT_DOCUMENT_LABELS[d.type]}
                detail={`Signed ${longDateTime(d.signedAt)}${d.scope ? ` · ${d.scope}` : ''}`}
                status={<Pill family="done">Signed</Pill>}
                view={{ url: fileUrl(`/${enc(caseId)}/consent/documents/${enc(d.id)}/pdf`), title: CONSENT_DOCUMENT_LABELS[d.type], contentType: 'application/pdf', fileName: `${d.type}-consent-${s.reference}.pdf` }}
                download={{ url: fileUrl(`/${enc(caseId)}/consent/documents/${enc(d.id)}/pdf`), fileName: `${d.type}-consent-${s.reference}.pdf`, label: 'PDF' }}
                testId={`desk-consent-${d.type}`}
              />
            ))}
            {s.files.map((f) => (
              <DocRow
                key={f.id}
                label={f.label}
                detail={f.fileName}
                status={<Pill family="done">Received</Pill>}
                view={{ url: fileUrl(`/${enc(caseId)}/consent/files/${enc(f.id)}`), title: f.label, contentType: f.contentType, fileName: f.fileName }}
                download={{ url: fileUrl(`/${enc(caseId)}/consent/files/${enc(f.id)}`), fileName: f.fileName }}
              />
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-xs font-bold tracking-wide text-nw-text-3 uppercase">Reports</h3>
        {/* Recruiting files the reports (owner, 2026-10-12); Safety reads them here and decides. */}
        <ScreeningReports base={`${D}/${enc(caseId)}`} safety={safety} editable={false} testPrefix="desk" />
      </div>

      {!decided ? (
        <div className="flex flex-col gap-2 border-t border-nw-border pt-5" data-testid="desk-decision">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" icon={<X />} className="border-nw-urgent-border text-nw-urgent-text" onClick={() => setDeclining(true)} data-testid="desk-not-qualified">
              Not qualified
            </Button>
            <Button variant="outline" icon={<ShieldQuestion />} onClick={() => setInsurance(ins?.status === 'pending' ? 'answer' : 'ask')} data-testid="desk-insurance">
              {ins?.status === 'pending' ? 'Insurance response' : 'Insurance check'}
            </Button>
            <Button
              variant="primary"
              icon={<Check />}
              disabled={!canQualify}
              loading={qualify.isPending}
              onClick={() =>
                qualify.mutate(review?.version ?? 0, {
                  onSuccess: () => toast({ tone: 'success', title: 'Qualified', description: 'Recruiting can now send the application.' }),
                  onError: (e) => toast({ tone: 'danger', title: 'Not saved', description: errorText(e) }),
                })
              }
              data-testid="desk-qualified"
            >
              Qualified
            </Button>
          </div>
          {ins ? (
            <p className="text-sm text-nw-text-2" data-testid="desk-insurance-status">
              <Pill family={ins.status === 'approved' ? 'done' : ins.status === 'declined' ? 'urgent' : 'warning'}>
                {ins.status === 'approved' ? 'Insurance approved' : ins.status === 'declined' ? 'Insurance declined' : 'Checking with insurance'}
              </Pill>{' '}
              {ins.status === 'pending' ? `Asked ${ins.requestedAt ? longDateTime(ins.requestedAt) : ''} by ${ins.requestedBy ?? 'Safety'}` : `Answered ${ins.respondedAt ? longDateTime(ins.respondedAt) : ''} · ${ins.respondedBy ?? 'Safety'}`}
              {ins.note ? ` — ${ins.note}` : ''}
            </p>
          ) : null}
          <p className="text-xs text-nw-text-3">
            {ins?.status === 'pending'
              ? 'Waiting for the insurance answer: record it before Qualified.'
              : ins?.status === 'declined'
                ? 'The insurer declined this driver.'
                : prohibited
              ? 'A Clearinghouse result shows a prohibition: this candidate cannot be qualified.'
              : missing.length > 0
                ? `Qualified needs a reviewed ${missing.map((m) => m.toUpperCase()).join(' and ')} report.`
                : 'Qualified opens the application for Recruiting. The Clearinghouse queries are optional.'}
          </p>
        </div>
      ) : null}

      {declining && review ? <DeclineDialog caseId={caseId} version={review.version} onClose={() => setDeclining(false)} /> : null}
      {insurance && review ? <InsuranceDialog caseId={caseId} version={review.version} mode={insurance} onClose={() => setInsurance(null)} /> : null}
    </section>
  );
}

/**
 * Insurance check (owner, 2026-10-12): Safety asks the insurer (Recruiting is told the driver is
 * being checked with insurance), then records the insurer's answer.
 */
function InsuranceDialog({ caseId, version, mode, onClose }: { caseId: string; version: number; mode: 'ask' | 'answer'; onClose: () => void }) {
  const { toast } = useToast();
  const [step, setStep] = useState<'ask' | 'answer'>(mode);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<'approved' | 'declined'>('approved');
  const ask = useDeskMutation(() => apiPost<SafetyDeskRow>(`${D}/${enc(caseId)}/insurance`, { note: note.trim() || null, version }));
  const answer = useDeskMutation((v: number) => apiPost<SafetyDeskRow>(`${D}/${enc(caseId)}/insurance/response`, { result, note: note.trim() || null, version: v }));
  const error = ask.error ?? answer.error;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={step === 'ask' ? 'Insurance check' : 'Insurance response'}
      description={step === 'ask' ? 'Recruiting is told that Safety is checking this driver with insurance.' : 'What did the insurer answer? Recruiting is told.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {step === 'ask' ? (
            <>
              <Button variant="outline" onClick={() => { setStep('answer'); setNote(''); }} data-testid="desk-insurance-have-answer">
                I already have the answer
              </Button>
              <Button variant="primary" loading={ask.isPending} onClick={() => ask.mutate(undefined, { onSuccess: () => { toast({ tone: 'success', title: 'Checking with insurance', description: 'Recruiting was told.' }); onClose(); } })} data-testid="desk-insurance-ask">
                Send to insurance
              </Button>
            </>
          ) : (
            <Button variant={result === 'declined' ? 'danger' : 'primary'} disabled={result === 'declined' && note.trim().length < 3} loading={answer.isPending} onClick={() => answer.mutate(version, { onSuccess: () => { toast({ tone: 'success', title: `Insurance ${result}` }); onClose(); } })} data-testid="desk-insurance-answer">
              Save the answer
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <Alert tone="danger" title="Not saved" description={errorText(error)} /> : null}
        {step === 'answer' ? (
          <FormField label="Insurance answer" required>
            <Select value={result} onValueChange={(v) => setResult(v as 'approved' | 'declined')} options={[{ value: 'approved', label: 'Approved — the insurer accepts the driver' }, { value: 'declined', label: 'Declined — the insurer does not accept the driver' }]} />
          </FormField>
        ) : null}
        <FormField label={step === 'ask' ? 'Note (optional)' : result === 'declined' ? 'What the insurer said' : 'Note (optional)'} required={step === 'answer' && result === 'declined'}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
        </FormField>
      </div>
    </Modal>
  );
}

function DeclineDialog({ caseId, version, onClose }: { caseId: string; version: number; onClose: () => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const save = useDeskMutation(() => apiPost(`${D}/${enc(caseId)}/decision`, { status: 'declined', note: note.trim(), version }));
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Not qualified"
      description="The candidate is closed and Recruiting is told. Everything is kept and audited."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={note.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => { toast({ tone: 'success', title: 'Marked not qualified' }); onClose(); } })} data-testid="desk-confirm-decline">
            Not qualified
          </Button>
        </>
      }
    >
      {save.error ? <Alert tone="danger" title="Not saved" description={errorText(save.error)} /> : null}
      <FormField label="Why" required>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
      </FormField>
    </Modal>
  );
}

