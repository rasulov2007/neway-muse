import { Copy, Mail, Phone } from 'lucide-react';
import { useState } from 'react';
import {
  FOLLOW_UP_METHODS,
  FOLLOW_UP_METHOD_LABELS,
  FOLLOW_UP_OUTCOMES,
  FOLLOW_UP_OUTCOME_LABELS,
  isRecruiterPosition,
  type FollowUpMethod,
  type FollowUpOutcome,
} from '@neway/shared';
import {
  Alert,
  Button,
  Checkbox,
  FormField,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { ApiError } from '@/lib/api-client';
import { hiringApi, useHiringMutation } from './useHiring';

/**
 * Pieces the Recruiting tabs and the candidate profile share (owner, 2026-09-30): recording a
 * follow-up and assigning a recruiter. (The reporting period lives in RecruitingKit.) Every one of them writes through the
 * server and says only what the server confirmed.
 */

// ------------------------------------------------------------------------------- follow-up

export interface FollowUpTarget {
  kind: 'case' | 'lead';
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  /** For a lead still marked New: offer to mark it contacted when they were reached. */
  leadIsNew?: boolean;
}

/**
 * Follow up: call or email from the device, then record what happened. Recording sends nothing;
 * the dialog says so, and the toast says "recorded", never "sent".
 */
export function FollowUpDialog({ target, onClose }: { target: FollowUpTarget; onClose: () => void }) {
  const { toast } = useToast();
  const [method, setMethod] = useState<FollowUpMethod>('call');
  const [outcome, setOutcome] = useState<FollowUpOutcome>('no_answer');
  const [note, setNote] = useState('');
  const [markContacted, setMarkContacted] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mutation = useHiringMutation(async () => {
    const body = { method, outcome, note: note.trim() || null };
    const result =
      target.kind === 'case'
        ? await hiringApi.recordCaseFollowUp(target.id, body)
        : await hiringApi.recordLeadFollowUp(target.id, body);
    if (target.kind === 'lead' && target.leadIsNew && outcome === 'reached' && markContacted) {
      await hiringApi.markContacted(target.id);
    }
    return result;
  });
  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => toast({ tone: 'success', title: 'Copied' }),
      () => toast({ tone: 'warning', title: 'Copy is not available here' }),
    );
  };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Follow up · ${target.name}`}
      description="Reach them from your phone or email, then record what happened. Recording does not send anything."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            disabled={outcome === 'other' && note.trim().length === 0}
            onClick={() => {
              setError(null);
              mutation.mutate(undefined, {
                onSuccess: () => {
                  toast({ tone: 'success', title: 'Follow-up recorded', description: `${FOLLOW_UP_METHOD_LABELS[method]} — ${FOLLOW_UP_OUTCOME_LABELS[outcome]}` });
                  onClose();
                },
                onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not record the follow-up'),
              });
            }}
          >
            Record follow-up
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="follow-up-dialog">
        {error ? (
          <Alert tone="danger" title="Not recorded">
            {error}
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {target.phone ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <a href={`tel:${target.phone.replace(/[^\d+]/g, '')}`}>
                  <Phone aria-hidden className="size-4" />
                  Call {target.phone}
                </a>
              </Button>
              <Button variant="ghost" size="sm" icon={<Copy />} onClick={() => copy(target.phone ?? '')} aria-label="Copy phone number" />
            </>
          ) : (
            <span className="text-sm text-muted">No phone number on file.</span>
          )}
          {target.email ? (
            <Button variant="outline" size="sm" asChild>
              <a href={`mailto:${target.email}`}>
                <Mail aria-hidden className="size-4" />
                Email
              </a>
            </Button>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="How" required>
            <Select aria-label="Follow-up method" value={method} onValueChange={(v) => setMethod(v as FollowUpMethod)} options={FOLLOW_UP_METHODS.map((m) => ({ value: m, label: FOLLOW_UP_METHOD_LABELS[m] }))} />
          </FormField>
          <FormField label="What happened" required>
            <Select aria-label="Follow-up outcome" value={outcome} onValueChange={(v) => setOutcome(v as FollowUpOutcome)} options={FOLLOW_UP_OUTCOMES.map((o) => ({ value: o, label: FOLLOW_UP_OUTCOME_LABELS[o] }))} />
          </FormField>
        </div>
        <FormField label="Note" description={outcome === 'other' ? 'Required for Other.' : 'Optional — what was said, when to call back.'}>
          <Textarea aria-label="Follow-up note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {target.kind === 'lead' && target.leadIsNew && outcome === 'reached' ? (
          <Checkbox label="Also mark the lead as contacted" checked={markContacted} onCheckedChange={(v) => setMarkContacted(v === true)} />
        ) : null}
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------- recruiter

export interface RecruiterTarget {
  kind: 'case' | 'lead';
  id: string;
  name: string;
  currentId: string | null;
}

/** One recruiter for the person: on a case the server keeps lead, case and candidate together. */
export function AssignRecruiterDialog({ target, onClose }: { target: RecruiterTarget; onClose: () => void }) {
  const { toast } = useToast();
  const employees = useEmployeeDirectory();
  const [value, setValue] = useState(target.currentId ?? '');
  const [error, setError] = useState<string | null>(null);
  const mutation = useHiringMutation(async (): Promise<void> => {
    if (target.kind === 'case') await hiringApi.assignRecruiter(target.id, value || null);
    else await hiringApi.updateLead(target.id, { recruiterEmployeeId: value || null });
  });
  const options = (employees.data ?? [])
    .filter((e) => e.id === target.currentId || (e.status !== 'terminated' && isRecruiterPosition(e.position)))
    .map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` }));
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Recruiter · ${target.name}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            disabled={(target.currentId ?? '') === value}
            onClick={() => {
              setError(null);
              mutation.mutate(undefined, {
                onSuccess: () => {
                  toast({ tone: 'success', title: value ? 'Recruiter assigned' : 'Recruiter removed' });
                  onClose();
                },
                onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not assign the recruiter'),
              });
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not saved">
            {error}
          </Alert>
        ) : null}
        <FormField
          label="Recruiter"
          description={
            employees.isPending
              ? 'Loading…'
              : options.length === 0
                ? 'Nobody to pick yet: a recruiter is an employee whose position is Recruiter. Set it in Administration › Employees (a user account alone is not enough).'
                : 'Employees whose position is Recruiter. Missing someone? Set their position in Administration › Employees.'
          }
        >
          <Select aria-label="Recruiter" value={value} onValueChange={setValue} options={[{ value: '', label: 'Unassigned' }, ...options]} />
        </FormField>
      </div>
    </Modal>
  );
}
