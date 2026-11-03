import { Copy, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { withRouteLine } from '@neway/shared';
import { Button, Textarea, useToast } from '@/design-system';
import { copyText } from '@/lib/clipboard';

/**
 * The Telegram message for the driver, written from the RC the reader read (owner, 2026-10-17)
 * and shown the moment the load is created (owner, 2026-10-23; see `bookedDriverMessage`). The
 * dispatcher checks and edits it - lines the RC does not say (trailer, "ready now")
 * are theirs to add - then copies it or opens Telegram with it.
 */
export function DriverMessageCard({ initialText, routeLine }: { initialText: string; routeLine?: string | null }) {
  const { toast } = useToast();
  const [text, setText] = useState(initialText);
  // A road chosen after the text was written (owner, 2026-10-27) goes into the text as it now
  // reads - the dispatcher's own edits stay; the Route line is replaced, never doubled.
  const lastRoute = useRef(routeLine ?? null);
  useEffect(() => {
    const next = routeLine ?? null;
    if (next === lastRoute.current) return;
    lastRoute.current = next;
    setText((current) => withRouteLine(current, next));
  }, [routeLine]);
  const copy = async () => {
    let ok = true;
    try {
      await copyText(text);
    } catch {
      ok = false;
    }
    toast(ok ? { tone: 'success', title: 'Driver message copied', description: 'Paste it in the driver’s Telegram chat.' } : { tone: 'danger', title: 'Could not copy', description: 'Select the text and copy it by hand.' });
  };
  return (
    <section aria-label="Driver message" className="flex flex-col gap-2 rounded-[8px] border border-nw-border bg-nw-panel p-2.5" data-testid="driver-message">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">Message for the driver</p>
        <div className="flex gap-2">
          <Button size="sm" variant="primary" icon={<Copy />} onClick={() => void copy()} data-testid="copy-driver-message">
            Copy
          </Button>
          <a
            href={`https://t.me/share/url?url=${encodeURIComponent(' ')}&text=${encodeURIComponent(text)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-nw-border px-3 text-sm font-semibold text-nw-text hover:bg-nw-hover"
          >
            <Send className="size-4" aria-hidden /> Telegram
          </a>
        </div>
      </div>
      <Textarea rows={20} value={text} onChange={(e) => setText(e.target.value)} aria-label="Driver message" className="font-mono text-[13px]" />
      <p className="text-xs text-muted">Check it against the RC and add what it does not say (the trailer) before sending.</p>
    </section>
  );
}
