import { PenLine } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { DOT_APP_EMPLOYER_SIGNATURE_DOC, type DotAppEmployerItem, type DotAppEmployerSignature, type DotAppSafetyDetail } from '@neway/shared';
import { Button, StatusSymbol, cn, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { dotAppSafetyApi, dotAppUrls, useSafetyMutation } from '@/features/dot-application/api';
import { sanitizeHtml } from '@/features/dot-application/safe-html';
import { SignaturePadDialog } from '@/features/dot-application/SignaturePadDialog';
import { FamilyBadge } from '@/features/dot-application/status';
import { longDateTime } from '@/features/hr/recruit/recruit-format';
import { fetchFileBlob, useFileObjectUrl } from '@/lib/files';

/** One Porcelain panel: radius 10, border, no shadow. */
export function Panel({ title, description, children, actions, testId, className }: { title?: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode; testId?: string; className?: string }) {
  return (
    <section className={cn('rounded-[10px] border border-nw-border bg-nw-panel p-5', className)} data-testid={testId}>
      {title || actions ? (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title ? <h3 className="text-md font-bold text-nw-text">{title}</h3> : null}
            {description ? <p className="mt-0.5 text-xs text-nw-text-3">{description}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** Done / open items, each with its symbol and word (never colour alone). */
export function Checklist({ items, testId }: { items: DotAppEmployerItem[]; testId?: string }) {
  return (
    <ul className="flex flex-col divide-y divide-nw-border" data-testid={testId}>
      {items.map((x) => (
        <li key={x.key} className="flex items-center gap-3 py-2 text-sm" data-done={x.done ? 'true' : 'false'}>
          <StatusSymbol family={x.done ? 'done' : 'neutral'} size={14} className={x.done ? 'text-nw-done-icon' : 'text-nw-neutral-icon'} />
          <span className="min-w-0 flex-1 text-nw-text">{x.title}</span>
          <span className={cn('text-xs font-semibold', x.done ? 'text-nw-done-text' : 'text-nw-text-3')}>{x.done ? 'Done' : 'Open'}</span>
        </li>
      ))}
    </ul>
  );
}

/** Sanitised legal text from the company's approved template, read-only. */
export function LegalText({ html, className }: { html: unknown; className?: string }) {
  if (typeof html !== 'string' || !html.trim()) return null;
  return (
    <div
      className={cn('rounded-lg border border-nw-border bg-nw-subtle p-4 text-sm leading-relaxed text-nw-text-2 [&_li]:ml-5 [&_li]:list-disc [&_p]:mb-2 [&_p:last-child]:mb-0 [&_table]:w-full [&_td]:border [&_td]:border-nw-border [&_td]:p-1.5 [&_th]:border [&_th]:border-nw-border [&_th]:p-1.5', className)}
      // eslint-disable-next-line react/no-danger -- allow-listed by sanitizeHtml (no attributes, no scripts)
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
    />
  );
}

export function templateOf(detail: DotAppSafetyDetail, key: string) {
  return detail.templates.find((t) => t.key === key) ?? null;
}

export function SignatureThumb({ applicationId, sigKey }: { applicationId: string; sigKey: string }) {
  const fileUrl = dotAppUrls.signature(applicationId, sigKey);
  const url = useFileObjectUrl({ fileUrl });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    // The shared hook stays silent on a failure; ask once more here so the cell can say so.
    fetchFileBlob({ fileUrl }).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [fileUrl]);
  return (
    <span className="nw-paper inline-flex h-10 w-28 items-center justify-center overflow-hidden rounded-md border border-nw-border">
      {url ? <img src={url} alt="Signature" className="max-h-9 max-w-full object-contain" /> : <span className="text-2xs">{failed ? 'Not available' : 'Loading…'}</span>}
    </span>
  );
}

/** A carrier signature: who signed and when, or "Sign" (the pad dialog). */
export function CarrierSignature({
  detail,
  sigKey,
  label,
  disabled,
  defaultName,
}: {
  detail: DotAppSafetyDetail;
  sigKey: DotAppEmployerSignature;
  label: string;
  disabled?: boolean;
  /** Who signs: the signed-in user by default; the driver for an in-person driver signature. */
  defaultName?: string;
}) {
  const { toast } = useToast();
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const docKey = DOT_APP_EMPLOYER_SIGNATURE_DOC[sigKey];
  const template = templateOf(detail, docKey);
  const signed = detail.signatures.find((s) => s.key === sigKey) ?? null;
  const sign = useSafetyMutation(detail.id, (input: { typedName: string; title?: string; image: string }) =>
    dotAppSafetyApi.sign(detail.id, { key: sigKey, docVersion: template?.version ?? '', typedName: input.typedName, esignConsent: true, image: input.image, title: input.title }),
  );
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-nw-border p-3" data-testid={`carrier-signature-${sigKey}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-nw-text">{label}</span>
        <span className="block text-xs text-nw-text-3">
          {signed
            ? `Signed by ${signed.typedName}${signed.signerTitle ? `, ${signed.signerTitle}` : ''} · ${longDateTime(signed.signedAt)} · evidence ${signed.evidenceId}`
            : template
              ? `${template.title} · version ${template.version}`
              : 'No approved document on file for this company'}
        </span>
      </span>
      {signed ? (
        <>
          <SignatureThumb applicationId={detail.id} sigKey={sigKey} />
          <FamilyBadge family="done">Signed</FamilyBadge>
        </>
      ) : (
        <Button variant="outline" size="sm" icon={<PenLine />} disabled={disabled || !template} onClick={() => setOpen(true)} data-testid={`sign-${sigKey}`}>
          Sign
        </Button>
      )}
      {open ? (
        <SignaturePadDialog
          title={label}
          documentLabel={template?.title ?? docKey}
          docVersion={template?.version ?? null}
          defaultName={defaultName ?? account?.name ?? ''}
          onClose={() => setOpen(false)}
          onSign={(input) => sign.mutateAsync(input).then(() => toast({ tone: 'success', title: 'Signed', description: label }))}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------- nested form values

export type Forms = Record<string, unknown>;

export function getPath(obj: Forms, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function setPath(obj: Forms, path: string, value: unknown): Forms {
  const [head, ...rest] = path.split('.');
  if (!head) return obj;
  if (rest.length === 0) return { ...obj, [head]: value };
  const inner = obj[head] && typeof obj[head] === 'object' ? (obj[head] as Forms) : {};
  return { ...obj, [head]: setPath(inner, rest.join('.'), value) };
}
