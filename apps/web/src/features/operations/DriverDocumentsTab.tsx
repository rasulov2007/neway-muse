import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EllipsisVertical, FileText, Image as ImageIcon, Plus, Search, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ComplianceDocument, EvaluatedItem, WorkAuthorizationKind } from '@neway/shared';
import {
  SYSTEM_REQUIREMENTS,
  WORK_AUTHORIZATION_CODE,
  workAuthorizationKindOf,
  combineParts,
  expiryTone,
  isExpiryAlert,
  partCodes,
  partsOf,
  reportAge,
} from '@neway/shared';
import {
  Button,
  Card,
  DatePicker,
  DropdownMenu,
  FormField,
  IconButton,
  Input,
  MenuItem,
  Modal,
  Select,
  StatusBadge,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { DocumentViewer } from '@/features/documents';
import { useAutoExpiry } from '@/features/documents/auto-expiry';
import { ExpiryBadge } from '@/features/documents/ExpiryBadge';
import {
  WorkAuthorizationKindField,
  asksWorkAuthorizationKind,
  documentNameWithKind,
  workAuthorizationExtract,
} from '@/features/documents/WorkAuthorizationKindField';
import { CdlPairViewer, type CdlSide } from './CdlPairViewer';
import { hrefs, useGo } from '@/features/dashboard/links';
import { toBase64 } from '@/features/operations/credential-ocr';
import {
  listComplianceDocuments,
  uploadComplianceDocument,
} from '@/features/safety/compliance-api';
import { today } from '@/lib/clock';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { RandomDrugTestsCard } from './RandomDrugTestsCard';
import type { OperationalDriver } from './useOperations';

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * The driver's documents in three groups (owner brief, 2026-10-11): what the driver carries, what
 * Safety ran, and everything else the file requires. Signed consents live on the Safety tab.
 */
const DRIVER_DOCS = new Set(['cdl', 'cdl_back', 'medical_card', 'work_authorization']);
const SAFETY_REPORTS = new Set(['mvr_review', 'psp_review', 'clearinghouse_query', 'pre_employment_drug_test', 'employment_verification', 'road_test']);
const DOCUMENT_GROUPS = [
  { key: 'driver', label: 'Driver documents' },
  { key: 'safety', label: 'Safety reports' },
  { key: 'other', label: 'Other requirements' },
] as const;
const groupOf = (code: string) => (DRIVER_DOCS.has(code) ? 'driver' : SAFETY_REPORTS.has(code) ? 'safety' : 'other');
const SOURCE_LABEL: Record<string, string> = { public_link: 'From the driver', staff: 'Uploaded by staff', driver_portal: 'Driver portal', seed: 'Imported', import: 'Imported' };

/** Requirements whose file is a photograph: an image drop zone, and no expiry. */
const PHOTO_CODES = new Set(['driver_photo', 'photo']);
const isPhoto = (item: EvaluatedItem) =>
  PHOTO_CODES.has(item.requirementCode) || /photo/i.test(item.requirementName);

/** True when the catalog says the requirement carries an expiry date. */
const catalogHasExpiry = (code: string) =>
  SYSTEM_REQUIREMENTS.find((r) => r.code === code)?.hasExpiry ?? false;

/** The fixed term of a periodic review (MVR, PSP: 6 months), when the requirement has one. */
const termOf = (code: string) => SYSTEM_REQUIREMENTS.find((r) => r.code === code)?.validityMonths ?? null;

/** Requirements shown as a slot of another (the back of the CDL), not as a row of their own. */
const PART_CODES = partCodes();
/** The name a combined item is shown under (owner, 2026-10-24: "CDL", Front and Back). */
const COMBINED_NAME: Record<string, string> = { cdl: 'CDL' };

/** Retired types (driver photograph, background check): their filed documents stay readable. */
const RETIRED_CODES = new Set(
  SYSTEM_REQUIREMENTS.filter((r) => r.scope === 'driver' && !r.active).map((r) => r.code),
);
const RETIRED_NAME = new Map(SYSTEM_REQUIREMENTS.map((r) => [r.code, r.name]));

/**
 * Document-only driver papers (the W-9, owner 2026-10-25): files the driver's record keeps, not
 * requirements the engine grades, so they never read as missing and never hold. The random drug
 * test is one too, but it has its own card with the date and the result.
 */
const DRIVER_PAPERS = SYSTEM_REQUIREMENTS.filter(
  (r) => r.scope === 'driver' && r.active && r.documentOnly && r.code !== 'random_drug_test',
);

/** A paper as the upload dialog reads a requirement: no expiry, no grade, nothing to do. */
function paperItem(
  requirement: (typeof DRIVER_PAPERS)[number],
  driver: { id: string; name: string },
  onFile: boolean,
): EvaluatedItem {
  return {
    itemId: null,
    requirementCode: requirement.code,
    requirementName: requirement.name,
    scope: 'driver',
    entityId: driver.id,
    entityLabel: driver.name,
    // Only the dialog reads this (Add or Replace); the row draws its own On file / Not uploaded.
    status: onFile ? 'valid' : 'missing',
    severity: 'ok',
    expiresOn: null,
    daysRemaining: null,
    warningStage: null,
    inGracePeriod: false,
    blocksDispatch: false,
    owner: requirement.owner,
    notify: [],
    reasons: [],
    requiredAction: null,
    deadline: null,
  };
}

/** The option label in Add document: a part names its slot ("CDL — Back"). */
const typeLabel = (item: EvaluatedItem) => {
  const requirement = SYSTEM_REQUIREMENTS.find((r) => r.code === item.requirementCode);
  const parent = requirement?.partOf ?? (partsOf(item.requirementCode).length > 1 ? item.requirementCode : null);
  if (!parent || !requirement?.partLabel) return item.requirementName;
  return `${COMBINED_NAME[parent] ?? item.requirementName} — ${requirement.partLabel}`;
};

/**
 * The driver's Documents tab as the owner drew it (2026-09-21): one row per requirement with the
 * review status, the expiry and any waiver kept apart, View / Replace or Upload on each row, and
 * Add document above. Everything is the qualification file Safety keeps - the same records the
 * Compliance page and the driver's hold read - so attaching here is attaching everywhere.
 */
export function DriverDocumentsTab({ row }: { row: OperationalDriver }) {
  const go = useGo();
  const compliance = row.compliance;
  const driverId = row.driver.id;
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [adding, setAdding] = useState<{ item: EvaluatedItem | null } | null>(null);
  const [viewing, setViewing] = useState<ComplianceDocument | null>(null);
  /** The combined item (the CDL) open in the front-and-back viewer. */
  const [viewingCombined, setViewingCombined] = useState<string | null>(null);
  const [details, setDetails] = useState<EvaluatedItem | null>(null);

  const documents = useQuery({
    queryKey: ['compliance-documents', 'driver', driverId],
    queryFn: () => listComplianceDocuments({ ownerType: 'driver', ownerId: driverId }),
  });
  const latestByCode = useMemo(() => {
    const map = new Map<string, ComplianceDocument>();
    for (const doc of documents.data ?? []) {
      const current = map.get(doc.requirementCode);
      if (!current || doc.uploadedAt > current.uploadedAt) map.set(doc.requirementCode, doc);
    }
    return map;
  }, [documents.data]);
  const retiredDocs = useMemo(
    () =>
      (documents.data ?? [])
        .filter((d) => RETIRED_CODES.has(d.requirementCode))
        .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
    [documents.data],
  );

  if (!compliance) {
    return (
      <Card padding="md">
        <p className="text-sm text-muted">
          Safety holds no compliance record for this driver, so nothing can be reported here.
        </p>
      </Card>
    );
  }

  // A part (the CDL back) is a slot of its parent's row; filtering by the parent shows both.
  const rowItems = compliance.items.filter((item) => !PART_CODES.has(item.requirementCode));
  const items = rowItems.filter((item) => {
    if (type !== 'all' && item.requirementCode !== type) return false;
    if (status !== 'all' && item.status !== status) return false;
    if (search.trim() && !item.requirementName.toLowerCase().includes(search.trim().toLowerCase()))
      return false;
    return true;
  });
  const statuses = [...new Set(compliance.items.map((i) => i.status))];
  const todayIso = today();
  const driverRef = { id: driverId, name: row.driver.name };
  const paperItems = DRIVER_PAPERS.map((r) => paperItem(r, driverRef, latestByCode.has(r.code)));
  const papers = paperItems.filter((paper) => {
    if (type !== 'all' && paper.requirementCode !== type) return false;
    if (status !== 'all') return false;
    if (search.trim() && !paper.requirementName.toLowerCase().includes(search.trim().toLowerCase()))
      return false;
    return true;
  });

  /** A document-only paper (W-9): on file or not, never graded, never expiring. */
  const renderPaperRow = (paper: EvaluatedItem) => {
    const doc = latestByCode.get(paper.requirementCode) ?? null;
    return (
      <tr key={paper.requirementCode} className="border-b border-nw-border last:border-b-0" data-testid={`paper-${paper.requirementCode}`}>
        <td className="px-4 py-2.5">
          <span className="flex items-center gap-2 font-medium text-ink">
            <FileText className="size-4 shrink-0 text-nw-text-3" aria-hidden />
            {paper.requirementName}
          </span>
          {doc ? (
            <span className="mt-0.5 block pl-6 text-xs text-nw-text-3">
              {SOURCE_LABEL[doc.source] ?? doc.source} · {formatDateTime(doc.uploadedAt)}
            </span>
          ) : null}
        </td>
        <td className="px-3 py-2.5">
          {doc ? (
            <StatusBadge status="received" label="On file" size="sm" />
          ) : (
            <StatusBadge status="not_required" label="Not uploaded" size="sm" />
          )}
        </td>
        <td className="px-3 py-2.5 text-nw-text-1">{doc ? 'Does not expire' : '—'}</td>
        <td className="px-3 py-2.5 text-nw-text-1">—</td>
        <td className="px-3 py-2.5">
          <span className="flex items-center justify-end gap-1">
            {doc && doc.hasFile ? (
              <Button size="sm" variant="link" onClick={() => setViewing(doc)}>
                View
              </Button>
            ) : null}
            <Button size="sm" variant="link" onClick={() => setAdding({ item: paper })}>
              {doc ? 'Replace' : 'Upload'}
            </Button>
          </span>
        </td>
      </tr>
    );
  };

  /** The age and due date of a periodic review (MVR, PSP: due 6 months after its date). */
  const ageLine = (item: EvaluatedItem, doc: ComplianceDocument | null) => {
    const term = termOf(item.requirementCode);
    if (!term || !doc || item.status === 'missing') return null;
    const datedOn = doc.issuedOn ?? doc.uploadedAt.slice(0, 10);
    const age = reportAge(datedOn, todayIso);
    return (
      <span className="mt-0.5 block pl-6 text-xs text-nw-text-2">
        {doc.issuedOn ? 'Dated' : 'Received'} {formatIsoDate(datedOn)}
        {age ? ` · ${age.label}` : ''}
        {item.expiresOn ? ` · due ${formatIsoDate(item.expiresOn)} (every ${term} months)` : ''}
      </span>
    );
  };

  /** The sides of a combined item (Front / Back of the CDL) with the file on each. */
  const sidesOf = (code: string): CdlSide[] =>
    combineParts(code, compliance.items).slots.map((slot) => {
      const doc = latestByCode.get(slot.code) ?? null;
      return { code: slot.code, label: slot.label, item: slot.item, document: doc !== null && slot.filled ? doc : null };
    });

  /**
   * The CDL as one compact row like the others (owner, 2026-10-26), incomplete until both sides
   * are on file. View opens the front and the back side by side; the uploads sit in the ⋮ menu.
   */
  const renderCombinedRow = (item: EvaluatedItem) => {
    const combined = combineParts(item.requirementCode, compliance.items);
    const sides = sidesOf(item.requirementCode);
    const name = COMBINED_NAME[item.requirementCode] ?? item.requirementName;
    const anyOnFile = sides.some((side) => side.document !== null);
    const latest = sides
      .map((side) => side.document)
      .filter((doc): doc is ComplianceDocument => doc !== null)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0];
    const waived = item.status === 'waived';
    return (
      <tr key={item.requirementCode} className="border-b border-nw-border last:border-b-0" data-testid={`combined-${item.requirementCode}`}>
        <td className="px-4 py-2.5">
          <span className="flex items-center gap-2 font-medium text-ink">
            <FileText className="size-4 shrink-0 text-nw-text-3" aria-hidden />
            {name}
          </span>
          {latest ? (
            <span className="mt-0.5 block pl-6 text-xs text-nw-text-3">
              {SOURCE_LABEL[latest.source] ?? latest.source} · {formatDateTime(latest.uploadedAt)}
            </span>
          ) : null}
        </td>
        <td className="px-3 py-2.5 align-top">
          {combined.complete ? (
            <StatusBadge status={item.status} size="sm" />
          ) : (
            <StatusBadge status="missing" label={`Incomplete · ${combined.missing.join(' and ')} missing`} size="sm" />
          )}
        </td>
        <td className="px-3 py-2.5 align-top text-nw-text-1">
          {item.expiresOn ? (
            <span className="flex flex-col items-start gap-0.5">
              {formatIsoDate(item.expiresOn)}
              {isExpiryAlert(expiryTone(item.expiresOn, todayIso).tone) ? (
                <ExpiryBadge expiresOn={item.expiresOn} today={todayIso} variant="text" />
              ) : null}
            </span>
          ) : (
            '—'
          )}
        </td>
        <td className="px-3 py-2.5 align-top text-nw-text-1">
          {waived && item.deadline ? formatIsoDate(item.deadline) : '—'}
        </td>
        <td className="px-3 py-2.5 align-top">
          <span className="flex items-center justify-end gap-1">
            {anyOnFile ? (
              <Button size="sm" variant="link" onClick={() => setViewingCombined(item.requirementCode)}>
                View
              </Button>
            ) : sides[0]?.item ? (
              <Button size="sm" variant="link" onClick={() => setAdding({ item: sides[0]!.item })}>
                Upload
              </Button>
            ) : null}
            <DropdownMenu
              trigger={
                <IconButton label={`More for ${name}`} size="sm" variant="ghost">
                  <EllipsisVertical />
                </IconButton>
              }
            >
              {sides.map((side) =>
                side.item ? (
                  <MenuItem key={`upload-${side.code}`} onSelect={() => setAdding({ item: side.item })}>
                    {side.document ? 'Replace' : 'Upload'} {side.label.toLowerCase()}
                  </MenuItem>
                ) : null,
              )}
              {combined.slots.map((slot) =>
                slot.item ? (
                  <MenuItem key={slot.code} onSelect={() => setDetails(slot.item)}>
                    Details · {slot.label}
                  </MenuItem>
                ) : null,
              )}
              <MenuItem onSelect={() => go(hrefs.compliance)}>Open in Compliance</MenuItem>
            </DropdownMenu>
          </span>
        </td>
      </tr>
    );
  };

  const renderRow = (item: EvaluatedItem) => {
                if (partsOf(item.requirementCode).length > 1) return renderCombinedRow(item);
                const doc = latestByCode.get(item.requirementCode) ?? null;
                const waived = item.status === 'waived';
                const onFile = doc !== null && item.status !== 'missing';
                return (
                  <tr
                    key={item.requirementCode}
                    className="border-b border-nw-border last:border-b-0"
                  >
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2 font-medium text-ink">
                        {isPhoto(item) ? (
                          <ImageIcon className="size-4 shrink-0 text-nw-text-3" aria-hidden />
                        ) : (
                          <FileText className="size-4 shrink-0 text-nw-text-3" aria-hidden />
                        )}
                        {/* "Work authorization · Green Card" (owner, 2026-10-26). */}
                        {documentNameWithKind(item.requirementName, doc)}
                      </span>
                      {doc ? (
                        <span className="mt-0.5 block pl-6 text-xs text-nw-text-3">
                          {SOURCE_LABEL[doc.source] ?? doc.source} · {formatDateTime(doc.uploadedAt)}
                        </span>
                      ) : null}
                      {ageLine(item, doc)}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={item.status} size="sm" />
                    </td>
                    <td className="px-3 py-2.5 text-nw-text-1">
                      {item.expiresOn ? (
                        <span className="flex flex-col items-start gap-0.5">
                          {formatIsoDate(item.expiresOn)}
                          {isExpiryAlert(expiryTone(item.expiresOn, todayIso).tone) ? (
                            <ExpiryBadge
                              expiresOn={item.expiresOn}
                              today={todayIso}
                              variant="text"
                            />
                          ) : null}
                        </span>
                      ) : onFile && isPhoto(item) ? (
                        'Does not expire'
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-nw-text-1">
                      {waived && item.deadline ? formatIsoDate(item.deadline) : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center justify-end gap-1">
                        {onFile && doc ? (
                          <Button size="sm" variant="link" onClick={() => setViewing(doc)}>
                            View
                          </Button>
                        ) : null}
                        <Button size="sm" variant="link" onClick={() => setAdding({ item })}>
                          {onFile ? 'Replace' : 'Upload'}
                        </Button>
                        <DropdownMenu
                          trigger={
                            <IconButton
                              label={`More for ${item.requirementName}`}
                              size="sm"
                              variant="ghost"
                            >
                              <EllipsisVertical />
                            </IconButton>
                          }
                        >
                          <MenuItem onSelect={() => setDetails(item)}>Details</MenuItem>
                          <MenuItem onSelect={() => go(hrefs.compliance)}>
                            Open in Compliance
                          </MenuItem>
                        </DropdownMenu>
                      </span>
                    </td>
                  </tr>
                );
              };

  return (
    <div className="flex flex-col gap-4">
      <Card
        padding="none"
        title="Documents"
        description="Manage driver documents and compliance requirements."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-8 w-52 items-center gap-2 rounded-lg border border-nw-border-strong bg-nw-field px-2.5 text-[12.5px] text-nw-text-3 focus-within:border-nw-accent">
              <Search className="size-3.5 shrink-0" aria-hidden />
              <input
                type="search"
                aria-label="Search documents"
                placeholder="Search documents…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full min-w-0 bg-transparent text-nw-text outline-none placeholder:text-nw-text-3"
              />
            </label>
            <Select
              size="sm"
              aria-label="Document type"
              value={type}
              onValueChange={setType}
              options={[
                { value: 'all', label: 'All types' },
                ...rowItems.map((i) => ({
                  value: i.requirementCode,
                  label: COMBINED_NAME[i.requirementCode] ?? i.requirementName,
                })),
                ...paperItems.map((i) => ({ value: i.requirementCode, label: i.requirementName })),
              ]}
              className="w-40"
            />
            <Select
              size="sm"
              aria-label="Review status"
              value={status}
              onValueChange={setStatus}
              options={[
                { value: 'all', label: 'All statuses' },
                ...statuses.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
              ]}
              className="w-40"
            />
            <Button
              size="sm"
              variant="primary"
              icon={<Plus />}
              onClick={() => setAdding({ item: null })}
            >
              Add document
            </Button>
          </div>
        }
        footer={
          <span className="flex items-center justify-between text-xs text-muted">
            <span>
              Showing {items.length} of {rowItems.length} requirements
            </span>
            <Button variant="link" size="sm" onClick={() => go(hrefs.compliance)}>
              Open compliance
            </Button>
          </span>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-nw-border bg-nw-subtle text-left text-xs font-semibold text-nw-text-2">
                <th className="px-4 py-2">Document</th>
                <th className="px-3 py-2">Review status</th>
                <th className="px-3 py-2">Expiry</th>
                <th className="px-3 py-2">Waiver until</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {DOCUMENT_GROUPS.flatMap((group) => {
                const mine = items.filter((item) => groupOf(item.requirementCode) === group.key);
                if (mine.length === 0) return [];
                return [
                  <tr key={`group-${group.key}`} className="border-b border-nw-border bg-nw-subtle/60">
                    <td colSpan={5} className="px-4 py-1.5 text-xs font-bold tracking-wide text-nw-text-3 uppercase">
                      {group.label}
                    </td>
                  </tr>,
                  ...mine.map((item) => renderRow(item)),
                ];
              })}
              {papers.length > 0
                ? [
                    <tr key="group-papers" className="border-b border-nw-border bg-nw-subtle/60">
                      <td colSpan={5} className="px-4 py-1.5 text-xs font-bold tracking-wide text-nw-text-3 uppercase">
                        Tax and pay papers
                      </td>
                    </tr>,
                    ...papers.map((paper) => renderPaperRow(paper)),
                  ]
                : null}
              {items.length === 0 && papers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">
                    No requirement matches.
                  </td>
                </tr>
              ) : null}
              {retiredDocs.length > 0 && type === 'all' && status === 'all' && !search.trim()
                ? [
                    <tr key="group-retired" className="border-b border-nw-border bg-nw-subtle/60">
                      <td colSpan={5} className="px-4 py-1.5 text-xs font-bold tracking-wide text-nw-text-3 uppercase">
                        No longer required · kept on file
                      </td>
                    </tr>,
                    ...retiredDocs.map((doc) => (
                      <tr key={doc.id} className="border-b border-nw-border last:border-b-0">
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-2 font-medium text-nw-text-2">
                            <FileText className="size-4 shrink-0 text-nw-text-3" aria-hidden />
                            {RETIRED_NAME.get(doc.requirementCode) ?? doc.title}
                          </span>
                          <span className="mt-0.5 block pl-6 text-xs text-nw-text-3">
                            {doc.fileName} · {formatDateTime(doc.uploadedAt)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusBadge status="not_required" label="Retired" size="sm" />
                        </td>
                        <td className="px-3 py-2.5 text-nw-text-1">—</td>
                        <td className="px-3 py-2.5 text-nw-text-1">—</td>
                        <td className="px-3 py-2.5">
                          <span className="flex items-center justify-end gap-1">
                            {doc.hasFile ? (
                              <Button size="sm" variant="link" onClick={() => setViewing(doc)}>
                                View
                              </Button>
                            ) : null}
                          </span>
                        </td>
                      </tr>
                    )),
                  ]
                : null}
            </tbody>
          </table>
        </div>
      </Card>

      <RandomDrugTestsCard driverId={driverId} driverName={row.driver.name} />

      {adding ? (
        <AddDriverDocumentDialog
          driverId={driverId}
          driverLabel={row.driver.name}
          driverNumber={row.driver.driverNumber}
          items={[...compliance.items, ...paperItems]}
          initial={adding.item}
          initialKind={workAuthorizationKindOf(latestByCode.get(WORK_AUTHORIZATION_CODE))}
          onClose={() => setAdding(null)}
        />
      ) : null}
      {viewingCombined ? (
        <CdlPairViewer
          title={COMBINED_NAME[viewingCombined] ?? viewingCombined}
          subtitle={`${row.driver.name} · ${row.driver.driverNumber}`}
          sides={sidesOf(viewingCombined)}
          onUpload={(side) => {
            setViewingCombined(null);
            setAdding({ item: side.item });
          }}
          onClose={() => setViewingCombined(null)}
        />
      ) : null}
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
      {details ? (
        <Modal
          open
          onOpenChange={(open) => !open && setDetails(null)}
          size="sm"
          title={details.requirementName}
          description={details.requiredAction ?? 'Nothing is required right now.'}
        >
          <ul className="flex flex-col gap-1 text-sm text-nw-text-1">
            {details.reasons.map((reason) => (
              <li key={reason}>· {reason}</li>
            ))}
            {details.reasons.length === 0 ? <li className="text-muted">Satisfied.</li> : null}
          </ul>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * Add document, as drawn: the type, a drop zone (an image one for photographs), a title that
 * stays put, notes, and an expiry only where the requirement tracks one. A photograph has none.
 */
function AddDriverDocumentDialog({
  driverId,
  driverLabel,
  driverNumber,
  items,
  initial,
  initialKind,
  onClose,
}: {
  driverId: string;
  driverLabel: string;
  driverNumber: string;
  items: EvaluatedItem[];
  initial: EvaluatedItem | null;
  /** The paper the Work authorization on file is, prefilled when it is replaced. */
  initialKind: WorkAuthorizationKind | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  // Type, issue date and expiry move together: a fixed-term type (MVR review, Clearinghouse
  // query) fills the expiry from the issue date until somebody types one by hand.
  const dates = useAutoExpiry({ code: initial?.requirementCode ?? items[0]?.requirementCode ?? '' });
  const { code, issuedOn, setIssuedOn, expiresOn, setExpiresOn } = dates;
  const item = items.find((i) => i.requirementCode === code) ?? null;
  const photo = item ? isPhoto(item) : false;
  const tracksExpiry = item
    ? !photo &&
      (catalogHasExpiry(item.requirementCode) ||
        item.expiresOn !== null ||
        item.daysRemaining !== null)
    : false;
  // A fixed-term review (MVR, PSP: 6 months) falls due from its date; the server fills the
  // expiry from the report date, else from today, so the field may stay empty.
  const fixedTerm = item ? termOf(item.requirementCode) : null;
  const needsExpiry = tracksExpiry && !fixedTerm;
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [title, setTitle] = useState(item?.requirementName ?? '');
  const [titleEdited, setTitleEdited] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Which paper a Work authorization is (owner, 2026-10-26): required, prefilled on Replace.
  const [kind, setKind] = useState<WorkAuthorizationKind | ''>(initialKind ?? '');
  const needsKind = asksWorkAuthorizationKind(item?.requirementCode);

  const chooseType = (next: string) => {
    dates.setCode(next);
    if (!titleEdited)
      setTitle(items.find((i) => i.requirementCode === next)?.requirementName ?? '');
  };
  const choose = (next: File | null) => {
    if (next && next.size > MAX_BYTES) return setError('That file is larger than 20 MB.');
    setError(null);
    setFile(next);
  };

  const upload = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error('Choose the document type');
      if (!file) throw new Error('Choose the file first');
      if (needsExpiry && !expiresOn)
        throw new Error(`${item.requirementName} expires - enter the expiry date`);
      if (needsKind && !kind) throw new Error('Choose which work authorization document this is');
      return uploadComplianceDocument({
        ...workAuthorizationExtract(item.requirementCode, kind),
        ownerType: 'driver',
        ownerId: driverId,
        ownerLabel: driverLabel,
        requirementCode: item.requirementCode,
        title: title.trim() || item.requirementName,
        fileName: file.name,
        contentType: file.type || 'application/pdf',
        sizeBytes: file.size,
        issuedOn: tracksExpiry && issuedOn ? issuedOn : null,
        expiresOn: tracksExpiry && expiresOn ? expiresOn : null,
        notes: notes.trim() || null,
        content: await toBase64(file),
      });
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['compliance-documents'] }),
        queryClient.invalidateQueries({ queryKey: ['compliance'] }),
        queryClient.invalidateQueries({ queryKey: ['safety'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
      ]);
      toast({
        tone: 'success',
        title: `${result.document.title} attached`,
        description: 'Received; Safety verifies it separately.',
      });
      onClose();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The document could not be attached.'),
  });

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={initial && initial.status !== 'missing' ? 'Replace document' : 'Add document'}
      description={`${driverLabel} · ${driverNumber}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={upload.isPending}
            disabled={!file || !item || (needsExpiry && !expiresOn) || (needsKind && !kind)}
            onClick={() => upload.mutate()}
          >
            {initial && initial.status !== 'missing' ? 'Replace document' : 'Add document'}
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
        <FormField label="Document type" required>
          <Select
            aria-label="Document type"
            options={items.map((i) => ({ value: i.requirementCode, label: typeLabel(i) }))}
            value={code}
            onValueChange={chooseType}
            disabled={Boolean(initial)}
          />
        </FormField>
        {needsKind ? <WorkAuthorizationKindField value={kind} onChange={setKind} /> : null}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            choose(Array.from(e.dataTransfer?.files ?? [])[0] ?? null);
          }}
          className={cn(
            'flex min-h-24 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors',
            file
              ? 'border-success-border bg-success-soft'
              : 'border-nw-accent/40 bg-nw-accent-tint/40',
            over && 'border-nw-accent bg-nw-accent-tint',
          )}
        >
          <input
            ref={fileInput}
            type="file"
            className="sr-only"
            aria-label="Document file"
            accept={photo ? 'image/*' : '.pdf,.png,.jpg,.jpeg,.heic,.tif,.tiff'}
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
          />
          {photo ? (
            <ImageIcon className="size-7 text-nw-accent" aria-hidden />
          ) : (
            <Upload className="size-7 text-nw-accent" aria-hidden />
          )}
          {file ? (
            <>
              <span className="truncate text-sm font-semibold text-ink">{file.name}</span>
              <button
                type="button"
                className="text-xs font-semibold text-nw-accent-ink underline"
                onClick={() => fileInput.current?.click()}
              >
                choose another file
              </button>
            </>
          ) : (
            <>
              <span className="text-sm font-semibold text-ink">
                {photo ? 'Drop photo here or ' : 'Drop file here or '}
                <button
                  type="button"
                  className="text-nw-accent-ink underline"
                  onClick={() => fileInput.current?.click()}
                >
                  {photo ? 'Browse images' : 'browse files'}
                </button>
              </span>
              <span className="text-xs text-muted">
                {photo ? 'JPG, PNG or HEIC (max 10 MB)' : 'PDF or image · Maximum 20 MB'}
              </span>
            </>
          )}
        </div>
        <FormField label="Title" description="Filename is stored separately.">
          <Input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleEdited(true);
            }}
          />
        </FormField>
        {tracksExpiry ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={fixedTerm ? 'Report date' : 'Issue date (optional)'}>
              <DatePicker
                aria-label="Issue date"
                value={issuedOn}
                onIsoChange={(iso) => setIssuedOn(iso ?? '')}
              />
            </FormField>
            <FormField
              label={fixedTerm ? 'Due date' : 'Expiry date'}
              required={needsExpiry}
              description={
                dates.hint ??
                (fixedTerm
                  ? `Due ${fixedTerm} months after the report date (or today, when no date is entered).`
                  : 'Used for expiration reminders.')
              }
            >
              <DatePicker
                aria-label="Expiry date"
                value={expiresOn}
                onIsoChange={(iso) => setExpiresOn(iso ?? '')}
              />
            </FormField>
          </div>
        ) : null}
        <FormField label="Notes (optional)">
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add any notes about this document…"
          />
        </FormField>
        {!tracksExpiry ? (
          <p className="text-xs text-muted">This document does not expire.</p>
        ) : null}
      </div>
    </Modal>
  );
}
