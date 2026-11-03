import { Search, User, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { pairableCandidates, type DriverTeamView } from '@neway/shared';
import { Badge, Button, DatePicker, FormField, Input, Modal, Textarea, cn, useToast } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { usePairDriver, useUnpairDriver } from './team-api';

/**
 * Team or Solo on the Drivers list and the driver page (owner, 2026-10-25). Pair opens a search of
 * the company's active drivers who are not in a team, the partner is picked and confirmed, and
 * both drivers become a team with each other. Unpair asks why and makes both Solo again.
 */

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.');

/** Team (with the partner's name) or Solo: an icon and a word, never colour alone. */
export function TeamBadge({ team, pending, size = 'sm' }: { team: DriverTeamView | null | undefined; pending?: boolean; size?: 'sm' | 'md' }) {
  if (pending) return <span className="text-xs text-nw-text-3">Loading…</span>;
  if (team) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5" title={`Team since ${formatIsoDate(team.startedOn)}`} data-testid="team-badge">
        <Badge tone="info" size={size} icon={<Users aria-hidden />}>Team</Badge>
        <span className="truncate text-sm text-nw-text">with {team.partnerName}</span>
      </span>
    );
  }
  return (
    <Badge tone="neutral" size={size} icon={<User aria-hidden />} data-testid="team-badge">
      Solo
    </Badge>
  );
}

export interface PairCandidate {
  id: string;
  name: string;
  driverNumber: string;
  status: string;
  archivedAt?: string | null;
  currentTruckUnit?: string | null;
}

export function PairDriverModal({
  driverId,
  driverName,
  drivers,
  pairedIds,
  onClose,
}: {
  driverId: string;
  driverName: string;
  /** The company's drivers (the roster the page already holds). */
  drivers: readonly PairCandidate[];
  /** Drivers in a team today: never offered. */
  pairedIds: ReadonlySet<string>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const today = companyToday();
  const [search, setSearch] = useState('');
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [startedOn, setStartedOn] = useState(today);
  const [note, setNote] = useState('');
  const pair = usePairDriver(driverId);
  const candidates = useMemo(() => pairableCandidates(drivers, driverId, pairedIds, search), [drivers, driverId, pairedIds, search]);
  const partner = drivers.find((d) => d.id === partnerId) ?? null;
  const bad = !partner ? 'Choose the partner' : !startedOn ? 'Pick the first day as a team' : startedOn > today ? 'A team starts today or earlier' : null;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title={`Pair ${driverName}`}
      description="Search the partner and confirm. Both drivers become a team with each other; loads already booked are not changed."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={bad !== null}
            loading={pair.isPending}
            data-testid="confirm-pair"
            onClick={() =>
              partner &&
              pair.mutate(
                { partnerId: partner.id, startedOn, note: note.trim() || null },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: `${driverName} and ${partner.name} are a team` });
                    onClose();
                  },
                  onError: (e) => toast({ tone: 'danger', title: 'Not paired', description: errorText(e) }),
                },
              )
            }
          >
            {partner ? `Pair with ${partner.name}` : 'Pair'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Partner" required description="Active drivers of this company who are not in a team.">
          <Input
            type="search"
            aria-label="Search partner"
            placeholder="Search name or driver #"
            prefix={<Search aria-hidden />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </FormField>
        <ul role="listbox" aria-label="Partners" className="max-h-64 overflow-y-auto rounded-lg border border-nw-border" data-testid="pair-candidates">
          {candidates.length === 0 ? (
            <li className="px-3 py-3 text-sm text-nw-text-3">No unpaired active driver matches.</li>
          ) : (
            candidates.map((d) => {
              const selected = d.id === partnerId;
              return (
                <li key={d.id} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onClick={() => setPartnerId(d.id)}
                    className={cn(
                      'flex w-full cursor-pointer items-center justify-between gap-3 border-b border-nw-border px-3 py-2 text-left text-sm last:border-b-0',
                      selected ? 'bg-nw-accent-tint text-nw-accent-ink' : 'hover:bg-nw-subtle',
                    )}
                  >
                    <span className="min-w-0 truncate font-semibold text-nw-text">{d.name}</span>
                    <span className="shrink-0 text-xs text-nw-text-2">
                      {d.driverNumber}
                      {d.currentTruckUnit ? ` · Unit ${d.currentTruckUnit}` : ''}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
        <FormField label="First day as a team" required>
          <DatePicker aria-label="First day as a team" value={startedOn} onIsoChange={(v) => setStartedOn(v ?? '')} />
        </FormField>
        <FormField label="Note">
          <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Team note" />
        </FormField>
        {bad && partner ? <p className="text-xs font-semibold text-nw-urgent-text">{bad}</p> : null}
      </div>
    </Modal>
  );
}

export function UnpairDriverModal({ driverId, driverName, team, onClose }: { driverId: string; driverName: string; team: DriverTeamView; onClose: () => void }) {
  const { toast } = useToast();
  const today = companyToday();
  const [endedOn, setEndedOn] = useState(today);
  const [reason, setReason] = useState('');
  const unpair = useUnpairDriver(driverId, team.pairId);
  const bad =
    reason.trim().length < 3 ? 'Say why the team is split' : !endedOn ? 'Pick the first solo day' : endedOn > today ? 'A team cannot be split on a future day' : endedOn < team.startedOn ? 'The split cannot be before the team started' : null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Unpair ${driverName} and ${team.partnerName}`}
      description={`Both drivers are Solo again from the day you pick. The team since ${formatIsoDate(team.startedOn)} stays in their history.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={bad !== null}
            loading={unpair.isPending}
            data-testid="confirm-unpair"
            onClick={() =>
              unpair.mutate(
                { version: team.version, reason: reason.trim(), endedOn },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: `${driverName} and ${team.partnerName} are Solo` });
                    onClose();
                  },
                  onError: (e) => toast({ tone: 'danger', title: 'Not unpaired', description: errorText(e) }),
                },
              )
            }
          >
            Unpair
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="First solo day" required>
          <DatePicker aria-label="First solo day" value={endedOn} onIsoChange={(v) => setEndedOn(v ?? '')} />
        </FormField>
        <FormField label="Reason" required>
          <Textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Unpair reason" placeholder="Went solo, partner left the company…" />
        </FormField>
      </div>
    </Modal>
  );
}

/** Past teams on the driver page, shown once the driver has any ended pairing. */
export function TeamHistory({ history }: { history: readonly DriverTeamView[] }) {
  const past = history.filter((h) => h.state === 'ended');
  if (past.length === 0) return null;
  return (
    <section aria-label="Team history" className="rounded-[10px] border border-nw-border bg-nw-panel p-4" data-testid="team-history">
      <h3 className="mb-2 text-sm font-bold text-nw-text">Team history</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {past.map((h) => (
          <li key={h.id} className="text-nw-text-2" title={h.endReason ?? undefined}>
            <span className="font-semibold text-nw-text">{h.partnerName}</span> · {formatIsoDate(h.startedOn)} – {h.endedOn ? formatIsoDate(h.endedOn) : ''}
            {h.endReason ? ` · ${h.endReason}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
