import { Link } from '@tanstack/react-router';
import { CircleAlert, Clock, FileQuestion, Plus, Search, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  DRUG_ALCOHOL_TEST_TYPES,
  DRUG_ALCOHOL_TEST_TYPE_LABEL,
  TEST_PROGRESS_LABEL,
  type ComplianceCell,
  type DriverComplianceRow,
  type DrugAlcoholTestType,
  type SafetyDrugTest,
  type TestSubstance,
  expiryTone,
  isExpiryAlert,
} from '@neway/shared';
import { Badge, Button, Combobox, FormField, Input, Modal, Select, StatusBadge, Tabs, TabsContent } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiPost } from '@/lib/api-client';
import { formatIsoDate } from '@/lib/format';
import { today } from '@/lib/clock';
import { ExpiryBadge } from '@/features/documents/ExpiryBadge';
import { readAsDataUrl } from '@/lib/files';
import { DriverUploadModal } from './DriverUploadModal';
import { safetyApi, useCan, useComplianceCompany, useComplianceDrivers, useComplianceVehicles, useDrugTests, useSafetyPickers, useSafetyWrite, useTestingSummary } from './api';
import { CountTile, LoadError, Loading, Panel, SafetyTitle, td, th } from './ui';
import { easternNowInput, fromEasternInput } from './time';

/** An engine status as the chip the mockup draws: the word, the family, and the date under it. */
const CHIP: Record<string, { status: string; label: string }> = {
  verified: { status: 'verified', label: 'Current' },
  valid: { status: 'verified', label: 'Current' },
  expiring: { status: 'due_soon', label: 'Due soon' },
  expired: { status: 'expired', label: 'Expired' },
  missing: { status: 'missing', label: 'Missing' },
  pending_verification: { status: 'pending_verification', label: 'Pending review' },
  verification_failed: { status: 'verification_failed', label: 'Rejected' },
  waived: { status: 'waived', label: 'Waived' },
  not_applicable: { status: 'not_applicable', label: 'Not applicable' },
};

/** Engine statuses whose date is an expiry, so the chip takes the product-wide expiry band. */
const DATED = new Set(['verified', 'valid', 'expiring', 'expired']);

function Chip({ cell }: { cell: Pick<ComplianceCell, 'status' | 'date'> }) {
  const c = CHIP[cell.status] ?? { status: 'unknown', label: cell.status };
  // Within three months of the expiry (or past it) the chip says how close, in the shared
  // bands (expiryTone): blue, yellow, red, then Expired. Otherwise the engine's word stands.
  const band = cell.date && DATED.has(cell.status) ? expiryTone(cell.date, today()) : null;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      {band && isExpiryAlert(band.tone) ? (
        <ExpiryBadge result={band} today={today()} size="md" />
      ) : (
        <StatusBadge status={c.status} label={c.label} />
      )}
      {cell.date && cell.status !== 'missing' ? <span className="text-xs text-nw-text-3">{formatIsoDate(cell.date)}</span> : null}
    </span>
  );
}

type ComplianceTab = 'drivers' | 'vehicles' | 'company' | 'testing';

/**
 * Compliance, as the owner's mockup draws it: Drivers, Vehicles, Company and Testing. Every chip
 * is the compliance engine over the qualification file; the full workbench (documents, consents,
 * the verification pipeline) stays one click away.
 */
export function ComplianceV2Page() {
  const [tab, setTab] = useState<ComplianceTab>('drivers');
  return (
    <div className="flex w-full flex-col gap-4">
      <SafetyTitle
        title="Driver Qualifications"
        subtitle="Driver, vehicle and company requirements."
        actions={
          <Link to="/safety/compliance" search={{ tab: 'drivers' } as never} className="text-sm font-semibold text-nw-accent-ink underline">
            Open the compliance workbench
          </Link>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as ComplianceTab)}
        items={[
          { value: 'drivers', label: 'Drivers' },
          { value: 'vehicles', label: 'Vehicles' },
          { value: 'company', label: 'Company' },
          { value: 'testing', label: 'Testing' },
        ]}
      >
        <TabsContent value="drivers" className="pt-4">
          <DriversTab />
        </TabsContent>
        <TabsContent value="vehicles" className="pt-4">
          <VehiclesTab />
        </TabsContent>
        <TabsContent value="company" className="pt-4">
          <CompanyChecklist />
        </TabsContent>
        <TabsContent value="testing" className="pt-4">
          <TestingTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DriversTab() {
  const view = useComplianceDrivers();
  const [q, setQ] = useState('');
  const rows = useMemo(() => (view.data?.rows ?? []).filter((r) => !q.trim() || r.driverName.toLowerCase().includes(q.trim().toLowerCase())), [view.data, q]);
  const roster = rows.filter((r) => r.group === 'roster');
  const hiring = rows.filter((r) => r.group === 'in_hiring');
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <CountTile icon={<CircleAlert />} tone="urgent" value={view.data?.totals.expired} label="Expired" hint="Items past due" />
        <CountTile icon={<Clock />} tone="warning" value={view.data?.totals.dueSoon} label="Due soon" hint="Items inside their warning window" />
        <CountTile icon={<FileQuestion />} tone="neutral" value={view.data?.totals.missing} label="Missing" hint="Required items not on file" />
      </div>
      <Panel
        title="Driver compliance"
        actions={<Input size="sm" prefix={<Search className="size-4" />} placeholder="Search drivers…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search drivers" />}
        padding="none"
      >
        {view.isLoading ? <Loading /> : view.error ? <LoadError error={view.error} /> : <DriverTable rows={roster} empty="No drivers on the roster." />}
      </Panel>
      <Panel title="In hiring" note="Candidates with a reserved driver id and an open hiring case; not on the roster yet" padding="none">
        {view.isLoading ? <Loading /> : <DriverTable rows={hiring} empty="Nobody in hiring." />}
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <TestingSummaryCard />
        <CompanyChecklist compact />
      </div>
    </div>
  );
}

function DriverTable({ rows, empty }: { rows: DriverComplianceRow[]; empty: string }) {
  const [uploadFor, setUploadFor] = useState<DriverComplianceRow | null>(null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] border-collapse">
        <thead className="border-b border-nw-border bg-nw-subtle">
          <tr>
            <th className={th}>Driver</th>
            <th className={th}>CDL</th>
            <th className={th}>Medical qualification</th>
            <th className={th}>Annual MVR review</th>
            <th className={th}>Clearinghouse query</th>
            <th className={th}>Testing program</th>
            <th className={th}>Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-nw-border">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-sm text-nw-text-3">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.driverId}>
                <td className={td}>{r.driverName}</td>
                <td className={td}><Chip cell={r.cells.cdl} /></td>
                <td className={td}><Chip cell={r.cells.medical_card} /></td>
                <td className={td}><Chip cell={r.cells.mvr_review} /></td>
                <td className={td}><Chip cell={r.cells.clearinghouse_query} /></td>
                <td className={td}><Chip cell={r.cells.testing_program} /></td>
                <td className={td}>
                  <Link to="/safety/compliance" search={{ entity: `driver:${r.driverId}` } as never} className="font-semibold text-nw-accent-ink underline">
                    View
                  </Link>
                  <Button size="sm" variant="secondary" icon={<Upload />} className="ml-3" onClick={() => setUploadFor(r)}>
                    Upload
                  </Button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {uploadFor ? <DriverUploadModal driverId={uploadFor.driverId} driverName={uploadFor.driverName} onClose={() => setUploadFor(null)} /> : null}
    </div>
  );
}

function VehiclesTab() {
  const view = useComplianceVehicles();
  const [scope, setScope] = useState<'truck' | 'trailer'>('truck');
  if (view.isLoading) return <Loading />;
  if (view.error) return <LoadError error={view.error} />;
  const rows = (view.data ?? []).filter((u) => u.scope === scope);
  const columns = rows[0]?.cells.map((c) => ({ code: c.code, name: c.name })) ?? [];
  return (
    <Panel
      title="Vehicle compliance"
      actions={<Select size="sm" value={scope} onValueChange={(v) => setScope(v as 'truck' | 'trailer')} options={[{ value: 'truck', label: 'Trucks' }, { value: 'trailer', label: 'Trailers' }]} />}
      padding="none"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse">
          <thead className="border-b border-nw-border bg-nw-subtle">
            <tr>
              <th className={th}>Unit</th>
              {columns.map((c) => (
                <th key={c.code} className={th}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-nw-border">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1} className="px-3 py-8 text-center text-sm text-nw-text-3">
                  No units.
                </td>
              </tr>
            ) : (
              rows.map((u) => (
                <tr key={u.unitId}>
                  <td className={td}>
                    {u.scope === 'truck' ? (
                      <Link to="/fleet/trucks/$truckId" params={{ truckId: u.unitId }} className="font-semibold text-nw-accent-ink underline">{u.unitNumber}</Link>
                    ) : (
                      <Link to="/fleet/trailers/$trailerId" params={{ trailerId: u.unitId }} className="font-semibold text-nw-accent-ink underline">{u.unitNumber}</Link>
                    )}
                  </td>
                  {u.cells.map((c) => (
                    <td key={c.code} className={td}>
                      <Chip cell={c} />
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** The carrier's own file: green when the document is on file and verified, never hand-ticked. */
function CompanyChecklist({ compact = false }: { compact?: boolean }) {
  const list = useComplianceCompany();
  const account = useAccount();
  const canUpload = useCan('documents.create');
  return (
    <Panel title="Company compliance checklist" note={compact ? undefined : 'Derived from the documents on file; verify them in the workbench'} padding="none">
      {list.isLoading ? <Loading /> : list.error ? <LoadError error={list.error} /> : (
        <table className="w-full border-collapse">
          <thead className="border-b border-nw-border bg-nw-subtle">
            <tr>
              <th className={th}>Requirement</th>
              <th className={th}>Status</th>
              {!compact && canUpload ? <th className={th} /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-nw-border">
            {(list.data ?? []).map((r) => (
              <tr key={r.code}>
                <td className={td}>
                  {r.name}
                  {!compact ? <span className="block text-xs text-nw-text-3">{r.authority}</span> : null}
                </td>
                <td className={td}>
                  <Chip cell={{ status: r.status, date: r.expiresOn }} />
                </td>
                {!compact && canUpload && account ? (
                  <td className={td}>
                    <CompanyUpload code={r.code} name={r.name} companyId={account.companyId} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function CompanyUpload({ code, name, companyId }: { code: string; name: string; companyId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [expires, setExpires] = useState('');
  const upload = useSafetyWrite(async (file: File) => {
    const content = (await readAsDataUrl(file)).split(',')[1] ?? '';
    return apiPost('/compliance/documents', {
      ownerType: 'company',
      ownerId: companyId,
      ownerLabel: 'Company',
      requirementCode: code,
      title: name,
      fileName: file.name,
      contentType: file.type || 'application/pdf',
      sizeBytes: file.size,
      issuedOn: null,
      expiresOn: expires || null,
      source: 'staff',
      content,
    });
  }, `${name}: uploaded, pending verification`);
  return (
    <span className="flex items-center gap-2">
      <Input size="sm" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} aria-label={`${name} expiry`} className="w-36" />
      <input
        ref={input}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = '';
        }}
      />
      <Button size="sm" variant="outline" loading={upload.isPending} onClick={() => input.current?.click()}>
        Upload
      </Button>
    </span>
  );
}

function TestingSummaryCard() {
  const summary = useTestingSummary();
  return (
    <Panel title="Testing & Clearinghouse" padding="none">
      {summary.isLoading ? <Loading /> : summary.error ? <LoadError error={summary.error} /> : (
        <table className="w-full border-collapse">
          <thead className="border-b border-nw-border bg-nw-subtle">
            <tr>
              <th className={th}>Type</th>
              <th className={th}>Open tasks</th>
              <th className={th}>Restricted records</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-nw-border">
            {(summary.data?.rows ?? []).map((r) => (
              <tr key={r.testType}>
                <td className={td}>{DRUG_ALCOHOL_TEST_TYPE_LABEL[r.testType]}</td>
                <td className={td}>{r.openTasks}</td>
                <td className={td}>{r.restrictedRecords > 0 ? <StatusBadge status="result_restricted" label={`${r.restrictedRecords} restricted`} /> : '0'}</td>
              </tr>
            ))}
            <tr>
              <td className={td} colSpan={3}>
                <span className="text-xs text-nw-text-3">
                  Pre-employment tests on the qualification file: {summary.data?.preEmploymentFromQualificationFile.onFile ?? 0} drivers on file,{' '}
                  {summary.data?.preEmploymentFromQualificationFile.missing ?? 0} missing.
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function TestingTab() {
  const tests = useDrugTests();
  const canManage = useCan('safety_testing.manage');
  const [creating, setCreating] = useState(false);
  return (
    <div className="grid gap-4">
      {creating ? <NewTestDialog open={creating} onOpenChange={setCreating} /> : null}
      <TestingSummaryCard />
      <Panel
        title="Drug & alcohol tests"
        note="Results are restricted to authorised personnel"
        actions={
          canManage ? (
            <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              Record a test
            </Button>
          ) : undefined
        }
        padding="none"
      >
        {tests.isLoading ? <Loading /> : tests.error ? <LoadError error={tests.error} /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse">
              <thead className="border-b border-nw-border bg-nw-subtle">
                <tr>
                  <th className={th}>Test</th>
                  <th className={th}>Type</th>
                  <th className={th}>Driver</th>
                  <th className={th}>Accident</th>
                  <th className={th}>Collected</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nw-border">
                {(tests.data ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-sm text-nw-text-3">
                      No tests recorded.
                    </td>
                  </tr>
                ) : (
                  (tests.data ?? []).map((t: SafetyDrugTest) => (
                    <tr key={t.id}>
                      <td className={td}>
                        {t.number}
                        {t.isTest ? <Badge size="sm" className="ml-1">Test</Badge> : null}
                        <span className="block text-xs text-nw-text-3">{t.substance === 'alcohol' ? 'Alcohol' : 'Drug'}</span>
                      </td>
                      <td className={td}>{DRUG_ALCOHOL_TEST_TYPE_LABEL[t.testType]}</td>
                      <td className={td}>{t.driverName ?? <span className="text-nw-text-3">None</span>}</td>
                      <td className={td}>
                        {t.accidentId ? (
                          <Link to="/safety/accidents/$accidentId" params={{ accidentId: t.accidentId }} className="font-semibold text-nw-accent-ink underline">
                            {t.accidentNumber}
                          </Link>
                        ) : (
                          <span className="text-nw-text-3">None</span>
                        )}
                      </td>
                      <td className={td}>{t.collectedAt ? formatIsoDate(t.collectedAt.slice(0, 10)) : <span className="text-nw-text-3">Not collected</span>}</td>
                      <td className={td}>
                        <StatusBadge status={t.resultRestricted && t.status.resolved ? 'result_restricted' : t.status.progress} label={t.resultRestricted && t.status.resolved ? 'Resolved (restricted)' : TEST_PROGRESS_LABEL[t.status.progress]} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function NewTestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const pickers = useSafetyPickers();
  const [testType, setTestType] = useState<DrugAlcoholTestType>('random');
  const [substance, setSubstance] = useState<TestSubstance>('drug');
  const [driverId, setDriverId] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(easternNowInput());
  const save = useSafetyWrite(
    () => safetyApi.post<SafetyDrugTest>('/tests', { testType, substance, driverId, scheduledAt: fromEasternInput(scheduled) }),
    (t) => `${t.number} opened`,
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Record a drug or alcohol test"
      description="Post-accident tests open themselves from the accident. Times are US Eastern."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!driverId} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => onOpenChange(false) })}>
            Open test
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Type">
          <Select value={testType} onValueChange={(v) => setTestType(v as DrugAlcoholTestType)} options={DRUG_ALCOHOL_TEST_TYPES.filter((t) => t !== 'post_accident').map((t) => ({ value: t, label: DRUG_ALCOHOL_TEST_TYPE_LABEL[t] }))} />
        </FormField>
        <FormField label="Substance">
          <Select value={substance} onValueChange={(v) => setSubstance(v as TestSubstance)} options={[{ value: 'drug', label: 'Drug' }, { value: 'alcohol', label: 'Alcohol' }]} />
        </FormField>
        <FormField label="Driver" required>
          <Combobox options={(pickers.data?.drivers ?? []).map((d) => ({ value: d.id, label: d.name }))} value={driverId} loading={pickers.isLoading} placeholder="Choose the driver" onValueChange={setDriverId} />
        </FormField>
        <FormField label="Scheduled for (Eastern)">
          <Input type="datetime-local" value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
