import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, FileText, Upload, X } from 'lucide-react';
import { Button, cn } from '@/design-system';
import { formatBytes } from '@/features/loads/loadUtils';

/**
 * One file, attached by drop or by browsing.
 *
 * The same card the load documents use, so a shop invoice and a bill of lading are attached the
 * same way: a titled card, one short target row that accepts a drop, and one primary action.
 * The header mark carries the state — red while the file is missing, green once it is there —
 * because "missing" is the thing somebody is scanning a screen for.
 */
export function FileDropzone({
  title,
  subtitle,
  hint,
  actionLabel,
  accept = 'application/pdf,image/*',
  file,
  onFile,
  disabled,
}: {
  title: string;
  subtitle: string;
  /** One line under the target saying what attaching it does. */
  hint?: string;
  actionLabel: string;
  accept?: string;
  file: File | null;
  onFile: (file: File | null) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const preview = useImagePreview(file);

  return (
    <section
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const dropped = Array.from(event.dataTransfer?.files ?? [])[0];
        if (dropped) onFile(dropped);
      }}
      className={cn(
        'flex flex-col gap-2 rounded-md border bg-nw-panel p-3 transition-colors',
        file ? 'border-success-border' : 'border-nw-border-strong',
        over && 'border-nw-accent bg-nw-accent-tint',
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">{title}</span>
          <span className="block truncate text-xs text-muted">{subtitle}</span>
        </span>
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-full',
            file ? 'bg-success-soft text-success-text' : 'bg-danger-soft text-danger-text',
          )}
        >
          {file ? (
            <Check aria-hidden className="size-3.5" />
          ) : (
            <CircleAlert aria-hidden className="size-3.5" />
          )}
          <span className="sr-only">{file ? `${title} attached` : `${title} missing`}</span>
        </span>
      </header>

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => onFile(event.target.files?.[0] ?? null)}
      />

      {file ? (
        <div className="flex h-11 items-center gap-2 rounded-md border border-nw-border-strong bg-nw-field px-2">
          {preview ? (
            <img
              src={preview}
              alt=""
              className="nw-paper size-8 shrink-0 rounded-sm border border-nw-border object-cover"
            />
          ) : (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-nw-subtle text-nw-text-3">
              <FileText aria-hidden className="size-4" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-ink" title={file.name}>
              {file.name}
            </span>
            <span className="block text-2xs text-nw-text-3">{formatBytes(file.size)}</span>
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
            onClick={() => onFile(null)}
            aria-label={`Remove ${file.name}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-sm text-nw-text-3 hover:bg-nw-highlight hover:text-nw-text focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus disabled:opacity-60"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            className={cn(
              'flex h-11 w-full cursor-pointer items-center gap-2 rounded-md border border-nw-border-strong bg-nw-field px-3 text-left text-xs text-muted transition-colors',
              'hover:border-nw-accent hover:text-primary-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60',
              over && 'border-nw-accent bg-nw-accent-tint',
            )}
          >
            <Upload aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Drop a file or browse
              <span className="ml-2 text-2xs text-nw-text-3">{describeAccept(accept)}</span>
            </span>
          </button>
          {hint ? <p className="text-2xs text-muted">{hint}</p> : null}
          <Button
            size="sm"
            variant="primary"
            fullWidth
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {actionLabel}
          </Button>
        </>
      )}
    </section>
  );
}

/** "PDF or image" from an `accept` list — what is allowed, in words. */
function describeAccept(accept: string): string {
  const parts = accept
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part === 'application/pdf' || part === '.pdf') return 'PDF';
      if (part === 'image/*') return 'image';
      if (part === 'image/jpeg' || part === '.jpg' || part === '.jpeg') return 'JPG';
      if (part === 'image/png' || part === '.png') return 'PNG';
      return part
        .replace(/^\./, '')
        .replace(/^[a-z]+\//, '')
        .toUpperCase();
    });
  const unique = Array.from(new Set(parts));
  if (unique.length === 0) return '';
  if (unique.length === 1) return unique[0] as string;
  return `${unique.slice(0, -1).join(', ')} or ${unique[unique.length - 1]}`;
}

/** An object URL for an image file, released when the file changes or the component leaves. */
function useImagePreview(file: File | null): string | null {
  const url = useMemo(
    () =>
      file && file.type.startsWith('image/') && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(file)
        : null,
    [file],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}
