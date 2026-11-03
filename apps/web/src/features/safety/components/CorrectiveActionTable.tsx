import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, UserPlus, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  DataTable,
  FormField,
  MenuItem,
  Modal,
  Select,
  Textarea,
  cn,
  createColumns,
  useToast,
} from '@/design-system';
import { demoUsers, updateCorrectiveAction } from '@/demo';
import { formatIsoDate } from '@/lib/format';
import { CORRECTIVE_ACTION_LABEL, CORRECTIVE_ACTION_TONE, DASH } from '../safety-ui';
import { useInvalidateSafety, type SafetyCorrectiveAction } from '../useSafety';

const col = createColumns<SafetyCorrectiveAction>();

/**
 * The corrective actions raised against one record.
 *
 * The status shown is the derived one — `assigned` and `overdue` are facts about the row (does it
 * have an owner; is its date past) rather than stored words, so they cannot go stale overnight.
 *
 * Completing an action requires a resolution. An action closed with no record of what was done is
 * an action nobody can defend in an audit, which is the only place it will ever be read.
 */
export function CorrectiveActionTable({
  actions,
  emptyDescription,
}: {
  actions: SafetyCorrectiveAction[];
  emptyDescription: string;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();
  const [completing, setCompleting] = useState<SafetyCorrectiveAction | null>(null);
  const [resolution, setResolution] = useState('');
  const [assigning, setAssigning] = useState<SafetyCorrectiveAction | null>(null);
  const [assigneeId, setAssigneeId] = useState('');

  const complete = useMutation({
    mutationFn: () =>
      updateCorrectiveAction({
        id: completing?.action.id ?? '',
        status: 'completed',
        resolution,
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({ tone: 'success', title: `${result.action?.actionNumber} completed` });
      setCompleting(null);
      setResolution('');
    },
  });

  const assign = useMutation({
    mutationFn: () =>
      updateCorrectiveAction({ id: assigning?.action.id ?? '', assigneeId: assigneeId || null }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({
        tone: 'success',
        title: result.action?.assigneeName
          ? `${result.action.actionNumber} assigned to ${result.action.assigneeName}`
          : `${result.action?.actionNumber} unassigned`,
      });
      setAssigning(null);
      setAssigneeId('');
    },
  });

  const cancel = useMutation({
    mutationFn: (id: string) => updateCorrectiveAction({ id, status: 'cancelled' }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({ tone: 'info', title: `${result.action?.actionNumber} cancelled` });
    },
  });

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'actionNumber',
          header: 'Action',
          meta: { primary: true, width: 110 },
          cell: ({ row }) => row.original.action.actionNumber,
        }),
        col.display({
          id: 'title',
          header: 'What has to happen',
          cell: ({ row }) => (
            <span className="truncate" title={row.original.action.description}>
              {row.original.action.title}
            </span>
          ),
        }),
        col.display({
          id: 'subject',
          header: 'Against',
          meta: { width: 120 },
          cell: ({ row }) => row.original.action.subjectLabel,
        }),
        col.display({
          id: 'owner',
          header: 'Owner',
          cell: ({ row }) =>
            row.original.action.assigneeName ?? (
              <span className="font-medium text-warning-text">Unassigned</span>
            ),
        }),
        col.display({
          id: 'priority',
          header: 'Priority',
          meta: { width: 100 },
          cell: ({ row }) => {
            const priority = row.original.action.priority;
            return (
              <Badge
                tone={
                  priority === 'urgent' ? 'danger' : priority === 'high' ? 'warning' : 'neutral'
                }
              >
                {priority[0]?.toUpperCase() + priority.slice(1)}
              </Badge>
            );
          },
        }),
        col.display({
          id: 'due',
          header: 'Due',
          meta: { width: 120 },
          cell: ({ row }) => (
            <span
              className={cn(
                row.original.state.state === 'overdue' && 'font-medium text-danger-text',
              )}
            >
              {formatIsoDate(row.original.action.dueAt.slice(0, 10))}
            </span>
          ),
        }),
        col.display({
          id: 'state',
          header: 'Status',
          meta: { width: 130 },
          cell: ({ row }) => (
            <Badge
              tone={CORRECTIVE_ACTION_TONE[row.original.state.state]}
              title={row.original.state.reasons.join('. ')}
            >
              {CORRECTIVE_ACTION_LABEL[row.original.state.state]}
            </Badge>
          ),
        }),
        col.display({
          id: 'resolution',
          header: 'Resolution',
          cell: ({ row }) =>
            row.original.action.resolution ?? <span className="text-faint">{DASH}</span>,
        }),
      ]),
    [],
  );

  const candidates = demoUsers.filter(
    (u) => u.department === 'safety' || u.department === 'maintenance',
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={actions}
        rowKey={(row) => row.action.id}
        caption="Corrective actions"
        showColumnChooser={false}
        emptyTitle="No corrective actions"
        emptyDescription={emptyDescription}
        rowActions={(row) =>
          row.state.outstanding ? (
            <>
              <MenuItem
                icon={<UserPlus />}
                onSelect={() => {
                  setAssigning(row);
                  setAssigneeId(row.action.assigneeId ?? '');
                }}
              >
                {row.action.assigneeId ? 'Reassign' : 'Assign'}
              </MenuItem>
              <MenuItem
                icon={<CheckCircle2 />}
                onSelect={() => {
                  setCompleting(row);
                  setResolution(row.action.resolution ?? '');
                }}
              >
                Complete
              </MenuItem>
              <MenuItem
                icon={<XCircle />}
                destructive
                onSelect={() => cancel.mutate(row.action.id)}
              >
                Cancel
              </MenuItem>
            </>
          ) : null
        }
      />

      <Modal
        open={completing !== null}
        onOpenChange={(open) => {
          if (!open) setCompleting(null);
        }}
        title={`Complete ${completing?.action.actionNumber ?? ''}`}
        description="Record what was actually done. This is what an auditor reads."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCompleting(null)}>
              Cancel
            </Button>
            <Button
              loading={complete.isPending}
              disabled={!resolution.trim()}
              onClick={() => complete.mutate()}
            >
              Complete action
            </Button>
          </>
        }
      >
        <FormField label="Resolution" required>
          <Textarea
            rows={4}
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            placeholder="Brake chamber replaced and re-tested; unit returned to service."
          />
        </FormField>
      </Modal>

      <Modal
        open={assigning !== null}
        onOpenChange={(open) => {
          if (!open) setAssigning(null);
        }}
        size="sm"
        title={`Assign ${assigning?.action.actionNumber ?? ''}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAssigning(null)}>
              Cancel
            </Button>
            <Button loading={assign.isPending} onClick={() => assign.mutate()}>
              Save
            </Button>
          </>
        }
      >
        <FormField label="Owner">
          <Select
            options={[
              { value: '', label: 'Unassigned' },
              ...candidates.map((u) => ({ value: u.id, label: `${u.name} · ${u.role}` })),
            ]}
            value={assigneeId}
            onValueChange={setAssigneeId}
          />
        </FormField>
      </Modal>
    </>
  );
}
