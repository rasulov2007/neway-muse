import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Plus, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ComplianceDocument, SafetyDrugTest, TestResult } from '@neway/shared';
import { RANDOM_TEST_RESULTS } from '@neway/shared';
import {
  Button,
  Card,
  DatePicker,
  FormField,
  Modal,
  Select,
  StatusBadge,
  Textarea,
  cn,
} from '@/design-system';
import { DocumentViewer } from '@/features/documents';
import { toBase64 } from '@/features/operations/credential-ocr';
import { listComplianceDocuments } from '@/features/safety/compliance-api';
import { safetyApi, useDriverDrugTests, useSafetyWrite } from '@/features/safety/v2/api';
import { isEnabled } from '@/lib/feature-flags';
import { today } from '@/lib/clock';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { useHasPermission } from './usePermissions';

const MAX_BYTES = 20 * 1024 * 1024;

/** A result as a status: symbol + word + colour, on the existing testing families. */
export const RANDOM_RESULT_BADGE: Record<TestResult, { status: string; label: string }> = {
  negative: { status: 'result_recorded', label: 'Negative' },
  positive: { status: 'required', label: 'Positive' },
  refused: { status: 'not_completed', label: 'Refused' },
  cancelled: { status: 'exception_reviewed', label: 'Cancelled' },
  pending: { status: 'result_pending', label: 'Result pending' },
};

const RESULT_OPTIONS = RANDOM_TEST_RESULTS.map((r) => ({ value: r, label: RANDOM_RESULT_BADGE[r].label }));

/**
 * Random drug tests on the driver's Documents tab (owner, 2026-10-24): every random test the
 * driver was selected for, with its collection date, result and paper, and "Submit random test".
 * The paper is a `random_drug_test` document in the qualification file; the result lives on the
 * test record (DAT-…), where the server redacts it for anybody without `safety_testing.view`.
 */
export function RandomDrugTestsCard({ driverId, driverName }: { driverId: string; driverName: string }) {
  const canManageTests = useHasPermission('safety_testing.manage');
  const canManageSafety = useHasPermission('safety.manage');
  const canViewSafety = useHasPermission('safety.view');
  const canSubmit = canManageTests && canManageSafety;
  const canReadTests = canViewSafety && isEnabled('safety_v2');
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<ComplianceDocument | null>(null);

  const papers = useQuery({
    queryKey: ['compliance-documents', 'driver', driverId, 'random_drug_test'],
    queryFn: () => listComplianceDocuments({ ownerType: 'driver', ownerId: driverId, requirementCode: 'random_drug_test' }),
  });
  const tests = useDriverDrugTests(driverId, canReadTests);
  const random = useMemo(
    () => (tests.data ?? []).filter((t) => t.testType === 'random'),
    [tests.data],
  );

  // One row per paper, newest collection first, joined to its test by the number in its notes/title.
  const rows = useMemo(() => {
    const docs = [...(papers.data ?? [])].sort((a, b) =>
      (b.issuedOn ?? b.uploadedAt).localeCompare(a.issuedOn ?? a.uploadedAt),
    );
    return docs.map((doc) => ({
      doc,
      test: random.find((t) => doc.title.includes(t.number)) ?? null,
    }));
  }, [papers.data, random]);

  return (
    <Card
      padding="none"
      title="Random drug and alcohol tests"
      description="Random controlled-substances tests (49 CFR 382.305): collection date, result and the lab paper."
      actions={
        canSubmit && isEnabled('safety_v2') ? (
          <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
            Submit random test
          </Button>
        ) : null
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-nw-border bg-nw-subtle text-left text-xs font-semibold text-nw-text-2">
              <th className="px-4 py-2">Collected</th>
              <th className="px-3 py-2">Result</th>
              <th className="px-3 py-2">Paper</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {papers.isLoading ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted">
                  No random test on file.
                </td>
              </tr>
            ) : (
              rows.map(({ doc, test }) => (
                <tr key={doc.id} className="border-b border-nw-border last:border-b-0">
                  <td className="px-4 py-2.5 font-medium text-ink">
                    <span className="flex items-center gap-2">
                      <FlaskConical className="size-4 shrink-0 text-nw-text-3" aria-hidden />
                      {doc.issuedOn ? formatIsoDate(doc.issuedOn) : formatDateTime(doc.uploadedAt)}
                    </span>
                    {test ? <span className="mt-0.5 block pl-6 text-xs text-nw-text-3">{test.number} · {test.substance === 'alcohol' ? 'Alcohol' : 'Drug'}</span> : null}
                  </td>
                  <td className="px-3 py-2.5">
                    {test === null ? (
                      <span className="text-xs text-muted">{canReadTests && tests.isLoading ? 'Loading…' : 'On the test record'}</span>
                    ) : test.resultRestricted || test.result === null ? (
                      <StatusBadge status="result_restricted" size="sm" />
                    ) : (
                      <StatusBadge status={RANDOM_RESULT_BADGE[test.result].status} label={RANDOM_RESULT_BADGE[test.result].label} size="sm" />
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-nw-text-1">{doc.fileName}</td>
                  <td className="px-3 py-2.5 text-right">
                    {doc.hasFile ? (
                      <Button size="sm" variant="link" onClick={() => setViewing(doc)}>
                        View
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {adding ? <SubmitRandomTestDialog driverId={driverId} driverName={driverName} onClose={() => setAdding(false)} /> : null}
      {viewing ? (
        <DocumentViewer
          source={{ kind: 'compliance', id: viewing.id }}
          title={viewing.title}
          subtitle={`${viewing.fileName} · uploaded ${formatDateTime(viewing.uploadedAt)} by ${viewing.uploadedBy}`}
          contentType={viewing.contentType}
          fileName={viewing.fileName}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </Card>
  );
}

/** Collection date, result, the paper and a note: the four things a random test arrives with. */
export function SubmitRandomTestDialog({
  driverId,
  driverName,
  onClose,
}: {
  driverId: string;
  driverName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [collectedOn, setCollectedOn] = useState(today());
  const [result, setResult] = useState<TestResult>('negative');
  // Drug or alcohol (owner, 2026-10-24: both are random-tested).
  const [substance, setSubstance] = useState<'drug' | 'alcohol'>('drug');
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useSafetyWrite(
    async () => {
      if (!file) throw new Error('Choose the lab or MRO paper first');
      return safetyApi.post<{ test: SafetyDrugTest; document: ComplianceDocument }>('/tests/random', {
        driverId,
        substance,
        collectedOn,
        result,
        notes: notes.trim() || null,
        fileName: file.name,
        contentType: file.type || 'application/pdf',
        content: await toBase64(file),
      });
    },
    (r) => `Random test ${r.test.number} recorded`,
  );
  const choose = (next: File | null) => {
    if (next && next.size > MAX_BYTES) return setError('That file is larger than 20 MB.');
    setError(null);
    setFile(next);
  };
  const submit = () =>
    save.mutate(undefined, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: ['compliance-documents'] });
        onClose();
      },
      onError: (e) => setError(e instanceof Error ? e.message : 'The test could not be recorded.'),
    });

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="Submit random test"
      description={`${driverName} · dates are US Eastern`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!file || !collectedOn} onClick={submit}>
            Submit test
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}
        <FormField label="Test" required>
          <Select aria-label="Test" value={substance} onValueChange={(v) => setSubstance(v === 'alcohol' ? 'alcohol' : 'drug')} options={[{ value: 'drug', label: 'Drug test' }, { value: 'alcohol', label: 'Alcohol test' }]} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Collection date" required>
            <DatePicker aria-label="Collection date" value={collectedOn} onIsoChange={(iso) => setCollectedOn(iso ?? '')} />
          </FormField>
          <FormField label="Result" required>
            <Select aria-label="Result" value={result} onValueChange={(v) => setResult(v as TestResult)} options={RESULT_OPTIONS} />
          </FormField>
        </div>
        <div
          className={cn(
            'flex min-h-20 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-4 text-center',
            file ? 'border-success-border bg-success-soft' : 'border-nw-accent/40 bg-nw-accent-tint/40',
          )}
        >
          <input
            ref={fileInput}
            type="file"
            className="sr-only"
            aria-label="Test paper"
            accept=".pdf,.png,.jpg,.jpeg"
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
          />
          <Upload className="size-6 text-nw-accent" aria-hidden />
          <span className="text-sm font-semibold text-ink">
            {file ? file.name : 'Lab or MRO result paper '}
            <button type="button" className="text-nw-accent-ink underline" onClick={() => fileInput.current?.click()}>
              {file ? 'choose another file' : 'browse files'}
            </button>
          </span>
          <span className="text-xs text-muted">PDF, JPG or PNG · Maximum 20 MB</span>
        </div>
        <FormField label="Notes (optional)">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Selection batch, collection site…" />
        </FormField>
        <p className="text-xs text-muted">The result is kept on the test record and shown only to people allowed to see test results.</p>
      </div>
    </Modal>
  );
}
