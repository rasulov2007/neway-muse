import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState } from 'react';
import type { TeamOrderEntry } from '@neway/shared';
import { Alert, Button, Modal, useToast } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { useSaveTeamOrder, useTeamOrder } from './api';
import { moveEntry } from './collapsed';

type Entry = Pick<TeamOrderEntry, 'dispatcherId' | 'dispatcherName' | 'dispatcherNickname'>;

/**
 * Team order (owner, 2026-10-26): teams first, TEAM 1 at the top, then the solo dispatchers, who
 * carry no number. Every board, report and the rotation page read this order.
 */
export function TeamOrderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const order = useTeamOrder(open);
  const save = useSaveTeamOrder();
  const { toast } = useToast();
  // The edits so far; until the first one the dialog shows the order as the server has it.
  const [draft, setDraft] = useState<{ teams: Entry[]; solos: Entry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const teams = draft?.teams ?? order.data?.teams ?? null;
  const solos = draft?.solos ?? order.data?.solos ?? null;
  const setTeams = (next: Entry[]) => setDraft({ teams: next, solos: solos ?? [] });
  const setSolos = (next: Entry[]) => setDraft({ teams: teams ?? [], solos: next });

  const submit = async () => {
    if (!order.data || !teams || !solos) return;
    setError(null);
    try {
      await save.mutateAsync({
        expectedVersion: order.data.version,
        teams: teams.map((t) => t.dispatcherId),
        solos: solos.map((t) => t.dispatcherId),
      });
      toast({ tone: 'success', title: 'Team order saved' });
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'Someone else changed the team order. Close and open it again to see theirs.'
          : e instanceof Error
            ? e.message
            : 'Could not save the team order',
      );
    }
  };

  const label = (e: Entry) => e.dispatcherNickname || e.dispatcherName || e.dispatcherId;
  const row = (e: Entry, i: number, list: Entry[], kind: 'team' | 'solo') => (
    <li
      key={e.dispatcherId}
      className="flex items-center gap-2 border-b border-nw-border px-2 py-1.5 last:border-b-0"
    >
      <span className="w-16 shrink-0 text-[11px] font-extrabold text-nw-accent-ink uppercase">
        {kind === 'team' ? `Team ${i + 1}` : 'Solo'}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[13px] font-semibold text-nw-text uppercase"
        title={e.dispatcherName}
      >
        {label(e)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        icon={<ArrowUp />}
        aria-label={`Move ${label(e)} up`}
        disabled={i === 0}
        onClick={() =>
          kind === 'team' ? setTeams(moveEntry(list, i, -1)) : setSolos(moveEntry(list, i, -1))
        }
      />
      <Button
        variant="ghost"
        size="sm"
        icon={<ArrowDown />}
        aria-label={`Move ${label(e)} down`}
        disabled={i === list.length - 1}
        onClick={() =>
          kind === 'team' ? setTeams(moveEntry(list, i, 1)) : setSolos(moveEntry(list, i, 1))
        }
      />
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          if (kind === 'team')
            setDraft({
              teams: list.filter((x) => x.dispatcherId !== e.dispatcherId),
              solos: [...(solos ?? []), e],
            });
          else
            setDraft({
              teams: [...(teams ?? []), e],
              solos: list.filter((x) => x.dispatcherId !== e.dispatcherId),
            });
        }}
      >
        {kind === 'team' ? 'Make solo' : 'Make team'}
      </Button>
    </li>
  );

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Team order"
      description="Teams first, TEAM 1 at the top, then solo dispatchers with no team number. The Daily and Weekly boards, reports and rotation follow this order."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!teams}
            loading={save.isPending}
            onClick={() => void submit()}
          >
            Save order
          </Button>
        </>
      }
    >
      {order.isPending || !teams || !solos ? (
        <div className="py-6 text-center text-sm text-nw-text-3">Loading…</div>
      ) : (
        <div className="flex flex-col gap-3">
          <section>
            <h3 className="mb-1 text-[12px] font-bold text-nw-text-2">Teams</h3>
            <ul className="rounded-lg border border-nw-border">
              {teams.length ? (
                teams.map((e, i) => row(e, i, teams, 'team'))
              ) : (
                <li className="px-2 py-2 text-[12.5px] text-nw-text-3">No teams.</li>
              )}
            </ul>
          </section>
          <section>
            <h3 className="mb-1 text-[12px] font-bold text-nw-text-2">Solo dispatchers</h3>
            <ul className="rounded-lg border border-nw-border">
              {solos.length ? (
                solos.map((e, i) => row(e, i, solos, 'solo'))
              ) : (
                <li className="px-2 py-2 text-[12.5px] text-nw-text-3">No solo dispatchers.</li>
              )}
            </ul>
          </section>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      )}
    </Modal>
  );
}
