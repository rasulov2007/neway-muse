import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LOAD_PROBLEM_KINDS,
  LOAD_PROBLEM_KIND_LABELS,
  formatInstant,
  HOME_ZONE,
  type LoadProblem,
  type LoadProblemKind,
} from '@neway/shared';
import { Alert, Button, FormField, Modal, Select, Textarea, useToast } from '@/design-system';
import { apiPost } from '@/lib/api-client';

/**
 * Flagging a load (rule 1.10): "this one needs a person".
 *
 * A kind for sorting and a sentence saying what is wrong. The flag stays on the Loads list, the
 * Daily Board and in Notifications until somebody closes it with a note saying what was done.
 * It never changes the load's status.
 */
export function FlagLoadDialog({
  load,
  open,
  onOpenChange,
}: {
  load: { id: string; loadNumber: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<LoadProblemKind>('late');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const flag = useMutation({
    mutationFn: () => apiPost<LoadProblem>(`/loads/${load.id}/problems`, { kind, note: note.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['load-problems'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast({ tone: 'success', title: `${load.loadNumber} flagged`, description: 'It stays in front of everybody until the flag is closed.' });
      onOpenChange(false);
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'The flag could not be saved.'),
  });

  const ready = note.trim().length >= 3;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (flag.isPending) return;
        onOpenChange(next);
      }}
      size="sm"
      title="Flag load"
      description={`${load.loadNumber} needs a person. Say what is wrong; the flag stays until somebody closes it.`}
      footer={
        <>
          <Button variant="secondary" disabled={flag.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || flag.isPending} loading={flag.isPending} onClick={() => flag.mutate()}>
            Flag load
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Alert tone="danger" title={error} /> : null}
        <FormField label="What kind of problem" required>
          <Select
            options={LOAD_PROBLEM_KINDS.map((k) => ({ value: k, label: LOAD_PROBLEM_KIND_LABELS[k] }))}
            value={kind}
            onValueChange={(v) => setKind(v as LoadProblemKind)}
            disabled={flag.isPending}
          />
        </FormField>
        <FormField label="What is wrong" required description="One or two sentences somebody else can act on.">
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={flag.isPending}
            aria-label="What is wrong"
          />
        </FormField>
      </div>
    </Modal>
  );
}

/** Closing a flag: what was done, by the person closing it. */
export function CloseProblemDialog({
  problem,
  open,
  onOpenChange,
}: {
  problem: LoadProblem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = useMutation({
    mutationFn: () => apiPost<LoadProblem>(`/loads/${problem.loadId}/problems/${problem.id}/close`, { note: note.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['load-problems'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast({ tone: 'success', title: `Flag closed on ${problem.loadNumber}` });
      onOpenChange(false);
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'The flag could not be closed.'),
  });
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (close.isPending) return;
        onOpenChange(next);
      }}
      size="sm"
      title="Close flag"
      description={`${LOAD_PROBLEM_KIND_LABELS[problem.kind] ?? problem.kind} on ${problem.loadNumber}, opened by ${problem.openedByName} ${formatInstant(problem.openedAt, HOME_ZONE).text}.`}
      footer={
        <>
          <Button variant="secondary" disabled={close.isPending} onClick={() => onOpenChange(false)}>
            Keep open
          </Button>
          <Button variant="primary" disabled={note.trim().length < 3 || close.isPending} loading={close.isPending} onClick={() => close.mutate()}>
            Close flag
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Alert tone="danger" title={error} /> : null}
        <p className="text-sm text-ink">{problem.note}</p>
        <FormField label="What was done" required>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} disabled={close.isPending} aria-label="What was done" />
        </FormField>
      </div>
    </Modal>
  );
}
