import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { proposeDueDate } from '@neway/shared';
import {
  DatePicker,
  Alert,
  Button,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import { createCorrectiveAction, demoUsers, type CorrectiveActionSubjectType } from '@/demo';
import { useInvalidateSafety, useSafety } from '../useSafety';

/**
 * Raises a corrective action.
 *
 * A corrective action is a task in the safety department bound to whatever caused it, using the
 * same `tasks` record every other assignment in this system uses. It is not a second inbox.
 *
 * The due date is proposed from the severity of the finding — one day for a critical, thirty for a
 * low — so nobody has to invent one, and it is editable before it is saved.
 */
export function CreateCorrectiveActionDialog({
  open,
  onOpenChange,
  subjectType,
  subjectId,
  subjectLabel,
  severity,
  defaultTitle,
  defaultDescription,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subjectType: CorrectiveActionSubjectType;
  subjectId: string;
  subjectLabel: string;
  /** Drives the proposed due date and the default priority. */
  severity: string;
  defaultTitle: string;
  defaultDescription: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();
  const safety = useSafety();
  const today = safety.data?.today ?? new Date().toISOString().slice(0, 10);

  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(defaultDescription);
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState(
    severity === 'critical' ? 'urgent' : severity === 'high' ? 'high' : 'normal',
  );
  const [dueOn, setDueOn] = useState(proposeDueDate(severity, today));
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createCorrectiveAction({
        subjectType,
        subjectId,
        subjectLabel,
        title,
        description,
        assigneeId: assigneeId || null,
        priority: priority as 'low' | 'normal' | 'high' | 'urgent',
        dueOn,
      }),
    onSuccess: async (action) => {
      await invalidate();
      toast({
        tone: 'success',
        title: `${action.actionNumber} raised against ${subjectLabel}`,
        description: action.assigneeName
          ? `Assigned to ${action.assigneeName}, due ${dueOn}.`
          : `Due ${dueOn}. Nobody is assigned to it yet.`,
      });
      onDone();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The corrective action could not be created.'),
  });

  // Whoever could actually own the work: the safety desk and the shop.
  const candidates = demoUsers.filter(
    (u) => u.department === 'safety' || u.department === 'maintenance',
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create corrective action"
      description={`Against ${subjectLabel}. It appears in the assignee's tasks like any other work.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!title.trim() || !dueOn}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
          >
            Create action
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

        <FormField label="What has to happen" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>

        <FormField label="Detail">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Owner"
            description="Leave empty and it shows as unassigned, which the queue surfaces."
          >
            <Select
              options={[
                { value: '', label: 'Unassigned' },
                ...candidates.map((u) => ({ value: u.id, label: `${u.name} · ${u.role}` })),
              ]}
              value={assigneeId}
              onValueChange={setAssigneeId}
            />
          </FormField>
          <FormField label="Priority">
            <Select
              options={[
                { value: 'urgent', label: 'Urgent' },
                { value: 'high', label: 'High' },
                { value: 'normal', label: 'Normal' },
                { value: 'low', label: 'Low' },
              ]}
              value={priority}
              onValueChange={setPriority}
            />
          </FormField>
        </div>

        <FormField
          label="Due"
          required
          description={`Proposed from a ${severity} finding. Change it if your policy differs.`}
        >
          <DatePicker value={dueOn} onIsoChange={setDueOn} />
        </FormField>

        {severity === 'critical' ? (
          <Alert
            tone="warning"
            title="This is a critical finding"
            description="Critical findings stop the unit or the driver. The corrective action is what gets it moving again, and the queue will report it as overdue the moment it passes its date."
          />
        ) : null}
      </div>
    </Modal>
  );
}
