import { useMutation, useQuery } from '@tanstack/react-query';
import {
  actionsFor,
  decideTransition,
  type DependencyKey,
  type ManagedEntity,
} from '@neway/shared';
import { ConfirmDialog, useToast } from '@/design-system';
import { UnitExitDialog } from './UnitExitDialog';
import { changeEntityStatus, countEntityDependencies } from '@/demo';
import { useInvalidateFleet } from '../useFleet';

/**
 * Taking a unit out of service, or putting it back.
 *
 * What is attached to the unit is counted **before** the dialog offers to act, and the same
 * `decideTransition` rules the rest of the app uses decide whether it may — including the wording.
 * A blocked change is shown as an explanation with no confirm button rather than as a button that
 * fails on click: the brief is explicit that a refused action has to say why and what to do first.
 */

export interface UnitStatusDialogProps {
  entity: Extract<ManagedEntity, 'truck' | 'trailer'>;
  id: string;
  /** The unit's current stored status, which is what decides the actions it offers. */
  status: string;
  label: string;
  /** Key of the lifecycle action being taken, or null when the dialog is closed. */
  actionKey: string | null;
  onOpenChange: (open: boolean) => void;
}

export function UnitStatusDialog({
  entity,
  id,
  status,
  label,
  actionKey,
  onOpenChange,
}: UnitStatusDialogProps) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();

  const action = actionsFor(entity, status).find((a) => a.key === actionKey) ?? null;

  const dependencies = useQuery({
    queryKey: ['fleet', 'dependencies', entity, id],
    queryFn: () => countEntityDependencies(entity, id),
    enabled: actionKey !== null,
  });

  const decision = action
    ? decideTransition(
        entity,
        action,
        (dependencies.data ?? []).map((d) => ({ key: d.key as DependencyKey, count: d.count })),
        { name: label },
      )
    : null;

  const change = useMutation({
    mutationFn: () => changeEntityStatus({ entity, id, toStatus: action?.to ?? '' }),
    onSuccess: async (result) => {
      await invalidate();
      toast({ tone: 'success', title: `${result.label} is now ${result.to.replace(/_/g, ' ')}` });
      onOpenChange(false);
    },
    onError: (error: unknown) =>
      toast({
        tone: 'danger',
        title: 'That change was refused',
        description: error instanceof Error ? error.message : 'The status could not be changed.',
      }),
  });

  const blocked = decision?.allowed === false;

  // Taking a unit off the road is not a yes/no question. Sold, stolen, burned, wrecked — each one
  // has to be accounted for, so the confirm box gives way to the dialog that asks.
  const needsAccount = EXIT_STATUSES.has(action?.to ?? '');
  if (action && needsAccount && !blocked && !dependencies.isPending) {
    return (
      <UnitExitDialog
        entity={entity}
        unitId={id}
        unitNumber={label}
        toStatus={action.to ?? ''}
        actionLabel={action.label}
        onClose={() => onOpenChange(false)}
      />
    );
  }

  return (
    <ConfirmDialog
      open={actionKey !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
      tone={action?.destructive && !blocked ? 'danger' : 'default'}
      title={decision?.confirmation?.title ?? `${action?.label ?? 'Change status'}?`}
      description={
        dependencies.isPending
          ? 'Checking what is attached to this unit…'
          : (decision?.confirmation?.body ??
            'The change is recorded against the unit, with who made it and when.')
      }
      hideConfirm={blocked}
      confirmLabel={decision?.confirmation?.confirmLabel ?? action?.label ?? 'Confirm'}
      onConfirm={() => change.mutate()}
    />
  );
}

/** Statuses that mean the unit has left service, and therefore need an account of why. */
const EXIT_STATUSES = new Set(['out_of_service', 'inactive', 'sold', 'archived']);
