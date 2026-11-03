import { useMutation, useQuery } from '@tanstack/react-query';
import type { ComplianceScope, EntityCompliance, EvaluatedItem } from '@neway/shared';
import { Check, Eye, FileText, ShieldOff, Upload, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ComplianceDocument, ConsentRequest } from '@neway/shared';
import {
  listComplianceAudit,
  listComplianceDocuments,
  listConsentRequests,
  rejectComplianceDocument,
  verifyComplianceDocument,
  waiveQualificationItem,
} from './compliance-api';
import {
  DatePicker,
  Badge,
  Button,
  Drawer,
  EmptyState,
  Modal,
  Skeleton,
  StatusBadge,
  Tabs,
  Textarea,
  Timeline,
  useToast,
} from '@/design-system';
import { formatDate, formatDateTime, formatIsoDate, formatRelative } from '@/lib/format';
import {
  CONSENT_PURPOSE_LABEL,
  ROLE_LABEL,
  SCOPE_LABEL,
  SEVERITY_TONE,
  groupOpenItems,
  pendingDocumentFor,
} from './compliance-ui';
import { DocumentViewer } from '@/features/documents';
import { ExpiryBadge } from '@/features/documents/ExpiryBadge';
import { today } from '@/lib/clock';
import { UploadDocumentDialog } from './UploadDocumentDialog';
import { useInvalidateCompliance } from './useCompliance';

const TABS = [
  { value: 'requirements', label: 'Requirements' },
  { value: 'documents', label: 'Documents' },
  { value: 'consents', label: 'Consents' },
  { value: 'audit', label: 'Audit trail' },
] as const;
type DrawerTab = (typeof TABS)[number]['value'];

export interface EntityComplianceDrawerProps {
  entity: EntityCompliance | null;
  onClose: () => void;
}

/**
 * One driver, unit or trailer against every rule that applies to it, with the evidence for each
 * verdict and the actions that change it. Verify, reject and waive write through the demo data
 * layer and append to the audit trail, then the whole bundle re-evaluates.
 */
export function EntityComplianceDrawer({ entity, onClose }: EntityComplianceDrawerProps) {
  const open = entity !== null;
  const [tabState, setTabState] = useState<{ key: string | null; tab: DrawerTab }>({
    key: null,
    tab: 'requirements',
  });
  const key = entity ? `${entity.scope}:${entity.entityId}` : null;
  const tab = tabState.key === key ? tabState.tab : 'requirements';
  const setTab = (next: DrawerTab) => setTabState({ key, tab: next });
  const tabs = entity?.scope === 'driver' ? [...TABS] : TABS.filter((t) => t.value !== 'consents');

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      title={entity?.entityLabel ?? ''}
      description={
        entity
          ? `${SCOPE_LABEL[entity.scope]} · ${entity.counts.satisfied} of ${entity.counts.total} requirements satisfied`
          : undefined
      }
      headerExtra={
        entity ? (
          <span className="flex items-center gap-1.5">
            <StatusBadge status={entity.state} size="sm" />
            {entity.dispatchable ? null : (
              <Badge tone="danger" size="sm" icon={<ShieldOff />}>
                Dispatch hold
              </Badge>
            )}
          </span>
        ) : null
      }
      tabs={
        entity ? (
          <Tabs
            items={tabs}
            value={tab}
            onValueChange={(next) => setTab(next as DrawerTab)}
            size="sm"
            aria-label="Compliance sections"
            listClassName="-mb-px border-b-0"
          />
        ) : null
      }
      bodyClassName="bg-app"
    >
      {entity ? (
        <div className="flex flex-col gap-4">
          {tab === 'requirements' ? <RequirementsTab entity={entity} /> : null}
          {tab === 'documents' ? <DocumentsTab entity={entity} /> : null}
          {tab === 'consents' ? <ConsentsTab entity={entity} /> : null}
          {tab === 'audit' ? <AuditTab entity={entity} /> : null}
        </div>
      ) : null}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------------------------

function RequirementsTab({ entity }: { entity: EntityCompliance }) {
  const groups = groupOpenItems(entity);
  const fine = entity.items.filter((i) => i.requiredAction === null);
  // The documents behind the items: a pending item's action is to verify what is attached, and
  // that needs the document, not the item.
  const documents = useQuery({
    queryKey: ['compliance-documents', entity.scope, entity.entityId],
    queryFn: () => listComplianceDocuments({ ownerType: entity.scope, ownerId: entity.entityId }),
    enabled: groups.some((g) => g.group === 'pending'),
  });
  return (
    <>
      {entity.gateReasons.length > 0 ? (
        <div className="rounded-lg border border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger-text">
          <p className="font-medium">Cannot be dispatched</p>
          <ul className="mt-1 list-disc pl-5">
            {entity.gateReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Missing · Pending verification · Expiring · Expired, each with its count, so what needs
          chasing and what needs reviewing never sit in one list. The dispatch hold above is
          untouched by this grouping - it is how the items are read, not what they mean. */}
      {groups.map((group) => (
        <Section key={group.group} title={`${group.label} (${group.items.length})`}>
          {group.items.map((item) => (
            <RequirementRow
              key={item.requirementCode}
              item={item}
              scope={entity.scope}
              pendingDoc={
                group.group === 'pending' ? pendingDocumentFor(item, documents.data ?? []) : null
              }
            />
          ))}
        </Section>
      ))}
      <Section title={`In order (${fine.length})`}>
        {fine.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">Nothing is in order yet.</p>
        ) : (
          fine.map((item) => (
            <RequirementRow key={item.requirementCode} item={item} scope={entity.scope} />
          ))
        )}
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      <h3 className="eyebrow border-b border-line-soft px-4 py-2">{title}</h3>
      <ul className="divide-y divide-line-soft">{children}</ul>
    </section>
  );
}

function RequirementRow({
  item,
  scope,
  pendingDoc = null,
}: {
  item: EvaluatedItem;
  scope: ComplianceScope;
  /** The attached document waiting on safety, when the item is pending verification. */
  pendingDoc?: ComplianceDocument | null;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateCompliance();
  const [waiving, setWaiving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const unsatisfied = item.requiredAction !== null;
  const pending = item.status === 'pending_verification';
  const verify = useMutation({
    mutationFn: () => verifyComplianceDocument((pendingDoc as ComplianceDocument).id),
    onSuccess: async () => {
      await invalidate();
      toast({ tone: 'success', title: `${item.requirementName} verified` });
    },
  });
  // Statuses whose urgency really is the expiry date; every other unsatisfied status is due now.
  const expiryDriven =
    item.status === 'expiring' ||
    item.status === 'expired' ||
    item.status === 'valid' ||
    item.status === 'verified' ||
    item.status === 'waived';
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={item.status} size="sm" />
            <span className="text-sm font-medium text-ink">{item.requirementName}</span>
            {item.blocksDispatch ? (
              <Badge tone="danger" size="sm" variant="outline">
                Blocks dispatch
              </Badge>
            ) : null}
            {item.inGracePeriod ? (
              <Badge tone="warning" size="sm" variant="outline">
                Grace period
              </Badge>
            ) : null}
          </div>
          <ul className="mt-1 text-xs text-secondary">
            {item.reasons.map((reason) => (
              <li key={reason}>· {reason}</li>
            ))}
          </ul>
        </div>
        {/* Countdown only where the expiry *is* the deadline. A missing or rejected document is
            due now regardless of the date on the record, so showing "in 239d" beside it would
            read as "not urgent" for the most urgent state there is. */}
        <div className="text-right text-xs whitespace-nowrap text-muted">
          {expiryDriven && item.expiresOn ? (
            <>
              {/* The colour and words are the product-wide expiry bands (expiryTone); the
                  engine's status and severity still decide reminders and holds. */}
              <ExpiryBadge
                expiresOn={item.expiresOn}
                today={today()}
                variant="text"
                className="justify-end"
              />
              <span className="block">{formatIsoDate(item.expiresOn)}</span>
            </>
          ) : unsatisfied ? (
            <>
              <span className="block font-medium text-danger-text">Due now</span>
              {item.expiresOn ? <span>on file until {formatIsoDate(item.expiresOn)}</span> : null}
            </>
          ) : (
            <Badge tone={SEVERITY_TONE[item.severity]} size="sm" variant="outline">
              {item.severity === 'ok' ? 'No expiry' : item.severity}
            </Badge>
          )}
        </div>
      </div>
      {unsatisfied ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line-soft bg-surface px-3 py-2">
          <div className="text-xs">
            <span className="font-medium text-ink">{item.requiredAction}</span>
            <span className="block text-muted">
              Owner {ROLE_LABEL[item.owner]} · notify{' '}
              {item.notify.map((r) => ROLE_LABEL[r]).join(', ')}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* A pending item has its document; the job is to review it, not to ask for it. */}
            {pending && pendingDoc ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Check />}
                loading={verify.isPending}
                onClick={() => verify.mutate()}
              >
                Verify
              </Button>
            ) : null}
            {/* Every unsatisfied requirement can be answered with a document — including one that
                has no item row yet, which is the state a newly hired driver is entirely made of. */}
            <Button
              variant={pending && pendingDoc ? 'ghost' : 'secondary'}
              size="sm"
              icon={<Upload />}
              onClick={() => setUploading(true)}
            >
              {pending && pendingDoc ? 'Replace…' : 'Attach…'}
            </Button>
            {item.itemId && item.status !== 'waived' ? (
              <Button variant="ghost" size="sm" onClick={() => setWaiving(true)}>
                Waive…
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {item.itemId ? (
        <WaiveDialog
          itemId={item.itemId}
          name={item.requirementName}
          open={waiving}
          onOpenChange={setWaiving}
        />
      ) : null}
      {uploading ? (
        <UploadDocumentDialog item={item} ownerType={scope} open onOpenChange={setUploading} />
      ) : null}
    </li>
  );
}

export function WaiveDialog({
  itemId,
  name,
  open,
  onOpenChange,
}: {
  itemId: string;
  name: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateCompliance();
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const waive = useMutation({
    mutationFn: () => waiveQualificationItem(itemId, { until, reason }),
    onSuccess: async () => {
      await invalidate();
      toast({ tone: 'success', title: `${name} waived until ${until}` });
      onOpenChange(false);
    },
  });
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(until) && reason.trim().length > 0;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={`Waive ${name}`}
      description="A waiver is management accepting a known gap for a fixed period. It is recorded with your name and the reason, and the requirement re-evaluates the day it ends."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={waive.isPending}
            onClick={() => waive.mutate()}
          >
            Record waiver
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Waived until</span>
          <DatePicker value={until} onIsoChange={setUntil} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Reason</span>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Renewal receipt on file; new card in the mail"
          />
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

function DocumentsTab({ entity }: { entity: EntityCompliance }) {
  const query = useQuery({
    queryKey: ['compliance-documents', entity.scope, entity.entityId],
    queryFn: () => listComplianceDocuments({ ownerType: entity.scope, ownerId: entity.entityId }),
  });
  if (query.isPending) return <Skeleton variant="text" lines={6} />;
  const docs = query.data ?? [];
  if (docs.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={<FileText />}
        title="No documents on file"
        description="Nothing has been uploaded for this record yet."
      />
    );
  }
  return (
    <Section title={`Documents (${docs.length})`}>
      {docs.map((doc) => (
        <DocumentRow key={doc.id} doc={doc} />
      ))}
    </Section>
  );
}

export function DocumentRow({ doc }: { doc: ComplianceDocument }) {
  const { toast } = useToast();
  const invalidate = useInvalidateCompliance();
  const [rejecting, setRejecting] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [reason, setReason] = useState('');
  const verify = useMutation({
    mutationFn: () => verifyComplianceDocument(doc.id),
    onSuccess: async () => {
      await invalidate();
      toast({ tone: 'success', title: `${doc.title} verified` });
    },
  });
  const reject = useMutation({
    mutationFn: () => rejectComplianceDocument(doc.id, { reason }),
    onSuccess: async () => {
      await invalidate();
      toast({ tone: 'warning', title: `${doc.title} rejected` });
      setRejecting(false);
    },
  });
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={doc.status} size="sm" />
            <span className="text-sm font-medium text-ink">{doc.title}</span>
            <span className="text-xs text-muted">v{doc.version}</span>
            {doc.containsPii ? (
              <Badge tone="neutral" size="sm" variant="outline">
                PII
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {doc.hasFile ? (
              // In the app's own viewer, never an anchor to the API: a browser navigation carries
              // no session token, so the link answered 401 and the click did nothing.
              <button
                type="button"
                onClick={() => setViewing(true)}
                className="text-primary-text hover:underline"
              >
                {doc.fileName}
              </button>
            ) : (
              <span title="Recorded, but the file itself is not held by this system">
                {doc.fileName}
              </span>
            )}
            {' · '}uploaded {formatRelative(doc.uploadedAt)} by {doc.uploadedBy} via{' '}
            {doc.source.replace(/_/g, ' ')}
            {doc.issuedOn ? ` · issued ${formatIsoDate(doc.issuedOn)}` : ''}
            {doc.expiresOn ? ` · expires ${formatIsoDate(doc.expiresOn)}` : ''}
          </p>
          {doc.verifiedAt ? (
            <p className="mt-0.5 text-xs text-success-text">
              Verified {formatDateTime(doc.verifiedAt)} by {doc.verifiedBy}
            </p>
          ) : null}
          {doc.rejectionReason ? (
            <p className="mt-0.5 text-xs text-danger-text">Rejected: {doc.rejectionReason}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {doc.hasFile ? (
            <Button variant="secondary" size="sm" icon={<Eye />} onClick={() => setViewing(true)}>
              View
            </Button>
          ) : null}
          {doc.status === 'pending_review' ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={<Check />}
                loading={verify.isPending}
                onClick={() => verify.mutate()}
              >
                Verify
              </Button>
              <Button variant="ghost" size="sm" icon={<X />} onClick={() => setRejecting(true)}>
                Reject
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {viewing ? (
        <DocumentViewer
          source={{ kind: 'compliance', id: doc.id }}
          title={doc.title}
          subtitle={`${doc.fileName} · uploaded ${formatDateTime(doc.uploadedAt)} by ${doc.uploadedBy}`}
          contentType={doc.contentType}
          fileName={doc.fileName}
          onClose={() => setViewing(false)}
        />
      ) : null}
      <Modal
        open={rejecting}
        onOpenChange={setRejecting}
        size="sm"
        title={`Reject ${doc.title}`}
        description="The driver or fleet owner is told why, and the requirement reads verification failed until a new document is verified."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={reason.trim().length === 0}
              loading={reject.isPending}
              onClick={() => reject.mutate()}
            >
              Reject document
            </Button>
          </>
        }
      >
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why this document cannot be accepted"
          aria-label="Rejection reason"
        />
      </Modal>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------

function ConsentsTab({ entity }: { entity: EntityCompliance }) {
  const query = useQuery({
    queryKey: ['consents', 'driver', entity.entityId],
    queryFn: () => listConsentRequests({ driverId: entity.entityId }),
  });
  if (query.isPending) return <Skeleton variant="text" lines={5} />;
  const consents = query.data ?? [];
  if (consents.length === 0) {
    return (
      <EmptyState
        size="sm"
        title="No consent requests"
        description="Create one from the consent center when a check needs authorization."
      />
    );
  }
  return (
    <Section title={`Consent (${consents.length})`}>
      {consents.map((c) => (
        <ConsentSummaryRow key={c.id} consent={c} />
      ))}
    </Section>
  );
}

function ConsentSummaryRow({ consent }: { consent: ConsentRequest }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={consent.status} size="sm" />
        <span className="text-sm font-medium text-ink">
          {CONSENT_PURPOSE_LABEL[consent.purpose]}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        Requested {formatDate(consent.requestedAt)} by {consent.requestedBy}
        {consent.sentAt ? ` · sent ${formatDate(consent.sentAt)}` : ''}
        {consent.signedAt
          ? ` · signed ${formatDateTime(consent.signedAt)} by ${consent.signerName} (${consent.signerChannel?.replace(/_/g, ' ')})`
          : ''}
        {consent.declinedAt ? ` · declined ${formatDate(consent.declinedAt)}` : ''}
        {consent.status === 'sent' || consent.status === 'viewed'
          ? ` · link expires ${formatDate(consent.expiresAt)}`
          : ''}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------

function AuditTab({ entity }: { entity: EntityCompliance }) {
  const query = useQuery({
    queryKey: ['compliance-audit', entity.entityId],
    queryFn: () => listComplianceAudit({ entityId: entity.entityId, limit: 100 }),
  });
  if (query.isPending) return <Skeleton variant="text" lines={6} />;
  const entries = query.data ?? [];
  if (entries.length === 0) {
    return (
      <EmptyState
        size="sm"
        title="No audit entries"
        description="Changes to this record will be listed here with who made them and why."
      />
    );
  }
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-2">
      <Timeline
        items={entries.map((e) => ({
          id: e.id,
          at: e.at,
          title: e.action.replace(/_/g, ' '),
          description: (
            <span>
              {e.subject ? <span className="text-ink">{e.subject}</span> : null}
              {e.before || e.after ? (
                <span className="block text-xs text-muted">
                  {e.before ?? '—'} → {e.after ?? '—'}
                </span>
              ) : null}
              {e.reason ? <span className="block text-xs text-muted">{e.reason}</span> : null}
            </span>
          ),
          actor: { name: e.actorName },
        }))}
        formatTime={(date) => formatDateTime(date)}
      />
    </div>
  );
}
