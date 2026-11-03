import { useEffect, useRef } from 'react';

/**
 * A drawn signature: pointer strokes on a canvas, exported as a PNG data URL. Works with a finger,
 * a pen or a mouse; Clear empties it. The parent learns about every change (null when empty).
 */
export function SignaturePad({ onChange, disabled }: { onChange: (dataUrl: string | null) => void; disabled?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const rect = c.getBoundingClientRect();
    c.width = Math.round(rect.width * ratio);
    c.height = Math.round(rect.height * ratio);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // The ink is the page's own text colour (a Porcelain token), read from the canvas.
    ctx.strokeStyle = getComputedStyle(c).getPropertyValue('--nw-text').trim() || 'currentColor';
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    dirty.current = true;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current && canvas.current) onChange(canvas.current.toDataURL('image/png'));
  };
  const clear = () => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.restore();
    dirty.current = false;
    onChange(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <canvas
        ref={canvas}
        aria-label="Draw your signature"
        className="h-36 w-full touch-none rounded-[10px] border border-nw-border-strong bg-nw-panel"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        data-testid="signature-pad"
      />
      <button type="button" onClick={clear} className="w-fit text-sm font-semibold text-nw-accent-ink hover:underline" disabled={disabled}>
        Clear signature
      </button>
    </div>
  );
}
