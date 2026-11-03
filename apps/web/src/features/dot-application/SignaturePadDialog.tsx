import { Eraser } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, FormField, Input, Modal } from '@/design-system';
import { errorText } from '@/features/hr/recruit/journey/journey-utils';

export interface SignatureInput {
  typedName: string;
  title?: string;
  image: string;
}

/**
 * The carrier's signature on a Safety form: typed name, optional title, a drawn signature and the
 * e-sign consent. Drawn with pointer events (mouse, pen, finger); the pad itself does not scroll
 * the page (touch-action: none). The pad is paper (.nw-paper) in both themes, inked in --nw-paper-text.
 */
export function SignaturePadDialog({
  title,
  documentLabel,
  docVersion,
  defaultName,
  askTitle = true,
  onSign,
  onClose,
}: {
  title: string;
  documentLabel: string;
  docVersion: string | null;
  defaultName: string;
  askTitle?: boolean;
  onSign: (input: SignatureInput) => Promise<unknown>;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [inked, setInked] = useState(false);
  const [name, setName] = useState(defaultName);
  const [signerTitle, setSignerTitle] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    const box = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(box.width * ratio));
    c.height = Math.max(1, Math.round(box.height * ratio));
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.scale(ratio, ratio);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.2;
    }
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };
  const ink = () => getComputedStyle(document.documentElement).getPropertyValue('--nw-paper-text').trim() || 'currentColor';

  const clear = () => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    setInked(false);
  };

  /** The PNG sent to the server: paper ink on a transparent pad (the pad is paper in both themes). */
  const exportPng = (): string => canvas.current!.toDataURL('image/png');

  const ready = inked && name.trim().length >= 2 && consent && Boolean(docVersion);
  return (
    <Modal
      open
      onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}
      size="md"
      title={title}
      description={`${documentLabel}${docVersion ? ` · version ${docVersion}` : ''}`}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={busy}
            data-testid="signature-confirm"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onSign({ typedName: name.trim(), title: askTitle && signerTitle.trim() ? signerTitle.trim() : undefined, image: exportPng() });
                onClose();
              } catch (e) {
                setError(errorText(e, 'The signature was not saved.'));
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {!docVersion ? <Alert tone="warning" title="No approved document" description="This form has no approved version for this company, so it cannot be signed." /> : null}
        {error ? <Alert tone="danger" title="Not signed" description={error} /> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Full name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </FormField>
          {askTitle ? (
            <FormField label="Title">
              <Input value={signerTitle} onChange={(e) => setSignerTitle(e.target.value)} placeholder="Safety Manager" />
            </FormField>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-nw-text">Signature</span>
            <Button variant="ghost" size="sm" icon={<Eraser />} onClick={clear} disabled={!inked}>
              Clear
            </Button>
          </div>
          <canvas
            ref={canvas}
            aria-label="Signature pad: draw your signature"
            data-testid="signature-pad"
            className="h-40 w-full cursor-crosshair rounded-lg border border-dashed border-nw-border-strong nw-paper"
            style={{ touchAction: 'none' }}
            onPointerDown={(e) => {
              const ctx = e.currentTarget.getContext('2d');
              if (!ctx) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drawing.current = true;
              const p = point(e);
              ctx.strokeStyle = ink();
              ctx.beginPath();
              ctx.moveTo(p.x, p.y);
              ctx.lineTo(p.x + 0.1, p.y + 0.1);
              ctx.stroke();
              setInked(true);
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              const ctx = e.currentTarget.getContext('2d');
              if (!ctx) return;
              const p = point(e);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
            }}
            onPointerUp={() => {
              drawing.current = false;
            }}
            onPointerCancel={() => {
              drawing.current = false;
            }}
          />
        </div>
        <Checkbox
          checked={consent}
          onCheckedChange={(v) => setConsent(v === true)}
          label="I agree to use an electronic signature. It is as legally binding as an ink signature."
        />
      </div>
    </Modal>
  );
}
