import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Upload } from 'lucide-react';
import { useState } from 'react';
import {
  API_PREFIX,
  FMCSA_FULL_QUERY_STATUSES,
  SAFETY_CHECK_STATUS_LABELS,
  type CandidateSafetyView,
  type SafetyCheckKind,
  type SafetyCheckView,
  type SafetyReportResult,
  type SafetyReportView,
} from '@neway/shared';
import { Alert, Button, DatePicker, FormField, Modal, Select, useToast, type StatusSymbolFamily } from '@/design-system';
import { DocRow, FilePick, Pill } from '@/features/hr/recruit/journey/JourneyKit';
import { errorText, fileToBase64 } from '@/features/hr/recruit/journey/journey-utils';
import { longDate } from '@/features/hr/recruit/recruit-format';
import { apiPatch, apiPost } from '@/lib/api-client';
import { today as companyToday } from '@/lib/clock';

const CLEARINGHOUSE_URL = 'https://clearinghouse.fmcsa.dot.gov/';

const REPORT_RESULT: Record<SafetyReportResult, { family: StatusSymbolFamily; word: string }> = {
  pending: { family: 'warning', word: 'Received · no result yet' },
  clear: { family: 'done', word: 'Clear' },
  findings: { family: 'warning', word: 'Findings' },
  prohibited: { family: 'urgent', word: 'Prohibited' },
};

/** MVR and PSP qualify a driver; both Clearinghouse queries are optional (owner, 2026-10-12). */
const ROWS: { kind: SafetyCheckKind; label: string; note: string }[] = [
  { kind: 'mvr', label: 'MVR', note: 'Required to qualify' },
  { kind: 'psp', label: 'PSP', note: 'Required to qualify' },
  { kind: 'clearinghouse_limited', label: 'Clearinghouse — limited query', note: 'Optional · under the limited consent the driver signed' },
  { kind: 'clearinghouse_full', label: 'Clearinghouse — pre-employment full query', note: "Optional · runs on the driver's own consent inside the Clearinghouse" },
];

const FULL_QUERY_LABEL: Record<string, string> = {
  not_requested: 'Driver consent: not requested',
  requested: 'Driver consent: requested in the Clearinghouse',
  received: 'Driver consent: received in the Clearinghouse',
  declined: 'Driver consent: declined',
};

function useScreeningMutation<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['safety-desk'] });
      void qc.invalidateQueries({ queryKey: ['hr'] });
    },
  });
}

/**
 * The screening reports (MVR, PSP and the Clearinghouse queries). Recruiting runs the checks and
 * files the reports with their result (owner, 2026-10-12); Safety reads them and decides. `base`
 * is the API path the candidate's safety lives under (the recruiter's journey or Safety's desk).
 */
export function ScreeningReports({ base, safety, editable, testPrefix }: { base: string; safety: CandidateSafetyView; editable: boolean; testPrefix: string }) {
  const { toast } = useToast();
  const [uploading, setUploading] = useState<SafetyCheckKind | null>(null);
  const review = safety.review;
  const fullQuery = useScreeningMutation((a: { status: string; version: number }) => apiPost(`${base}/full-query`, a));
  const report = (kind: SafetyCheckKind) => safety.reports.filter((r) => r.kind === kind).at(-1) ?? null;
  return (
    <>
      <ul className="rounded-[10px] border border-nw-border" data-testid={`${testPrefix}-reports`}>
        {ROWS.map((r) => (
          <ReportLine
            key={r.kind}
            base={base}
            kind={r.kind}
            label={r.label}
            note={r.note}
            report={report(r.kind)}
            check={safety.checks.find((c) => c.kind === r.kind) ?? null}
            editable={editable}
            testPrefix={testPrefix}
            onUpload={() => setUploading(r.kind)}
            extra={
              r.kind === 'clearinghouse_full' && review ? (
                editable ? (
                  <div className="w-64">
                    <Select
                      aria-label="Driver's full-query consent"
                      value={review.fmcsaFullQueryStatus}
                      onValueChange={(v) => fullQuery.mutate({ status: v, version: review.version }, { onError: (e) => toast({ tone: 'danger', title: 'Not saved', description: errorText(e) }) })}
                      options={FMCSA_FULL_QUERY_STATUSES.map((x) => ({ value: x, label: FULL_QUERY_LABEL[x] ?? x }))}
                    />
                  </div>
                ) : (
                  <span className="text-xs text-nw-text-3">{FULL_QUERY_LABEL[review.fmcsaFullQueryStatus] ?? review.fmcsaFullQueryStatus}</span>
                )
              ) : null
            }
          />
        ))}
      </ul>
      {uploading ? <UploadDialog base={base} kind={uploading} onClose={() => setUploading(null)} testPrefix={testPrefix} /> : null}
    </>
  );
}

function ReportLine({
  base,
  kind,
  label,
  note,
  report: r,
  check,
  editable,
  testPrefix,
  onUpload,
  extra,
}: {
  base: string;
  kind: SafetyCheckKind;
  label: string;
  note: string;
  report: SafetyReportView | null;
  check: SafetyCheckView | null;
  editable: boolean;
  testPrefix: string;
  onUpload: () => void;
  extra: React.ReactNode;
}) {
  const { toast } = useToast();
  const setResult = useScreeningMutation((result: SafetyReportResult) => apiPatch(`${base}/reports/${encodeURIComponent((r as SafetyReportView).id)}`, { result, note: null, version: (r as SafetyReportView).version }));
  const requested = useScreeningMutation(() => apiPost(`${base}/checks`, { kind }));
  const status = r ? REPORT_RESULT[r.result] : null;
  return (
    <li className="flex flex-col gap-2 border-b border-nw-border px-4 py-3 last:border-0" data-testid={`${testPrefix}-report-${kind}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-nw-text">{label}</p>
          <p className="text-xs text-nw-text-3">
            {note}
            {check && check.status !== 'not_requested' && !r ? ` · ${SAFETY_CHECK_STATUS_LABELS[check.status]}${check.requestedAt ? ` ${longDate(check.requestedAt)}` : ''}` : ''}
            {r ? ` · received ${longDate(r.receivedOn ?? r.uploadedAt)} · ${r.uploadedByName}${r.reviewedByName ? ` · result by ${r.reviewedByName}` : ''}` : ''}
          </p>
        </div>
        {status ? <Pill family={status.family}>{status.word}</Pill> : <Pill family="neutral">Not on file</Pill>}
        {kind.startsWith('clearinghouse') && editable ? (
          <Button variant="ghost" size="sm" icon={<ExternalLink />} asChild>
            <a href={CLEARINGHOUSE_URL} target="_blank" rel="noopener noreferrer">
              Open Clearinghouse
            </a>
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {r?.documentId ? (
          <ul className="contents">
            <DocRow label="Report" view={{ url: `/${API_PREFIX}${base}/reports/${encodeURIComponent(r.id)}/file`, title: label, fileName: r.fileName ?? `${kind}.pdf` }} />
          </ul>
        ) : null}
        {r && editable
          ? (['clear', 'findings', 'prohibited'] as const).map((x) => (
              <Button
                key={x}
                variant={r.result === x ? 'primary' : 'outline'}
                size="sm"
                loading={setResult.isPending && setResult.variables === x}
                onClick={() => setResult.mutate(x, { onError: (e) => toast({ tone: 'danger', title: 'Not saved', description: errorText(e) }) })}
                data-testid={`${testPrefix}-result-${kind}-${x}`}
              >
                {REPORT_RESULT[x].word}
              </Button>
            ))
          : null}
        {editable ? (
          <Button variant="outline" size="sm" icon={<Upload />} onClick={onUpload} data-testid={`${testPrefix}-upload-${kind}`}>
            {r ? 'Replace report' : 'Upload report'}
          </Button>
        ) : null}
        {editable && !r && check?.status === 'not_requested' && !check.blockedReason ? (
          <Button variant="ghost" size="sm" loading={requested.isPending} onClick={() => requested.mutate(undefined, { onError: (e) => toast({ tone: 'danger', title: 'Not saved', description: errorText(e) }) })}>
            Mark requested
          </Button>
        ) : null}
        {extra}
      </div>
    </li>
  );
}

function UploadDialog({ base, kind, onClose, testPrefix }: { base: string; kind: SafetyCheckKind; onClose: () => void; testPrefix: string }) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [receivedOn, setReceivedOn] = useState(companyToday());
  const upload = useScreeningMutation(async () => {
    if (!file) throw new Error('Choose the report file');
    return apiPost(`${base}/reports`, { kind, result: 'pending', receivedOn, note: null, fileName: file.name, contentType: file.type || 'application/pdf', content: await fileToBase64(file) });
  });
  const label = ROWS.find((r) => r.kind === kind)?.label ?? kind;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Upload ${label} report`}
      description="The file goes into the driver's qualification file. Then mark it Clear, Findings or Prohibited; Safety sees it on Hiring decisions."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!file} loading={upload.isPending} onClick={() => upload.mutate(undefined, { onSuccess: () => { toast({ tone: 'success', title: 'Report added' }); onClose(); } })} data-testid={`${testPrefix}-confirm-upload`}>
            Upload
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {upload.error ? <Alert tone="danger" title="Not added" description={errorText(upload.error, upload.error instanceof Error ? upload.error.message : undefined)} /> : null}
        <FilePick label="Report file (PDF, JPG or PNG)" file={file} onFile={setFile} testId={`${testPrefix}-report-file`} />
        <FormField label="Received on">
          <DatePicker aria-label="Received on" value={receivedOn} onIsoChange={setReceivedOn} />
        </FormField>
      </div>
    </Modal>
  );
}
