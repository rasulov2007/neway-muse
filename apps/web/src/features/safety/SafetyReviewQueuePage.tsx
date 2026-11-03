import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Eye, X } from 'lucide-react';
import { SYSTEM_REQUIREMENTS, type ComplianceDocument } from '@neway/shared';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  FilterBar,
  Badge,
  Modal,
  PageHeader,
  Skeleton,
  Textarea,
  useToast,
} from '@/design-system';
import {
  listComplianceDocuments,
  rejectComplianceDocument,
  verifyComplianceDocument,
} from './compliance-api';
import { DocumentViewer } from '@/features/documents';
import { useInvalidateCompliance } from './useCompliance';
import { formatDateTime, formatIsoDate } from '@/lib/format';

/**
 * What Safety has been asked to look at.
 *
 * Documents arrived one driver at a time, and the only way to find them was to open each driver's
 * qualification file and look. So a licence uploaded on Tuesday sat unread until somebody thought
 * to check that driver — which is how a carrier ends up with a fleet of "pending verification"
 * and a dispatcher who has stopped believing the badge.
 *
 * This is that work as a queue: every document waiting for a decision, oldest first, because the
 * one that has been waiting longest is the one holding somebody up. Approving or refusing here
 * writes to the same record the driver's file reads — there is no second copy and no local state.
 */
const REQUIREMENT_NAME = new Map(SYSTEM_REQUIREMENTS.map((r) => [r.code, r.name]));

export function SafetyReviewQueuePage() {
  const [search, setSearch] = useState('');
  const [code, setCode] = useState('');

  const pending = useQuery({
    queryKey: ['compliance-documents', 'pending_review'],
    queryFn: () => listComplianceDocuments({ status: 'pending_review' }),
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (
      [...(pending.data ?? [])]
        // Oldest first: the longest wait is the one somebody is standing behind.
        .sort((a, b) => (a.uploadedAt < b.uploadedAt ? -1 : 1))
        .filter((doc) => {
          if (code && doc.requirementCode !== code) return false;
          if (!needle) return true;
          return [doc.ownerLabel, doc.title, doc.fileName, doc.uploadedBy]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(needle));
        })
    );
  }, [pending.data, search, code]);

  const codes = useMemo(() => {
    const seen = new Map<string, string>();
    for (const doc of pending.data ?? []) {
      seen.set(
        doc.requirementCode,
        REQUIREMENT_NAME.get(doc.requirementCode) ?? doc.requirementCode,
      );
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [pending.data]);

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Safety review"
        description="Documents waiting for a decision. Verifying one clears the requirement it stands against; refusing one sends it back with a reason."
        meta={
          <span className="text-sm text-secondary">
            {pending.isPending ? '—' : `${pending.data?.length ?? 0} waiting`}
          </span>
        }
      />

      <Card padding="none">
        <div className="border-b border-line px-5 py-3">
          <FilterBar
            search={{
              value: search,
              onChange: setSearch,
              placeholder: 'Search driver, document or who uploaded it',
            }}
            filters={[{ key: 'code', label: 'Document', type: 'select', options: codes }]}
            values={{ code }}
            onChange={(_key, value) => setCode(value == null ? '' : String(value))}
            onClear={() => {
              setSearch('');
              setCode('');
            }}
          />
        </div>

        {pending.isPending ? (
          <div className="flex flex-col gap-2 p-4" aria-busy>
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        ) : pending.isError ? (
          <ErrorState
            title="The review queue could not be loaded"
            error={pending.error}
            onRetry={() => void pending.refetch()}
            retrying={pending.isFetching}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing is waiting"
            description="Every document that has been uploaded has had a decision. New uploads appear here as they arrive."
          />
        ) : (
          <ul className="divide-y divide-line-soft">
            {rows.map((doc) => (
              <QueueRow key={doc.id} doc={doc} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function QueueRow({ doc }: { doc: ComplianceDocument }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateCompliance();
  const [rejecting, setRejecting] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [reason, setReason] = useState('');

  const refresh = async () => {
    await invalidate();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['compliance-documents'] }),
      // The onboarding board reads these counts; a decision here moves a case there.
      queryClient.invalidateQueries({ queryKey: ['hr'] }),
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
    ]);
  };

  const verify = useMutation({
    mutationFn: () => verifyComplianceDocument(doc.id),
    onSuccess: async () => {
      await refresh();
      toast({
        tone: 'success',
        title: `${doc.title} verified`,
        description: `${doc.ownerLabel} — the requirement now reads valid.`,
      });
    },
  });

  const reject = useMutation({
    mutationFn: () => rejectComplianceDocument(doc.id, { reason: reason.trim() }),
    onSuccess: async () => {
      await refresh();
      toast({
        tone: 'warning',
        title: `${doc.title} refused`,
        description: 'The reason is on the record and a replacement can be uploaded.',
      });
      setRejecting(false);
      setReason('');
    },
  });

  return (
    <li className="flex flex-wrap items-start gap-3 px-5 py-3">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          {/* The store calls it pending_review; a person reading a queue calls it waiting. */}
          <Badge tone="info" size="sm">
            Waiting for Safety
          </Badge>
          <span className="text-sm font-medium text-ink">
            {REQUIREMENT_NAME.get(doc.requirementCode) ?? doc.title}
          </span>
          <span className="text-sm text-secondary">·</span>
          {doc.ownerType === 'driver' ? (
            <Link
              to="/drivers/$driverId"
              params={{ driverId: doc.ownerId }}
              className="text-sm text-primary-text hover:underline"
            >
              {doc.ownerLabel}
            </Link>
          ) : (
            <span className="text-sm text-ink">{doc.ownerLabel}</span>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-muted">
          {doc.fileName} · uploaded by {doc.uploadedBy} · {formatDateTime(doc.uploadedAt)}
          {doc.expiresOn ? ` · expires ${formatIsoDate(doc.expiresOn)}` : ''}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1.5">
        {doc.hasFile ? (
          /*
           * The app's own viewer. The file is served by the API behind the session, and a browser
           * navigation carries no Authorization header - the anchor that used to be here asked the
           * API without a token, got 401, and looked like a dead link.
           */
          <Button size="sm" variant="secondary" icon={<Eye />} onClick={() => setViewing(true)}>
            View
          </Button>
        ) : (
          <span className="text-xs text-faint">No file held</span>
        )}
        <Button
          size="sm"
          icon={<Check />}
          loading={verify.isPending}
          onClick={() => verify.mutate()}
        >
          Verify
        </Button>
        <Button size="sm" variant="ghost" icon={<X />} onClick={() => setRejecting(true)}>
          Reject
        </Button>
      </span>

      <Modal
        open={rejecting}
        onOpenChange={(next) => {
          if (!next) setRejecting(false);
        }}
        size="sm"
        title={`Refuse ${doc.title}`}
        description={`${doc.ownerLabel} is told why, and the requirement reads verification failed until a replacement is verified.`}
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
              Refuse document
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Alert
            tone="warning"
            title="A refusal needs a reason"
            description="It is shown to whoever collects the replacement, so say what was wrong with this one."
          />
          <Textarea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="The expiry on the card does not match the date entered"
          />
        </div>
      </Modal>

      {viewing ? (
        <DocumentViewer
          source={{ kind: 'compliance', id: doc.id }}
          title={REQUIREMENT_NAME.get(doc.requirementCode) ?? doc.title}
          subtitle={`${doc.ownerLabel} · ${doc.fileName} · uploaded ${formatDateTime(doc.uploadedAt)} by ${doc.uploadedBy}`}
          contentType={doc.contentType}
          fileName={doc.fileName}
          onClose={() => setViewing(false)}
        />
      ) : null}
    </li>
  );
}
