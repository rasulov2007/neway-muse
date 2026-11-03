import { ArrowRight, MessageSquareText, Shuffle } from 'lucide-react';
import { useState } from 'react';
import type { LeadNote } from '@neway/shared';
import { Alert, Button, FormField, Modal, Textarea, useToast } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { hiringApi, useHiringMutation, useLeadNotes, useLeadRotation } from './useHiring';

/**
 * Lead notes (owner, 2026-10-07): a recruiter writes a free-text note in two clicks — no method,
 * no outcome. Notes and recorded follow-ups are one history, newest first, each with who wrote
 * it and when (Eastern).
 */

export interface NoteTarget {
  leadId: string;
  name: string;
}

export function AddNoteDialog({ target, onClose }: { target: NoteTarget; onClose: () => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useHiringMutation(() => hiringApi.addLeadNote(target.leadId, note.trim()));
  const save = () => {
    setError(null);
    mutation.mutate(undefined, {
      onSuccess: () => {
        toast({ tone: 'success', title: 'Note saved' });
        onClose();
      },
      onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the note'),
    });
  };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Add note · ${target.name}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={mutation.isPending} disabled={note.trim().length === 0} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="add-note-dialog">
        {error ? (
          <Alert tone="danger" title="Not saved">
            {error}
          </Alert>
        ) : null}
        <FormField label="Note" description="Saved with your name and the time. Notes are kept; they are not edited later.">
          <Textarea
            aria-label="Note"
            rows={4}
            autoFocus
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && note.trim()) save();
            }}
          />
        </FormField>
      </div>
    </Modal>
  );
}

/** One line of the history: the note itself, or a follow-up's "Phone call — No answer". */
export function NoteLine({ note, compact = false }: { note: LeadNote; compact?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {note.summary ? <span className="text-sm font-semibold text-ink">{note.summary}</span> : null}
      {note.text ? (
        <span className={compact ? 'line-clamp-2 text-sm text-ink' : 'text-sm whitespace-pre-line text-ink'}>{note.text}</span>
      ) : null}
      <span className="text-xs text-muted">
        {note.kind === 'note' ? 'Note' : 'Follow-up'} · {note.byName} · {formatDateTime(note.at)}
      </span>
    </div>
  );
}

export function LeadNotesHistory({
  leadId,
  canWrite,
  onAddNote,
}: {
  leadId: string;
  canWrite: boolean;
  onAddNote: () => void;
}) {
  const notes = useLeadNotes(leadId);
  return (
    <section className="flex flex-col gap-2" data-testid="lead-notes">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-md font-bold text-ink">Notes</h3>
        {canWrite ? (
          <Button variant="outline" size="sm" icon={<MessageSquareText />} onClick={onAddNote}>
            Add note
          </Button>
        ) : null}
      </header>
      {notes.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : notes.error ? (
        <p className="text-sm text-danger-text">The notes could not be loaded.</p>
      ) : (notes.data ?? []).length === 0 ? (
        <p className="text-sm text-muted">No notes yet.</p>
      ) : (
        <ol className="flex flex-col divide-y divide-line-soft rounded-lg border border-line">
          {(notes.data ?? []).map((n) => (
            <li key={n.id} className="px-3 py-2">
              <NoteLine note={n} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The automatic assignment, read-only, so the owner can see it working: the turn order and who
 * takes the next online application.
 */
export function RotationLine() {
  const rotation = useLeadRotation();
  const r = rotation.data;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm"
      data-testid="lead-rotation"
    >
      <Shuffle aria-hidden className="size-4 text-muted" />
      <span className="font-semibold text-ink">Auto-assign:</span>
      {rotation.isPending ? (
        <span className="text-muted">Loading…</span>
      ) : rotation.error || !r ? (
        <span className="text-muted">The rotation could not be loaded.</span>
      ) : r.recruiters.length === 0 ? (
        <span className="text-muted">
          No recruiters — online applications arrive unassigned. A recruiter is an employee whose position is Recruiter.
        </span>
      ) : (
        <>
          <span className="flex flex-wrap items-center gap-1 text-secondary">
            {r.recruiters.map((m, i) => (
              <span key={m.employeeId} className="inline-flex items-center gap-1">
                {i > 0 ? <ArrowRight aria-hidden className="size-3 text-faint" /> : null}
                <span className={m.employeeId === r.next?.employeeId ? 'font-semibold text-ink' : undefined}>{m.name}</span>
              </span>
            ))}
            <ArrowRight aria-hidden className="size-3 text-faint" />
            <span className="text-faint">…</span>
          </span>
          <span className="text-muted">·</span>
          <span className="text-secondary">
            next: <strong className="text-ink">{r.next?.name}</strong>
          </span>
        </>
      )}
    </div>
  );
}
