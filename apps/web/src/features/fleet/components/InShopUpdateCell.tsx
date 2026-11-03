import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus } from 'lucide-react';
import { useState } from 'react';
import { Button, FormField, Modal, Textarea, cn, useToast } from '@/design-system';
import { apiPost } from '@/lib/api-client';
import { nowMs } from '@/lib/clock';
import { formatDateTime } from '@/lib/format';
import { IN_SHOP_ISSUES_KEY, useInShopIssues } from './in-shop-issues';

const HOUR = 3_600_000;

/** "3h", "2d 4h": how long ago, short enough for a list cell. */
function ago(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  const hours = Math.floor(ms / HOUR);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/**
 * The shop's last word on a unit in maintenance (owner, 2026-10-19): how long since its open work
 * order was last updated, how long it has been in the shop, and a button to write the next update
 * - which is what resets the clock. Older than a day reads amber, older than two red, so a unit
 * nobody has chased stands out.
 */
export function InShopUpdateCell({ unitId }: { unitId: string }) {
  const issue = useInShopIssues(true).get(unitId) ?? null;
  const [writing, setWriting] = useState(false);
  if (!issue) return <span className="text-faint">—</span>;
  const now = nowMs();
  const since = now - Date.parse(issue.updatedAt);
  const tone = since > 48 * HOUR ? 'text-nw-urgent-text' : since > 24 * HOUR ? 'text-nw-warning-text' : 'text-nw-text';
  return (
    <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <span className="min-w-0" title={`${issue.number} last updated ${formatDateTime(issue.updatedAt)} · in the shop since ${formatDateTime(issue.shopInAt)}`}>
        <span className={cn('block text-sm font-semibold tabular-nums', tone)}>{ago(issue.updatedAt, now)} ago</span>
        <span className="block text-xs text-nw-text-3 tabular-nums">In shop {ago(issue.shopInAt, now)}</span>
      </span>
      <Button size="sm" variant="ghost" icon={<MessageSquarePlus />} aria-label={`Write an update on ${issue.number}`} title="Write an update" onClick={() => setWriting(true)} />
      {writing ? <UpdateNote orderId={issue.orderId} number={issue.number} onClose={() => setWriting(false)} /> : null}
    </span>
  );
}

function UpdateNote({ orderId, number, onClose }: { orderId: string; number: string; onClose: () => void }) {
  const [note, setNote] = useState('');
  const client = useQueryClient();
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: () => apiPost(`/fleet/work-orders/${encodeURIComponent(orderId)}/note`, { note: note.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: IN_SHOP_ISSUES_KEY });
      await client.invalidateQueries({ queryKey: ['work-orders'] });
      toast({ tone: 'success', title: `Update added to ${number}` });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Update not saved', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="sm"
      title={`Update · ${number}`}
      description="What the shop said. It goes on the work order's history and restarts the Last update clock."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!note.trim() || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>
            Save update
          </Button>
        </>
      }
    >
      <FormField label="Update" required>
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Waiting on the injector, ETA Thursday" autoFocus />
      </FormField>
    </Modal>
  );
}
