import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { weekStartMonday, type DispatchTeamMembers, type RosterRow, type SeparateDispatchersInput, type SeparateTeamInput } from '@neway/shared';
import { Alert, Button, DatePicker, FormField, Modal, RadioGroup, useToast } from '@/design-system';
import { apiGet, apiPost } from '@/lib/api-client';
import { formatIsoDate } from '@/lib/format';
import { useInvalidating } from './api';
import { WeekPicker } from './chrome';
import { ReasonPicker } from './RosterDialogs';

/**
 * Separate team and Separate dispatchers (owner, 2026-10-28).
 *
 * Both ask the same four things: who stays on the board, from which week the one who stays works
 * alone, why, and whether the other comes back - from that day it is a team again. Pay follows:
 * a driver who left is on no loads, so the one who stayed is paid 100 %; a dispatcher who left
 * gets no share of the team commission (50/50 again from the return day).
 */

function useSeparateTeam() {
  return useInvalidating(({ id, ...input }: SeparateTeamInput & { id: string }) => apiPost<RosterRow>(`/dispatch/roster/${id}/separate`, input));
}

function useSeparateDispatchers() {
  return useInvalidating(({ dispatcherId, ...input }: SeparateDispatchersInput & { dispatcherId: string }) =>
    apiPost<DispatchTeamMembers>(`/dispatch/teams/${encodeURIComponent(dispatcherId)}/separate`, input),
  );
}

function ReturnFields({ comesBack, setComesBack, returnsOn, setReturnsOn, who }: { comesBack: boolean; setComesBack: (v: boolean) => void; returnsOn: string; setReturnsOn: (v: string) => void; who: string }) {
  return (
    <>
      <FormField label={`Does ${who} come back?`}>
        <RadioGroup
          aria-label="Comes back"
          orientation="horizontal"
          value={comesBack ? 'yes' : 'no'}
          onValueChange={(v) => setComesBack(v === 'yes')}
          options={[
            { value: 'no', label: 'No' },
            { value: 'yes', label: 'Yes' },
          ]}
        />
      </FormField>
      {comesBack ? (
        <FormField label="Comes back on" required description="From this day the board shows the team again.">
          <DatePicker aria-label="Comes back on" value={returnsOn} onIsoChange={(iso) => setReturnsOn(iso ?? '')} />
        </FormField>
      ) : null}
    </>
  );
}

export function SeparateTeamDialog({ row, week, onClose }: { row: RosterRow; week: string; onClose: () => void }) {
  const separate = useSeparateTeam();
  const { toast } = useToast();
  const partner = row.coDriver ?? '';
  const [stays, setStays] = useState<'driver' | 'co_driver'>('driver');
  const [fromWeek, setFromWeek] = useState(() => weekStartMonday(week));
  const [reason, setReason] = useState('');
  const [comesBack, setComesBack] = useState(false);
  const [returnsOn, setReturnsOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stayer = stays === 'driver' ? row.name : partner;
  const leaver = stays === 'driver' ? partner : row.name;
  const save = async () => {
    setError(null);
    if (reason.trim().length < 2) return setError('Say why the team splits');
    if (comesBack && !returnsOn) return setError(`Pick the day ${leaver} comes back`);
    try {
      await separate.mutateAsync({ id: row.id, stays, fromWeek, reason: reason.trim(), returnsOn: comesBack ? returnsOn : null, expectedVersion: row.version });
      toast({
        tone: 'success',
        title: `${stayer} drives solo from the week of ${formatIsoDate(fromWeek)}`,
        description: comesBack ? `${leaver} is back on the row from ${formatIsoDate(returnsOn)}.` : `${leaver} is off the row; earlier weeks keep the team.`,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The split was refused.');
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Separate team · ${row.name} // ${partner}`}
      description="Earlier weeks keep the team. The one who leaves is on no loads after the split, so the one who stays is paid 100 %."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={separate.isPending} onClick={() => void save()}>
            Separate team
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Who stays on the board" required description="The one who stays keeps the truck and the row.">
          <RadioGroup aria-label="Who stays on the board" value={stays} onValueChange={(v) => setStays(v as 'driver' | 'co_driver')} options={[
            { value: 'driver', label: row.name },
            { value: 'co_driver', label: partner },
          ]} />
        </FormField>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-nw-text-2">{stayer} is solo from the week of</span>
          <WeekPicker week={fromWeek} onChange={setFromWeek} label="Solo from the week of" />
        </div>
        <ReasonPicker label="Why the team splits" value={reason} onChange={setReason} />
        <ReturnFields comesBack={comesBack} setComesBack={setComesBack} returnsOn={returnsOn} setReturnsOn={setReturnsOn} who={leaver} />
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}

export function SeparateDispatchersDialog({ dispatcherId, teamName, week, onClose }: { dispatcherId: string; teamName: string; week: string; onClose: () => void }) {
  const members = useQuery({
    queryKey: ['dispatch', 'team-members', dispatcherId],
    queryFn: () => apiGet<DispatchTeamMembers>(`/dispatch/teams/${encodeURIComponent(dispatcherId)}/members`),
  });
  const separate = useSeparateDispatchers();
  const { toast } = useToast();
  const [staysKey, setStaysKey] = useState('');
  const [fromWeek, setFromWeek] = useState(() => weekStartMonday(week));
  const [reason, setReason] = useState('');
  const [comesBack, setComesBack] = useState(false);
  const [returnsOn, setReturnsOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = members.data?.members ?? [];
  const stayer = list.find((m) => m.key === staysKey);
  const leavers = stayer ? list.filter((m) => m.key !== staysKey).map((m) => m.name).join(', ') : '';
  const save = async () => {
    setError(null);
    if (!stayer) return setError('Choose who stays on the board');
    if (reason.trim().length < 2) return setError('Say why the team splits');
    if (comesBack && !returnsOn) return setError('Pick the day they come back');
    try {
      await separate.mutateAsync({ dispatcherId, staysKey, fromWeek, reason: reason.trim(), returnsOn: comesBack ? returnsOn : null });
      toast({
        tone: 'success',
        title: `${stayer.name} runs ${teamName} alone from the week of ${formatIsoDate(fromWeek)}`,
        description: comesBack ? `100 % to ${stayer.name} until ${formatIsoDate(returnsOn)}, then 50/50 again.` : `${stayer.name} is paid 100 % of the team commission; ${leavers} nothing.`,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The split was refused.');
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Separate dispatchers · ${teamName}`}
      description="A team's commission is shared 50/50. From the chosen week the one who stays is paid 100 % and the one who left nothing; earlier weeks keep the split."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={separate.isPending} disabled={list.length < 2} onClick={() => void save()}>
            Separate dispatchers
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {members.isPending ? (
          <p className="text-sm text-nw-text-3">Loading…</p>
        ) : list.length < 2 ? (
          <Alert tone="info">This team has one dispatcher: there is nobody to separate.</Alert>
        ) : (
          <>
            <FormField label="Who stays on the board" required>
              <RadioGroup aria-label="Who stays on the board" value={staysKey} onValueChange={setStaysKey} options={list.map((m) => ({ value: m.key, label: `${m.name} (${m.sharePct}% now)` }))} />
            </FormField>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] text-nw-text-2">Alone from the week of</span>
              <WeekPicker week={fromWeek} onChange={setFromWeek} label="Alone from the week of" />
            </div>
            <ReasonPicker label="Why the team splits" value={reason} onChange={setReason} />
            <ReturnFields comesBack={comesBack} setComesBack={setComesBack} returnsOn={returnsOn} setReturnsOn={setReturnsOn} who={leavers || 'the other dispatcher'} />
          </>
        )}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}

