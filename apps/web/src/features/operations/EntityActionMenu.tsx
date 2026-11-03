import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ellipsis } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import {
  actionsFor,
  decideTransition,
  permittedActions,
  type EntityAction,
  type ManagedEntity,
  type TransitionDecision,
} from '@neway/shared';
import { changeEntityStatus, countEntityDependencies, type StatusTargetEntity } from '@/demo';
import {
  Alert,
  ConfirmDialog,
  DropdownMenu,
  IconButton,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  useToast,
} from '@/design-system';

/** The record an action is being taken on. */
export interface EntityTarget {
  entity: ManagedEntity & StatusTargetEntity;
  id: string;
  name: string;
  status: string;
}

export interface UseEntityActionsOptions {
  /** The principal's permission set; actions outside it are never rendered. */
  permissions: ReadonlySet<string>;
  /** Query key prefixes to invalidate after a change lands. */
  invalidate?: readonly string[];
  /** Handles the non-status actions (edit, create load) that belong to the page. */
  onAction?: (action: EntityAction, target: EntityTarget) => void;
}

export interface EntityActions {
  /** Menu items for one record, for `DataTable`'s `rowActions` slot. */
  items: (target: EntityTarget) => ReactNode;
  /** A self-contained menu for a detail header. */
  menu: (target: EntityTarget) => ReactNode;
  /** Render once per page. Lives outside the menu so it survives the menu closing. */
  dialog: ReactNode;
}

/**
 * Entity actions, driven by the lifecycle engine.
 *
 * What appears is decided by the engine from the record's current status and filtered by the
 * principal's permissions — never by the page. That is what keeps "put on hold" off an archived
 * customer and keeps the rules in one testable place.
 *
 * Before a status change runs, the engine is asked whether it may. The dialog then either explains
 * the consequence or explains what is blocking it and what to do about it; a blocked action is
 * never a silently disabled button, because that teaches nobody anything.
 *
 * The dialog is returned separately rather than rendered inside the menu: `DataTable` owns the
 * dropdown for a row, and anything rendered inside it unmounts the moment the menu closes.
 */
export function useEntityActions({
  permissions,
  invalidate = ['operations'],
  onAction,
}: UseEntityActionsOptions): EntityActions {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<{
    action: EntityAction;
    target: EntityTarget;
    decision: TransitionDecision;
  } | null>(null);

  const change = useMutation({
    mutationFn: ({ action, target }: { action: EntityAction; target: EntityTarget }) =>
      changeEntityStatus({ entity: target.entity, id: target.id, toStatus: action.to as string }),
    onSuccess: async (result) => {
      await Promise.all(
        invalidate.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      );
      toast({
        tone: 'success',
        title: `${result.label} is now ${(result.audit.after ?? result.to).toLowerCase()}`,
        description: 'The change is recorded in the audit trail.',
      });
    },
    onError: (error: unknown) => {
      toast({
        tone: 'danger',
        title: 'The status could not be changed',
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    },
  });

  /** Counts what is attached before deciding, so the dialog quotes real numbers. */
  async function begin(action: EntityAction, target: EntityTarget) {
    if (action.kind !== 'status') {
      onAction?.(action, target);
      return;
    }
    const dependencies = (await countEntityDependencies(target.entity, target.id)) as Array<{
      key: never;
      count: number;
    }>;
    const decision = decideTransition(target.entity, action, dependencies, { name: target.name });
    if (!decision.allowed || decision.confirmation) {
      setPending({ action, target, decision });
      return;
    }
    change.mutate({ action, target });
  }

  function itemsFor(target: EntityTarget): ReactNode {
    const available = permittedActions(actionsFor(target.entity, target.status), permissions);
    if (available.length === 0) {
      return <MenuLabel>No actions available</MenuLabel>;
    }
    return (
      <>
        <MenuLabel>{target.name}</MenuLabel>
        {available.map((action, index) => (
          <Fragment key={action.key}>
            {action.destructive && index > 0 ? <MenuSeparator /> : null}
            <MenuItem
              destructive={action.destructive}
              onSelect={() => {
                void begin(action, target);
              }}
            >
              {action.label}
            </MenuItem>
          </Fragment>
        ))}
      </>
    );
  }

  return {
    items: itemsFor,
    menu: (target) => (
      <DropdownMenu
        align="end"
        trigger={
          <IconButton label={`Actions for ${target.name}`} variant="ghost" size="sm">
            <Ellipsis />
          </IconButton>
        }
      >
        {itemsFor(target)}
      </DropdownMenu>
    ),
    dialog: pending ? (
      <ConfirmDialog
        open
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending.decision.confirmation?.title ?? pending.action.label}
        description={pending.decision.confirmation?.body ?? ''}
        confirmLabel={pending.decision.confirmation?.confirmLabel ?? pending.action.label}
        tone={pending.action.destructive ? 'danger' : 'default'}
        hideConfirm={!pending.decision.allowed}
        onConfirm={() => {
          if (pending.decision.allowed) {
            change.mutate({ action: pending.action, target: pending.target });
          }
          setPending(null);
        }}
      >
        {pending.decision.blockers.length > 0 ? (
          <Alert
            tone="warning"
            title="Resolve these first"
            description={
              <ul className="flex flex-col gap-0.5">
                {pending.decision.blockers.map((blocker) => (
                  <li key={blocker.key}>
                    {blocker.label} — {blocker.resolution}
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
      </ConfirmDialog>
    ) : null,
  };
}
