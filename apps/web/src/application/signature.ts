/**
 * The bounding box of the ink on the pad (sampled every `step` pixels, as the prototype does),
 * padded and clamped to the canvas. Pure, so it is tested without a canvas.
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function inkBounds(alpha: (x: number, y: number) => number, width: number, height: number, step = 2, pad = 4): Box | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += step)
    for (let x = 0; x < width; x += step)
      if (alpha(x, y) > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const x = Math.max(0, x0 - pad);
  const y = Math.max(0, y0 - pad);
  const r = Math.min(width, x1 + pad + 1);
  const b = Math.min(height, y1 + pad + 1);
  return { x, y, w: Math.max(1, r - x), h: Math.max(1, b - y) };
}

/** A trimmed PNG data URL of the canvas ink, or null when nothing was drawn. */
export function trimmedPng(cv: HTMLCanvasElement): string | null {
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const { width: w, height: h } = cv;
  const px = ctx.getImageData(0, 0, w, h).data;
  const box = inkBounds((x, y) => px[(y * w + x) * 4 + 3] ?? 0, w, h);
  if (!box) return null;
  const out = document.createElement('canvas');
  out.width = box.w;
  out.height = box.h;
  out.getContext('2d')?.drawImage(cv, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return out.toDataURL('image/png');
}
