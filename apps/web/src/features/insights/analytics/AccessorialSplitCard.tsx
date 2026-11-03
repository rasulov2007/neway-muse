import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { StatusSymbol, cn } from '@/design-system';
import { formatMoney, formatNumber } from '@/lib/format';
import type {
  AccessorialDriverBasis,
  AccessorialSplitEntry,
  AccessorialSplitResponse,
  AccessorialSplitRow,
} from '../useInsights';
import { AnCard, AnCardHeader, Note } from './ui';

/**
 * Accessorials - who gets what (owner, 2026-10-25). Every figure is the server's: Billed is what
 * the broker is billed (the accessorials and TONU in gross), To driver what statements paid or
 * are expected to pay, To dispatcher the claim's updater payout, Company the rest. An unknown
 * figure is a dash with its reason, never 0.
 */

type Totals = AccessorialSplitResponse['totals'];

const SEGMENTS = [
  { key: 'driver', label: 'Driver', swatch: 'bg-an-split-driver' },
  { key: 'dispatcher', label: 'Dispatcher', swatch: 'bg-an-split-dispatcher' },
  { key: 'company', label: 'Company', swatch: 'bg-an-split-company' },
] as const;

const BASIS_WORD: Partial<Record<AccessorialDriverBasis, string>> = {
  statement: 'paid',
  allocation: 'expected',
  for_driver: 'expected',
  excluded: 'not paid',
};

function Money({ value, reason, strong = false }: { value: number | null; reason?: string | null; strong?: boolean }) {
  if (value === null) {
    return (
      <span className="text-nw-text-3" title={reason ?? undefined} aria-label={reason ? `Not known: ${reason}` : 'Not known'}>
        —
      </span>
    );
  }
  return (
    <span className={cn('tabular-nums', strong ? 'font-semibold text-nw-text' : 'text-nw-text', value < 0 && 'text-nw-urgent-text')}>
      {formatMoney(value)}
    </span>
  );
}

/** Driver, dispatcher and company as one thin bar; widths are shares of what was split. */
export function SplitMeter({ driver, dispatcher, company, reason }: { driver: number | null; dispatcher: number; company: number | null; reason?: string | null }) {
  if (driver === null || company === null) {
    return (
      <div
        role="img"
        aria-label={`Split not known${reason ? `: ${reason}` : ''}`}
        title={reason ?? undefined}
        className="h-2 w-full rounded-full border border-dashed border-nw-text-3/60"
        data-testid="split-unknown"
      />
    );
  }
  const parts = { driver: Math.max(0, driver), dispatcher: Math.max(0, dispatcher), company: Math.max(0, company) };
  const whole = parts.driver + parts.dispatcher + parts.company;
  const pct = (v: number) => (whole > 0 ? (v / whole) * 100 : 0);
  const label = SEGMENTS.map((s) => `${s.label} ${Math.round(pct(parts[s.key]))}%`).join(', ');
  return (
    <div role="img" aria-label={label} title={label} className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-an-track">
      {SEGMENTS.map((s) =>
        parts[s.key] > 0 ? (
          <span
            key={s.key}
            data-segment={s.key}
            className={cn('h-full first:rounded-l-full last:rounded-r-full', s.swatch)}
            style={{ width: `${pct(parts[s.key])}%` }}
          />
        ) : null,
      )}
    </div>
  );
}

function Legend() {
  return (
    <ul aria-label="Split legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-nw-text-2">
      {SEGMENTS.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className={cn('size-2.5 rounded-[3px]', s.swatch)} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function countLine(row: Pick<AccessorialSplitRow, 'loads' | 'charges' | 'claims'>) {
  const parts = [`${formatNumber(row.loads)} ${row.loads === 1 ? 'load' : 'loads'}`];
  if (row.charges !== row.loads) parts.push(`${formatNumber(row.charges)} ${row.charges === 1 ? 'charge' : 'charges'}`);
  if (row.claims > 0) parts.push(`${formatNumber(row.claims)} ${row.claims === 1 ? 'claim' : 'claims'}`);
  return parts.join(' · ');
}

function SplitRow({ label, row, total = false }: { label: ReactNode; row: AccessorialSplitRow | Totals; total?: boolean }) {
  const cell = 'h-12 px-4 text-right';
  return (
    <tr
      className={cn(
        'border-b border-an-card-border last:border-0',
        total ? 'bg-an-pill-track/60 font-semibold' : 'hover:bg-nw-hover',
      )}
    >
      <th scope="row" className="h-12 min-w-[190px] px-5 py-2 text-left font-normal">
        <span className={cn('block text-nw-text', total ? 'font-bold' : 'font-medium')}>{label}</span>
        <span className="block text-xs whitespace-nowrap text-nw-text-3">{countLine(row)}</span>
        {row.unknownDriver > 0 ? (
          <span className="mt-0.5 flex items-center gap-1 text-xs whitespace-nowrap text-nw-warning-text">
            <StatusSymbol family="warning" size={12} className="text-nw-warning-icon" />
            {row.unknownDriver === 1 ? '1 driver share not known' : `${row.unknownDriver} driver shares not known`}
          </span>
        ) : null}
      </th>
      <td className={cell}>
        <Money value={row.billed} strong />
      </td>
      <td className={cell}>
        <Money value={row.toDriver} reason={row.toDriverReason} />
      </td>
      <td className={cell}>
        <Money value={row.toDispatcher} />
      </td>
      <td className={cell}>
        <Money value={row.companyKeeps} reason={row.toDriverReason} strong />
      </td>
      <td className="h-12 w-40 pr-5 pl-3">
        <SplitMeter driver={row.toDriver} dispatcher={row.toDispatcher} company={row.companyKeeps} reason={row.toDriverReason} />
      </td>
    </tr>
  );
}

function LoadList({
  items,
  total,
  page,
  pageSize,
  onPageChange,
}: {
  items: AccessorialSplitEntry[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange?: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const th = 'h-9 px-3 text-right font-semibold';
  return (
    <div className="border-t border-an-card-border">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-sm" aria-label="Accessorial loads">
          <thead>
            <tr className="border-b border-an-card-border text-xs text-nw-text-2">
              <th scope="col" className="h-9 px-5 text-left font-semibold">Load</th>
              <th scope="col" className="h-9 px-3 text-left font-semibold">Type</th>
              <th scope="col" className={th}>Billed</th>
              <th scope="col" className={th}>Driver</th>
              <th scope="col" className={th}>Dispatcher</th>
              <th scope="col" className={th}>Company</th>
              <th scope="col" className="h-9 pr-3 pl-6 text-left font-semibold">Driver name</th>
              <th scope="col" className="h-9 pr-5 pl-3 text-left font-semibold">Dispatcher name</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={`${e.loadId}:${e.type}`} className="border-b border-an-card-border last:border-0 hover:bg-nw-hover">
                <td className="px-5 py-2">
                  <Link
                    to={e.href as never}
                    className="font-semibold text-an-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-an-accent"
                  >
                    {e.loadNumber}
                  </Link>
                  <span className="block text-xs text-nw-text-3">
                    {e.brokerReference ? `REF ${e.brokerReference} · ` : ''}
                    {e.day}
                  </span>
                </td>
                <td className="px-3 py-2 text-nw-text">{e.label}</td>
                <td className="px-3 py-2 text-right">
                  <Money value={e.billed} strong />
                </td>
                <td className="px-3 py-2 text-right">
                  <Money value={e.toDriver} reason={e.driverReason} />
                  {e.toDriver === null ? (
                    <span className="block text-xs text-nw-text-3">not known</span>
                  ) : BASIS_WORD[e.driverBasis] ? (
                    <span className="block text-xs text-nw-text-3">{BASIS_WORD[e.driverBasis]}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right">
                  <Money value={e.toDispatcher} />
                  {e.claimStatus ? <span className="block text-xs text-nw-text-3">claim {e.claimStatus}</span> : null}
                </td>
                <td className="px-3 py-2 text-right">
                  <Money value={e.companyKeeps} reason={e.driverReason} strong />
                </td>
                <td className="py-2 pr-3 pl-6 text-nw-text-2">{e.driverName ?? <span className="text-nw-text-3">—</span>}</td>
                <td className="py-2 pr-5 pl-3 text-nw-text-2">{e.dispatcherName ?? <span className="text-nw-text-3">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <div className="flex items-center justify-end gap-2 border-t border-an-card-border px-5 py-2 text-xs text-nw-text-2">
          <span className="tabular-nums">
            Page {page} of {pages} · {formatNumber(total)} lines
          </span>
          <button
            type="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPageChange?.(page - 1)}
            className="grid size-7 place-items-center rounded-full text-nw-text-2 hover:bg-nw-hover disabled:opacity-40"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Next page"
            disabled={page >= pages}
            onClick={() => onPageChange?.(page + 1)}
            className="grid size-7 place-items-center rounded-full text-nw-text-2 hover:bg-nw-hover disabled:opacity-40"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AccessorialSplitCard({
  data,
  onPageChange,
  defaultOpen = false,
}: {
  data: AccessorialSplitResponse;
  onPageChange?: (page: number) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  const empty = data.rows.length === 0;
  return (
    <AnCard className="min-w-0" data-testid="accessorial-split">
      <AnCardHeader
        title="Accessorials — who gets what"
        description="Billed to the broker, and how it splits between the driver, the dispatcher's claim and the company."
        actions={empty ? null : <Legend />}
      />
      {empty ? (
        <div className="border-t border-an-card-border px-5 py-8 text-center">
          <StatusSymbol family="info" size={18} className="mx-auto text-nw-neutral-icon" />
          <p className="mt-1 text-sm font-semibold text-nw-text-2">No detention, layover or TONU in this period</p>
          <p className="text-xs text-nw-text-3">The split appears once a delivered load carries an accessorial or a load is cancelled with a TONU.</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto border-t border-an-card-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-an-card-border text-xs text-nw-text-2">
                  <th scope="col" className="h-10 px-5 text-left font-semibold">Type</th>
                  <th scope="col" className="h-10 px-4 text-right font-semibold">Billed</th>
                  <th scope="col" className="h-10 px-4 text-right font-semibold">Driver</th>
                  <th scope="col" className="h-10 px-4 text-right font-semibold">Dispatcher</th>
                  <th scope="col" className="h-10 px-4 text-right font-semibold">Company</th>
                  <th scope="col" className="h-10 w-40 pr-5 pl-3 text-left font-semibold">Split</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <SplitRow key={row.type} label={row.label} row={row} />
                ))}
              </tbody>
              <tfoot className="border-t border-an-card-border">
                <SplitRow label="Total" row={data.totals} total />
              </tfoot>
            </table>
          </div>
          <div className="flex flex-col gap-1.5 border-t border-an-card-border px-5 py-3">
            {data.notes.map((note) => (
              <Note key={note}>{note}</Note>
            ))}
            <button
              type="button"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex w-fit items-center gap-1 rounded-full text-[12.5px] font-semibold text-an-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-an-accent"
            >
              {open ? 'Hide loads' : `Show loads · ${formatNumber(data.loads.total)}`}
              <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
            </button>
          </div>
          {open ? (
            <div id={listId}>
              <LoadList {...data.loads} onPageChange={onPageChange} />
            </div>
          ) : null}
        </>
      )}
    </AnCard>
  );
}
