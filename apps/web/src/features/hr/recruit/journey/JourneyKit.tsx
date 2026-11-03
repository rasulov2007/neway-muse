import { Download, Eye, FileText, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Button, StatusSymbol, cn, useToast, type StatusSymbolFamily } from '@/design-system';
import { DocumentViewer } from '@/features/documents/DocumentViewer';
import { downloadAuthed } from '../recruit-format';

/**
 * The journey's small kit (owner brief, 2026-10-11): one card per step with one primary action,
 * document rows with View and Download, a calm status pill (symbol + word + colour), and a file
 * picker whose Remove is a red trash button under the chosen file.
 */

export function StepCard({
  step,
  title,
  subtitle,
  children,
  actions,
  footnote,
  testId,
}: {
  step: number;
  title: string;
  subtitle?: string;
  children?: ReactNode;
  actions?: ReactNode;
  footnote?: string;
  testId?: string;
}) {
  return (
    <section className="rounded-[10px] border border-nw-border bg-nw-panel" data-testid={testId}>
      <header className="px-6 pt-6">
        <p className="text-xs font-semibold tracking-wide text-nw-accent-ink uppercase">Step {step} of 9</p>
        <h2 className="mt-1 text-lg leading-tight font-bold text-nw-text">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-nw-text-3">{subtitle}</p> : null}
      </header>
      {children ? <div className="flex flex-col gap-4 px-6 pt-5">{children}</div> : null}
      {actions ? <div className="flex flex-wrap items-center gap-3 px-6 pt-5">{actions}</div> : null}
      {footnote ? <p className="mx-6 mt-5 mb-6 text-xs text-nw-text-3">{footnote}</p> : <div className="h-6" />}
    </section>
  );
}

export function Pill({ family, children, testId }: { family: StatusSymbolFamily; children: ReactNode; testId?: string }) {
  const look: Record<StatusSymbolFamily, string> = {
    done: 'bg-nw-done-bg text-nw-done-text',
    warning: 'bg-nw-warning-bg text-nw-warning-text',
    urgent: 'bg-nw-urgent-bg text-nw-urgent-text',
    moving: 'bg-nw-moving-bg text-nw-moving-text',
    info: 'bg-nw-moving-bg text-nw-moving-text',
    neutral: 'bg-nw-subtle text-nw-text-2',
    inShop: 'bg-nw-warning-bg text-nw-warning-text',
  };
  const icon: Record<StatusSymbolFamily, string> = {
    done: 'text-nw-done-icon',
    warning: 'text-nw-warning-icon',
    urgent: 'text-nw-urgent-icon',
    moving: 'text-nw-moving-icon',
    info: 'text-nw-moving-icon',
    neutral: 'text-nw-text-3',
    inShop: 'text-nw-warning-icon',
  };
  return (
    <span className={cn('inline-flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-xs font-semibold whitespace-nowrap', look[family])} data-testid={testId}>
      <StatusSymbol family={family} size={12} className={icon[family]} />
      {children}
    </span>
  );
}

/** One document: what it is, its state, View (in the app) and Download / PDF. */
export function DocRow({
  label,
  detail,
  status,
  view,
  download,
  testId,
}: {
  label: string;
  detail?: string | null;
  status?: ReactNode;
  view?: { url: string; title: string; contentType?: string; fileName: string } | null;
  download?: { url: string; fileName: string; label?: string } | null;
  testId?: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-nw-border py-2.5 last:border-0" data-testid={testId}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-nw-subtle text-nw-text-2">
        <FileText aria-hidden className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-nw-text">{label}</span>
        {detail ? <span className="block truncate text-xs text-nw-text-3">{detail}</span> : null}
      </span>
      {status}
      {view ? (
        <Button variant="outline" size="sm" icon={<Eye />} onClick={() => setOpen(true)}>
          View
        </Button>
      ) : null}
      {download ? (
        <Button
          variant="outline"
          size="sm"
          icon={<Download />}
          onClick={() => void downloadAuthed(download.url, download.fileName).catch(() => toast({ tone: 'danger', title: 'The file could not be downloaded' }))}
        >
          {download.label ?? 'Download'}
        </Button>
      ) : null}
      {open && view ? (
        <DocumentViewer
          source={{ kind: 'file', file: { fileUrl: view.url } }}
          title={view.title}
          contentType={view.contentType}
          fileName={view.fileName}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </li>
  );
}

/** A file chooser: the chosen file, and under it, on the left, a red trash button that clears it. */
export function FilePick({
  label,
  file,
  onFile,
  accept = 'application/pdf,image/jpeg,image/png',
  testId,
}: {
  label: string;
  file: File | null;
  onFile: (f: File | null) => void;
  accept?: string;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <span className="text-sm font-medium text-nw-text">{label}</span>
      {file ? (
        <>
          <span className="flex items-center gap-2 rounded-lg border border-nw-border bg-nw-subtle px-3 py-2 text-sm text-nw-text">
            <FileText aria-hidden className="size-4 text-nw-text-3" />
            <span className="truncate">{file.name}</span>
            <span className="ml-auto text-xs text-nw-text-3">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
          </span>
          <button
            type="button"
            onClick={() => {
              onFile(null);
              if (input.current) input.current.value = '';
            }}
            className="inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold text-nw-urgent-text hover:bg-nw-urgent-bg"
            data-testid={testId ? `${testId}-remove` : undefined}
          >
            <Trash2 aria-hidden className="size-4" />
            Remove file
          </button>
        </>
      ) : (
        <Button variant="outline" size="sm" className="w-fit" onClick={() => input.current?.click()}>
          Choose file
        </Button>
      )}
      <input ref={input} type="file" accept={accept} className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
    </div>
  );
}

/** A labelled fact line (When, Who, What). */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <span className="min-w-[132px] text-nw-text-3">{label}</span>
      <span className="text-nw-text">{children}</span>
    </div>
  );
}
