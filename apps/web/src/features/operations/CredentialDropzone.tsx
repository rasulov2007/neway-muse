import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, FileText, Upload, X } from 'lucide-react';
import { Button, cn } from '@/design-system';
import { formatBytes } from '@/features/loads/loadUtils';
import { OcrUnavailableError, isReadable, readCardText, toBase64 } from './credential-ocr';

/**
 * One required card: the file, and what could be read off it.
 *
 * The file is the point. A licence expiry typed into a form is a claim; the photograph of the
 * licence is the evidence behind it, and until now this system took the claim and kept no
 * evidence. Reading the card is the convenience on top — it fills the dates in and the person
 * checks them, which is faster and more accurate than reading digits off a phone screen.
 *
 * Nothing here decides anything on its own. A card that will not read is still a card that is
 * filed; the person types the dates and moves on.
 */

export interface CredentialFile {
  file: File;
  /** The bytes, base64, ready for the document store. */
  content: string;
  previewUrl: string | null;
}

export type CredentialState =
  | { phase: 'empty' }
  | { phase: 'loading'; name: string }
  | { phase: 'reading'; name: string; progress: number }
  | { phase: 'ready'; value: CredentialFile; read: 'ok' | 'unread'; note: string | null }
  | { phase: 'failed'; message: string };

const ACCEPT = 'image/jpeg,image/png,application/pdf';
const MAX_BYTES = 20 * 1024 * 1024;

export function CredentialDropzone({
  label,
  hint,
  state,
  onState,
  onText,
  disabled,
  optional,
}: {
  label: string;
  hint: string;
  state: CredentialState;
  onState: (next: CredentialState) => void;
  /** The text read off the card, for the caller to parse into its own fields. */
  onText: (text: string) => string | null;
  disabled?: boolean;
  /** Collected when it is to hand, but the driver can be added without it. */
  optional?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Object URLs outlive the render that made them; they are released when the file changes.
  const previewRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  async function accept(file: File | null | undefined) {
    if (!file) return;
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
    if (!ACCEPT.split(',').includes(file.type)) {
      onState({ phase: 'failed', message: 'Attach a JPG, a PNG or a PDF.' });
      return;
    }
    if (file.size > MAX_BYTES) {
      onState({ phase: 'failed', message: 'That file is larger than 20 MB.' });
      return;
    }

    onState({ phase: 'loading', name: file.name });
    let content: string;
    try {
      content = await toBase64(file);
    } catch {
      onState({ phase: 'failed', message: 'The file could not be read from disk.' });
      return;
    }
    const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
    previewRef.current = previewUrl;
    const value: CredentialFile = { file, content, previewUrl };

    if (!isReadable(file)) {
      onState({
        phase: 'ready',
        value,
        read: 'unread',
        note: 'Filed. A PDF cannot be read automatically — check the dates below.',
      });
      return;
    }

    onState({ phase: 'reading', name: file.name, progress: 0 });
    try {
      const text = await readCardText(file, (progress) =>
        onState({ phase: 'reading', name: file.name, progress }),
      );
      const note = onText(text);
      onState({
        phase: 'ready',
        value,
        read: note ? 'ok' : 'unread',
        note:
          note ?? 'Filed, but nothing could be read off it. Type the details below from the card.',
      });
    } catch (error) {
      // The file is attached either way: a reader that failed is not a document that failed.
      onState({
        phase: 'ready',
        value,
        read: 'unread',
        note:
          error instanceof OcrUnavailableError
            ? `Filed. ${error.message} Type the details below.`
            : 'Filed, but the card could not be read. Type the details below.',
      });
    }
  }

  function clear() {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
    onState({ phase: 'empty' });
  }

  const busy = state.phase === 'loading' || state.phase === 'reading';
  const ready = state.phase === 'ready';

  return (
    <section
      aria-label={label}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        if (!disabled) void accept(event.dataTransfer?.files?.[0]);
      }}
      className={cn(
        'flex flex-col gap-2 rounded-md border bg-nw-panel p-3 transition-colors',
        ready ? 'border-success-border' : 'border-nw-border-strong',
        state.phase === 'failed' && 'border-danger-border',
        dragOver && 'border-nw-accent bg-nw-accent-tint',
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">
            {label}{' '}
            {optional ? (
              <span className="text-xs font-normal text-muted">Optional</span>
            ) : (
              <span className="text-danger-text">*</span>
            )}
          </span>
          <span className="block text-xs text-muted">{hint}</span>
        </span>
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-full',
            ready ? 'bg-success-soft text-success-text' : 'bg-surface-muted text-muted',
          )}
        >
          {ready ? (
            <CircleCheck aria-hidden className="size-3.5" />
          ) : (
            <CircleAlert aria-hidden className="size-3.5" />
          )}
          <span className="sr-only">
            {ready ? `${label} attached` : optional ? `${label} not attached` : `${label} required`}
          </span>
        </span>
      </header>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          void accept(event.target.files?.[0]);
          event.target.value = '';
        }}
      />

      {ready ? (
        <div className="flex h-11 items-center gap-2 rounded-md border border-nw-border-strong bg-nw-field px-2">
          {state.value.previewUrl ? (
            <img
              src={state.value.previewUrl}
              alt={`${label} as attached`}
              // A document preview: paper in both modes (SPEC §7 "Documents").
              className="nw-paper size-8 shrink-0 rounded-sm border border-nw-border object-cover"
            />
          ) : (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-nw-subtle text-nw-text-3">
              <FileText aria-hidden className="size-4" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span
              className="block truncate text-xs font-medium text-ink"
              title={state.value.file.name}
            >
              {state.value.file.name}
            </span>
            <span className="block text-2xs text-nw-text-3">
              {formatBytes(state.value.file.size)}
            </span>
          </span>
          <Button
            size="sm"
            variant="link"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            Replace
          </Button>
          <button
            type="button"
            disabled={disabled}
            onClick={clear}
            aria-label={`Remove ${label}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-sm text-nw-text-3 hover:bg-nw-highlight hover:text-nw-text focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus disabled:opacity-60"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'flex h-11 w-full cursor-pointer items-center gap-2 rounded-md border border-nw-border-strong bg-nw-field px-3 text-left text-xs text-muted transition-colors',
            'hover:border-nw-accent hover:text-primary-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60',
            dragOver && 'border-nw-accent bg-nw-accent-tint',
          )}
        >
          <Upload aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {busy ? 'Working…' : 'Drop a photo or browse'}
            <span className="ml-2 text-2xs text-nw-text-3">JPG, PNG or PDF</span>
          </span>
        </button>
      )}

      {state.phase === 'reading' ? (
        <p className="text-xs text-secondary" role="status">
          Reading the card… {Math.round(state.progress * 100)}%
        </p>
      ) : null}
      {state.phase === 'loading' ? (
        <p className="text-xs text-secondary" role="status">
          Attaching {state.name}…
        </p>
      ) : null}
      {state.phase === 'failed' ? (
        <p className="text-xs text-danger-text" role="alert">
          {state.message}
        </p>
      ) : null}

      {ready && state.note ? (
        <p className={cn('text-xs', state.read === 'ok' ? 'text-secondary' : 'text-warning-text')}>
          {state.note}
        </p>
      ) : null}
    </section>
  );
}
