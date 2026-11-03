import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleCheck, ExternalLink, ShieldCheck, Wrench } from 'lucide-react';
import { useState } from 'react';
import { canTransition, PTI_DEFECT_SEVERITY_LABEL, type PtiDefect } from '@neway/shared';
import { Button, ConfirmDialog, SectionCard, StatusBadge, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { nowMs } from '@/lib/clock';
import { formatDate, formatIsoDate, formatRelative } from '@/lib/format';
import { openWorkOrderForDefect, ptiKeys, useTransitionDefect, useUnitServiceStatus } from './api';
import { workOrderLink } from './links';

/**
 * Truck Health's "Open defects": the same records the board shows, read from the same place
 * (§4.5). The verdict at the top is the one the header carries; the rows are what it is made of.
 *
 * Two actions, deliberately. "Fixed" is anyone's word that the repair happened and proposes
 * closure; "Verify & clear" is safety's confirmation, the only action that lifts a hold (§4.4).
 * Everything else about a defect - owner, due date, severity, work order - is edited on the
 * board, so there is one place to look for who changed what.
 */
export function OpenDefectsCard({ unitId }: { unitId: string }) {
  const status = useUnitServiceStatus(unitId);
  const defects = status.data?.defects ?? [];
  const verdict = status.data?.verdict;

  return (
    <SectionCard
      icon={<ShieldCheck />}
      title="Open defects"
      description={
        status.isPending
          ? 'Loading…'
          : verdict?.reason
            ? `${verdict.reason}${verdict.releaseCondition ? ` — ${verdict.releaseCondition}` : ''}`
            : 'Nothing open. A defect found on the walk-around appears here until safety verifies the repair.'
      }
      padding="sm"
      actions={
        <Button size="sm" variant="secondary" asChild>
          <Link to="/fleet/pti">
            <ExternalLink aria-hidden />
            PTI board
          </Link>
        </Button>
      }
    >
      {status.isPending ? (
        <p className="py-2 text-sm text-muted">Loading…</p>
      ) : status.isError ? (
        <p className="py-2 text-sm text-nw-urgent-text">The defects could not be loaded.</p>
      ) : defects.length === 0 ? (
        <p className="py-2 text-sm text-muted">No open defects.</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {defects.map((defect) => (
            <DefectRow key={defect.id} defect={defect} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function DefectRow({ defect }: { defect: PtiDefect }) {
  const { toast } = useToast();
  const account = useAccount();
  const queryClient = useQueryClient();
  const transition = useTransitionDefect();
  const [verifying, setVerifying] = useState(false);
  const canVerify = defect.state === 'fixed_pending_verify' && (account?.permissions.some((p) => p === 'safety.manage' || p === 'pti.verify') ?? false);
  const canPropose = canTransition(defect.state, 'fixed_pending_verify');
  const canWrite = account?.permissions.includes('maintenance.edit') ?? false;
  // A shop order from the defect, pre-linked (WP6). Offered until the defect has one.
  const canOpenOrder = canWrite && !defect.workOrderId && defect.state !== 'fixed_pending_verify';
  const openOrder = useMutation({
    mutationFn: () => openWorkOrderForDefect(defect),
    onSuccess: async (order) => {
      await queryClient.invalidateQueries({ queryKey: ptiKeys.all });
      await queryClient.invalidateQueries({ queryKey: ['fleet'] });
      toast({ tone: 'success', title: `${order.number} opened for ${defect.defectNumber}`, description: 'The unit is in the shop; the defect is in repair.' });
    },
    onError: (error: unknown) => toast({ tone: 'danger', title: 'The work order could not be opened', description: error instanceof Error ? error.message : undefined }),
  });
  const overdue = defect.dueAt !== null && new Date(defect.dueAt).getTime() < nowMs() && defect.state !== 'fixed_pending_verify';

  const fail = (title: string) => (error: unknown) =>
    toast({ tone: 'danger', title, description: error instanceof Error ? error.message : undefined });

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-2.5 text-sm">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{defect.defectNumber}</span>
          <span className="text-ink">{defect.componentName}</span>
          <StatusBadge status={defect.severity} label={PTI_DEFECT_SEVERITY_LABEL[defect.severity]} size="sm" />
          <StatusBadge status={defect.state} size="sm" />
        </span>
        <span className="text-ink">{defect.description}</span>
        <span className="text-xs text-muted">
          Found {formatIsoDate(defect.createdAt.slice(0, 10))} ({formatRelative(defect.createdAt)})
          {defect.dueAt ? (
            <>
              {' · '}
              <span className={overdue ? 'font-medium text-nw-urgent-text' : undefined}>
                {overdue ? 'was due' : 'due'} {formatDate(defect.dueAt)}
              </span>
            </>
          ) : null}
          {' · '}
          {defect.ownerName ? `owner ${defect.ownerName}` : 'no owner yet'}
          {defect.workOrderId && defect.workOrderNumber ? (
            <>
              {' · '}
              <Link {...workOrderLink(defect.workOrderId)} className="font-medium text-primary-text hover:underline">
                {defect.workOrderNumber}
              </Link>
            </>
          ) : null}
        </span>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        {canOpenOrder ? (
          <Button size="sm" variant="secondary" icon={<Wrench />} loading={openOrder.isPending} onClick={() => openOrder.mutate()}>
            Work order
          </Button>
        ) : null}
        {canPropose ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Wrench />}
            loading={transition.isPending && transition.variables?.id === defect.id}
            onClick={() =>
              transition.mutate(
                { id: defect.id, version: defect.version, to: 'fixed_pending_verify', fixedVia: 'yard', note: null, reason: null, workOrderId: null, workOrderNumber: null, ownerId: null },
                {
                  onSuccess: () =>
                    toast({
                      tone: 'success',
                      title: `${defect.defectNumber} proposed for verification`,
                      description: 'The hold stays until safety verifies the repair.',
                    }),
                  onError: fail('The defect could not be updated'),
                },
              )
            }
          >
            Fixed
          </Button>
        ) : null}
        {canVerify ? (
          <Button size="sm" variant="primary" icon={<CircleCheck />} onClick={() => setVerifying(true)}>
            Verify & clear
          </Button>
        ) : null}
      </span>
      <ConfirmDialog
        open={verifying}
        onOpenChange={setVerifying}
        title={`Verify ${defect.defectNumber}?`}
        description={`You are confirming the repair of "${defect.description}" on unit ${defect.unitNumber}. This is the action that releases the unit; it is recorded under your name.`}
        confirmLabel="Verify & clear"
        onConfirm={() =>
          transition
            .mutateAsync({ id: defect.id, version: defect.version, to: 'verified', fixedVia: null, note: null, reason: null, workOrderId: null, workOrderNumber: null, ownerId: null })
            .then(() => toast({ tone: 'success', title: `${defect.defectNumber} verified`, description: `Unit ${defect.unitNumber} is released from this hold.` }))
            .catch((error: unknown) => {
              fail('The defect could not be verified')(error);
              throw error;
            })
        }
      />
    </li>
  );
}
