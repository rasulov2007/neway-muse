import { Link } from '@tanstack/react-router';
import { Download, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ACCIDENT_STAGES, ACCIDENT_STAGE_LABEL, type SafetyAccident } from '@neway/shared';
import { Badge, Button, Input, Select, StatusBadge, Tabs } from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import { useAccidents, useCan } from './api';
import { AccidentForm } from './AccidentForm';
import { DueText, LoadError, Loading, OwnerCell, Panel, SafetyTitle, Sub, td, th } from './ui';

/** The testing column in one word: not required, collected, pending, or owed. */
export function accidentTestingStatus(a: SafetyAccident): { status: string; label?: string } {
  const alc = a.testing.alcohol.required;
  const drg = a.testing.drug.required;
  if (alc === 'undetermined' || drg === 'undetermined') return { status: 'result_pending', label: 'Needs assessment' };
  if (alc === 'no' && drg === 'no') return { status: 'not_required' };
  const required = a.tests.filter((t) => t.required);
  if (required.length > 0 && required.every((t) => t.status.resolved)) return { status: 'collected', label: 'Complete' };
  if (required.some((t) => t.status.progress === 'not_completed')) return { status: 'not_completed' };
  if (required.length > 0 && required.every((t) => t.collectedAt || t.status.progress === 'exception_reviewed')) return { status: 'collected' };
  return { status: 'required' };
}

type Tab = 'all' | 'open' | 'closed' | 'dot';

/**
 * Accidents, as the owner's mockup draws them (2026-10-02): filters, four tabs, one row per file
 * with its stage, testing and next action. Every row is a server record; an empty company shows
 * an empty table, never examples.
 */
export function AccidentsV2Page({ startRecording = false }: { startRecording?: boolean }) {
  const list = useAccidents();
  const canWrite = useCan('safety.manage');
  const [recording, setRecording] = useState(startRecording);
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('all');
  const [driver, setDriver] = useState('all');
  const [unit, setUnit] = useState('all');
  const [dot, setDot] = useState('all');

  const rows = list.data ?? [];
  const drivers = useMemo(() => [...new Map(rows.filter((r) => r.driverId).map((r) => [r.driverId as string, r.driverName ?? ''])).entries()], [rows]);
  const units = useMemo(() => [...new Map(rows.filter((r) => r.truckId).map((r) => [r.truckId as string, r.truckNumber ?? ''])).entries()], [rows]);
  const counts = {
    all: rows.length,
    open: rows.filter((r) => r.stage !== 'closed').length,
    closed: rows.filter((r) => r.stage === 'closed').length,
    dot: rows.filter((r) => r.dotRecordable).length,
  };
  const shown = rows.filter((r) => {
    if (tab === 'open' && r.stage === 'closed') return false;
    if (tab === 'closed' && r.stage !== 'closed') return false;
    if (tab === 'dot' && !r.dotRecordable) return false;
    if (stage !== 'all' && r.stage !== stage) return false;
    if (driver !== 'all' && r.driverId !== driver) return false;
    if (unit !== 'all' && r.truckId !== unit) return false;
    if (dot !== 'all' && String(r.dotRecordable) !== dot) return false;
    const q = search.trim().toLowerCase();
    if (q && ![r.number, r.driverName, r.truckNumber, r.location, r.city, r.state].some((v) => v?.toLowerCase().includes(q))) return false;
    return true;
  });

  /** The DOT accident register (49 CFR 390.15) as CSV, from the records on screen. */
  const exportRegister = () => {
    const header = ['Number', 'Date', 'City', 'State', 'Driver', 'Fatalities', 'Injuries', 'Hazmat released'];
    const lines = rows
      .filter((r) => r.dotRecordable)
      .map((r) => [r.number, r.occurredAt.slice(0, 10), r.city ?? '', r.state ?? '', r.driverName ?? '', String(r.fatalities), String(r.injuries), 'Not recorded']);
    const csv = [header, ...lines].map((l) => l.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dot-accident-register.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex w-full flex-col gap-4">
      {recording ? <AccidentForm open={recording} onOpenChange={setRecording} /> : null}
      <SafetyTitle
        title="Accidents"
        subtitle="View and manage all accidents."
        actions={
          canWrite ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setRecording(true)}>
              Record accident
            </Button>
          ) : null
        }
      />
      <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
        <Input prefix={<Search className="size-4" />} placeholder="Search by case, driver, location…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search accidents" />
        <Select value={stage} onValueChange={setStage} options={[{ value: 'all', label: 'All statuses' }, ...ACCIDENT_STAGES.map((s) => ({ value: s, label: ACCIDENT_STAGE_LABEL[s] }))]} aria-label="Status" />
        <Select value={driver} onValueChange={setDriver} options={[{ value: 'all', label: 'All drivers' }, ...drivers.map(([id, name]) => ({ value: id, label: name }))]} aria-label="Driver" />
        <Select value={unit} onValueChange={setUnit} options={[{ value: 'all', label: 'All units' }, ...units.map(([id, num]) => ({ value: id, label: `Unit ${num}` }))]} aria-label="Unit" />
        <Select value={dot} onValueChange={setDot} options={[{ value: 'all', label: 'DOT recordable (all)' }, { value: 'true', label: 'DOT recordable' }, { value: 'false', label: 'Not recordable' }]} aria-label="DOT recordable" />
      </div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          items={[
            { value: 'all', label: 'All incidents', count: list.data ? counts.all : undefined },
            { value: 'open', label: 'Open', count: list.data ? counts.open : undefined },
            { value: 'closed', label: 'Closed', count: list.data ? counts.closed : undefined },
            { value: 'dot', label: 'DOT register', count: list.data ? counts.dot : undefined },
          ]}
        />
        <Button variant="outline" size="sm" icon={<Download />} onClick={exportRegister} disabled={!list.data || counts.dot === 0}>
          Export DOT register
        </Button>
      </div>
      <Panel padding="none">
        {list.isLoading ? <Loading /> : list.error ? <LoadError error={list.error} /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse">
              <thead className="border-b border-nw-border bg-nw-subtle">
                <tr>
                  <th className={th}>Date &amp; case</th>
                  <th className={th}>Driver</th>
                  <th className={th}>Truck</th>
                  <th className={th}>Location</th>
                  <th className={th}>DOT recordable</th>
                  <th className={th}>Stage</th>
                  <th className={th}>Testing</th>
                  <th className={th}>Next action</th>
                  <th className={th}>Owner</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nw-border">
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-10 text-center text-sm text-nw-text-3">
                      {rows.length === 0 ? 'No accidents recorded.' : 'No accidents match these filters.'}
                    </td>
                  </tr>
                ) : (
                  shown.map((a) => {
                    const testing = accidentTestingStatus(a);
                    return (
                      <tr key={a.id} className="hover:bg-nw-hover">
                        <td className={`${td} whitespace-nowrap`}>
                          {formatIsoDate(a.occurredAt.slice(0, 10))}
                          <Link to="/safety/accidents/$accidentId" params={{ accidentId: a.id }} className="block font-semibold text-nw-accent-ink underline underline-offset-2">
                            {a.number}
                          </Link>
                          {a.isTest ? <Badge size="sm">Test</Badge> : null}
                        </td>
                        <td className={td}>{a.driverName ?? <span className="text-nw-text-3">Not named</span>}</td>
                        <td className={td}>
                          {a.truckNumber ? `Unit ${a.truckNumber}` : <span className="text-nw-text-3">None</span>}
                          {a.trailerNumber ? <Sub>Trailer {a.trailerNumber}</Sub> : null}
                        </td>
                        <td className={td}>{[a.city, a.state].filter(Boolean).join(', ') || a.location}</td>
                        <td className={td}>
                          <StatusBadge status={a.dotRecordable ? 'required' : 'not_required'} label={a.dotRecordable ? 'Yes' : 'No'} />
                        </td>
                        <td className={td}>
                          <StatusBadge status={a.stage === 'reported' ? 'reported' : a.stage} label={ACCIDENT_STAGE_LABEL[a.stage]} />
                        </td>
                        <td className={td}>
                          <StatusBadge status={testing.status} label={testing.label} />
                        </td>
                        <td className={td}>
                          {a.nextAction ?? <span className="text-nw-text-3">None</span>}
                          {a.nextAction && a.nextActionDueOn ? (
                            <Sub>
                              Due <DueText dueOn={a.nextActionDueOn} className="text-xs" />
                            </Sub>
                          ) : null}
                        </td>
                        <td className={td}>
                          <OwnerCell name={a.ownerName} />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
