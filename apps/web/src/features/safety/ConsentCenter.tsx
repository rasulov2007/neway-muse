import { useMutation, useQuery } from '@tanstack/react-query';
import { Ban, Plus, RefreshCw, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ConsentPurpose, ConsentRequest, ConsentStatus } from '@neway/shared';
import { listDrivers } from '@/demo';
import {
  cancelConsentRequest,
  createConsentRequest,
  listConsentRequests,
  respondToConsentRequest,
  sendConsentRequest,
} from './compliance-api';
import {
  Badge,
  Button,
  Card,
  DropdownMenu,
  EmptyState,
  ErrorState,
  FilterBar,
  IconButton,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Modal,
  Select,
  Skeleton,
  StatusBadge,
  cn,
  getStatus,
  useToast,
} from '@/design-system';
import { Ellipsis } from 'lucide-react';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';
import { CONSENT_PURPOSE_LABEL } from './compliance-ui';
import { useInvalidateCompliance } from './useCompliance';

const STATUSES: ConsentStatus[] = [
  'draft',
  'sent',
  'viewed',
  'signed',
  'declined',
  'expired',
  'cancelled',
];
const PURPOSES = Object.keys(CONSENT_PURPOSE_LABEL) as ConsentPurpose[];

/**
 * Consent centre: every authorization request, its exact purpose, and where it is in its life.
 * A consent is never generic — an MVR authorization does not cover a background check — so the
 * purpose is the first thing on every row.
 */
export function ConsentCenter() {
  const { toast } = useToast();
  const invalidate = useInvalidateCompliance();
  const consents = useQuery({
    queryKey: ['consents', 'all'],
    queryFn: () => listConsentRequests(),
  });
  const [status, setStatus] = useState<string | undefined>();
  const [purpose, setPurpose] = useState<string | undefined>();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rank: Record<ConsentStatus, number> = {
      declined: 0,
      expired: 1,
      viewed: 2,
      sent: 3,
      draft: 4,
      signed: 5,
      cancelled: 6,
    };
    return (consents.data ?? [])
      .filter((c) => !status || c.status === status)
      .filter((c) => !purpose || c.purpose === purpose)
      .filter((c) => !needle || c.driverName.toLowerCase().includes(needle))
      .sort(
        (a, b) => rank[a.status] - rank[b.status] || b.requestedAt.localeCompare(a.requestedAt),
      );
  }, [consents.data, status, purpose, q]);

  const counts = useMemo(() => {
    const map = new Map<ConsentStatus, number>();
    for (const c of consents.data ?? []) map.set(c.status, (map.get(c.status) ?? 0) + 1);
    return map;
  }, [consents.data]);

  const act = useMutation({
    mutationFn: async (input: {
      id: string;
      action: 'send' | 'cancel' | 'viewed' | 'signed' | 'declined';
      driverName: string;
    }) => {
      switch (input.action) {
        case 'send':
          return sendConsentRequest(input.id);
        case 'cancel':
          return cancelConsentRequest(input.id);
        default:
          return respondToConsentRequest(input.id, {
            outcome: input.action,
            signerName: input.driverName,
          });
      }
    },
    onSuccess: async (result, input) => {
      await invalidate();
      if (!result) return;
      toast({
        tone: input.action === 'declined' ? 'warning' : 'success',
        title: `${CONSENT_PURPOSE_LABEL[result.purpose]} for ${result.driverName}: ${getStatus(result.status).label.toLowerCase()}`,
      });
    },
  });

  if (consents.isError) {
    return (
      <ErrorState
        title="Consent requests couldn't be loaded"
        error={consents.error}
        onRetry={() => void consents.refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {STATUSES.map((s) => {
          const n = counts.get(s) ?? 0;
          const active = status === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(active ? undefined : s)}
              className={cn(
                'rounded-lg border bg-surface px-3 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                active ? 'border-primary-border ring-1 ring-primary-border' : 'border-line',
              )}
              aria-pressed={active}
            >
              <StatusBadge status={s} size="sm" />
              <span
                className={cn(
                  'tabular mt-1.5 block text-xl font-semibold',
                  n > 0 ? 'text-ink' : 'text-faint',
                )}
              >
                {n}
              </span>
            </button>
          );
        })}
      </div>

      <Card
        padding="none"
        title="Consent requests"
        description={
          consents.data
            ? `${consents.data.length} total · ${(counts.get('sent') ?? 0) + (counts.get('viewed') ?? 0)} awaiting signature`
            : undefined
        }
        actions={
          <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setCreating(true)}>
            New request
          </Button>
        }
        data-testid="consent-center"
      >
        <div className="border-b border-line-soft px-(--card-padding) py-2">
          <FilterBar
            search={{ value: q, onChange: setQ, placeholder: 'Search driver' }}
            filters={[
              {
                key: 'status',
                label: 'Status',
                type: 'select',
                options: STATUSES.map((s) => ({ value: s, label: getStatus(s).label })),
              },
              {
                key: 'purpose',
                label: 'Purpose',
                type: 'select',
                options: PURPOSES.map((p) => ({ value: p, label: CONSENT_PURPOSE_LABEL[p] })),
              },
            ]}
            values={{ status, purpose }}
            onChange={(key, value) =>
              (key === 'status' ? setStatus : setPurpose)(
                (value as string | undefined) || undefined,
              )
            }
            onClear={() => {
              setStatus(undefined);
              setPurpose(undefined);
              setQ('');
            }}
          />
        </div>
        {consents.isPending ? (
          <div className="p-(--card-padding)">
            <Skeleton variant="text" lines={8} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No consent requests match"
            description="Try clearing the filters, or create a new request."
          />
        ) : (
          <div className="scroll-quiet relative w-full overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-soft bg-surface-muted text-xs text-secondary">
                  <th className="px-4 py-2 text-left font-semibold whitespace-nowrap">Driver</th>
                  <th className="px-4 py-2 text-left font-semibold whitespace-nowrap">Purpose</th>
                  <th className="px-4 py-2 text-left font-semibold whitespace-nowrap">Status</th>
                  <th className="px-4 py-2 text-left font-semibold whitespace-nowrap">Requested</th>
                  <th className="px-4 py-2 text-left font-semibold whitespace-nowrap">Sent</th>
                  <th className="px-4 py-2 text-left font-semibold whitespace-nowrap">Signed</th>
                  <th className="px-4 py-2 text-left font-semibold whitespace-nowrap">
                    Link expires
                  </th>
                  <th className="px-4 py-2 text-right font-semibold whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {rows.map((c) => (
                  <ConsentRow
                    key={c.id}
                    consent={c}
                    busy={act.isPending}
                    onAct={(action) => act.mutate({ id: c.id, action, driverName: c.driverName })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <NewConsentModal open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function ConsentRow({
  consent,
  busy,
  onAct,
}: {
  consent: ConsentRequest;
  busy: boolean;
  onAct: (action: 'send' | 'cancel' | 'viewed' | 'signed' | 'declined') => void;
}) {
  const canSend = consent.status === 'draft';
  const canResend =
    consent.status === 'sent' || consent.status === 'viewed' || consent.status === 'expired';
  const canCancel =
    consent.status === 'draft' || consent.status === 'sent' || consent.status === 'viewed';
  const awaiting = consent.status === 'sent' || consent.status === 'viewed';
  return (
    <tr className="align-top hover:bg-surface-hover">
      <td className="px-4 py-2.5 font-medium text-ink">{consent.driverName}</td>
      <td className="px-4 py-2.5">
        <span className="block text-ink">
          {CONSENT_PURPOSE_LABEL[consent.purpose]}
          {consent.subject ? <span className="text-secondary"> · {consent.subject}</span> : null}
        </span>
        <span className="block text-xs text-muted">
          unlocks {consent.requirementCode.replace(/_/g, ' ')}
        </span>
      </td>
      <td className="px-4 py-2.5">
        <StatusBadge status={consent.status} size="sm" />
      </td>
      <td className="px-4 py-2.5 text-xs whitespace-nowrap text-secondary">
        {formatDate(consent.requestedAt)}
        <span className="block text-muted">by {consent.requestedBy}</span>
      </td>
      <td className="px-4 py-2.5 text-xs whitespace-nowrap text-secondary">
        {consent.sentAt ? formatRelative(consent.sentAt) : '—'}
      </td>
      <td className="px-4 py-2.5 text-xs whitespace-nowrap text-secondary">
        {consent.signedAt ? (
          <>
            {formatDateTime(consent.signedAt)}
            <span className="block text-muted">
              {consent.signerName} · {consent.signerChannel?.replace(/_/g, ' ')}
            </span>
          </>
        ) : consent.declinedAt ? (
          <span className="text-danger-text">Declined {formatDate(consent.declinedAt)}</span>
        ) : (
          '—'
        )}
      </td>
      <td
        className={cn(
          'px-4 py-2.5 text-xs whitespace-nowrap',
          consent.status === 'expired' ? 'text-danger-text' : 'text-secondary',
        )}
      >
        {awaiting || consent.status === 'expired' ? formatDate(consent.expiresAt) : '—'}
      </td>
      <td className="px-4 py-2.5">
        <span className="flex items-center justify-end gap-1">
          {canSend ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Send />}
              disabled={busy}
              onClick={() => onAct('send')}
            >
              Send
            </Button>
          ) : canResend ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw />}
              disabled={busy}
              onClick={() => onAct('send')}
            >
              Resend
            </Button>
          ) : null}
          <DropdownMenu
            align="end"
            trigger={
              <IconButton label={`Actions for ${consent.driverName}`} variant="ghost" size="sm">
                <Ellipsis />
              </IconButton>
            }
          >
            <MenuLabel>{CONSENT_PURPOSE_LABEL[consent.purpose]}</MenuLabel>
            {canCancel ? (
              <MenuItem icon={<Ban />} destructive onSelect={() => onAct('cancel')}>
                Cancel request
              </MenuItem>
            ) : null}
            {awaiting ? (
              <>
                <MenuSeparator />
                {/* There is no driver portal yet, so the driver's side of the exchange is played from
                    here. Labelled as such so nobody mistakes it for a real signature. */}
                <MenuLabel>Demo: driver responds</MenuLabel>
                {consent.status === 'sent' ? (
                  <MenuItem onSelect={() => onAct('viewed')}>Driver opened the link</MenuItem>
                ) : null}
                <MenuItem onSelect={() => onAct('signed')}>Driver signs</MenuItem>
                <MenuItem onSelect={() => onAct('declined')}>Driver declines</MenuItem>
              </>
            ) : null}
            {!canCancel && !awaiting ? <MenuItem disabled>No actions available</MenuItem> : null}
          </DropdownMenu>
        </span>
      </td>
    </tr>
  );
}

function NewConsentModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateCompliance();
  const drivers = useQuery({
    queryKey: ['drivers', 'consent-picker'],
    queryFn: () => listDrivers({ pageSize: 10_000 }),
    enabled: open,
  });
  const [driverId, setDriverId] = useState('');
  const [purpose, setPurpose] = useState<ConsentPurpose>('mvr');
  const create = useMutation({
    mutationFn: () => createConsentRequest({ driverId, purpose }),
    onSuccess: async (created) => {
      await invalidate();
      toast({
        tone: 'success',
        title: `Consent request drafted for ${created.driverName}`,
        description: 'Send it when the driver is ready to sign.',
      });
      onOpenChange(false);
      setDriverId('');
    },
  });
  const options = (drivers.data?.data ?? [])
    .filter((d) => d.status !== 'terminated')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ value: d.id, label: `${d.name} · ${d.driverNumber}` }));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="New consent request"
      description="Pick the driver and the exact purpose. The request starts as a draft; sending it opens a signing link that expires in 14 days."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!driverId}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create draft
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Driver</span>
          <Select
            aria-label="Driver"
            options={options}
            value={driverId}
            onValueChange={setDriverId}
            placeholder={drivers.isPending ? 'Loading drivers…' : 'Choose a driver'}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Purpose</span>
          <Select
            aria-label="Purpose"
            options={PURPOSES.map((p) => ({ value: p, label: CONSENT_PURPOSE_LABEL[p] }))}
            value={purpose}
            onValueChange={(v) => setPurpose(v as ConsentPurpose)}
          />
        </label>
        <p className="text-xs text-muted">
          <Badge tone="neutral" size="sm" variant="outline">
            Purpose-bound
          </Badge>{' '}
          An authorization for one purpose never covers another.
        </p>
      </div>
    </Modal>
  );
}
