import { ArrowDown, ArrowUp, MapPin } from 'lucide-react';
import type { ReactNode } from 'react';
import { FLEET_EXPENSE_CHARGE_TO_LABEL, FLEET_EXPENSE_PAYER_LABEL, FLEET_PAYMENT_METHOD_LABEL, type FleetExpenseRow } from '@neway/shared';
import { cn } from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import { CategoryLabel, FromMaintenanceBadge, LookBadge, PaymentStatusBadge, RecoveryStatusBadge } from './expense-ui';
import { cityState, money } from './expense-format';
import type { ExpenseSort } from './expenses-search';

/**
 * The expense rows, as the list, the dashboard's recent expenses and the truck tab show them.
 *
 * Essential columns stay on a phone (date, the expense, amount, payment); the rest step in as the
 * screen widens, so there is never a sideways page scroll. A repair from Maintenance is the work
 * order itself: its row opens the repair, not an expense panel, because that is where its
 * checks, invoice and history live.
 */
export function ExpensesTable({
  rows,
  onOpen,
  hideTruck = false,
  sort,
  onSort,
  compact = false,
}: {
  rows: FleetExpenseRow[];
  onOpen: (row: FleetExpenseRow) => void;
  hideTruck?: boolean;
  sort?: ExpenseSort;
  onSort?: (sort: ExpenseSort) => void;
  /** The dashboard's short list: fewer columns at every width. */
  compact?: boolean;
}) {
  const sortable = (label: string, asc: ExpenseSort, desc: ExpenseSort | null) => {
    if (!onSort) return label;
    const active = sort === asc || sort === desc;
    const next = desc === null ? asc : sort === desc ? asc : desc;
    return (
      <button type="button" onClick={() => onSort(next)} className="inline-flex items-center gap-1 uppercase hover:underline" aria-label={`Sort by ${label}`}>
        {label}
        {active ? sort === asc && desc !== null ? <ArrowUp aria-hidden className="size-3" /> : <ArrowDown aria-hidden className="size-3" /> : null}
      </button>
    );
  };
  // The compact list keeps only the essentials at every width.
  const col = (classes: string) => (compact ? 'hidden' : classes);
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="border-b border-nw-border bg-nw-accent-tint text-left text-[11px] font-bold tracking-[.06em] text-nw-accent-ink uppercase">
          <Th>{sortable('Date', 'date_asc', 'date_desc')}</Th>
          <Th>Expense</Th>
          {hideTruck ? null : <Th className="hidden md:table-cell">{sortable('Truck', 'truck', null)}</Th>}
          <Th className="hidden md:table-cell">{sortable('Category', 'category', null)}</Th>
          <Th className={col('hidden lg:table-cell')}>Vendor / location</Th>
          <Th className="text-right">{sortable('Amount', 'amount_asc', 'amount_desc')}</Th>
          <Th className={col('hidden xl:table-cell')}>Paid by</Th>
          <Th className={col('hidden xl:table-cell')}>Charge to</Th>
          <Th className="hidden sm:table-cell">Payment</Th>
          <Th className={col('hidden lg:table-cell')}>Recovery</Th>
          <Th className={col('hidden 2xl:table-cell')}>Source</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const place = r.placeName ? [r.placeName, cityState(r.city, r.state)].filter(Boolean).join(' · ') : cityState(r.city, r.state);
          return (
            <tr
              key={`${r.source}:${r.id}`}
              tabIndex={0}
              onClick={() => onOpen(r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(r);
                }
              }}
              className={cn('cursor-pointer border-b border-nw-border last:border-b-0 hover:bg-nw-hover focus-visible:bg-nw-hover focus-visible:outline-none', r.status === 'void' && 'text-nw-text-3')}
            >
              <Td className="whitespace-nowrap text-nw-text-2">{formatIsoDate(r.expenseDate)}</Td>
              <Td>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-nw-accent-ink">{r.reference}</span>
                  {r.source === 'work_order' ? <FromMaintenanceBadge /> : null}
                  {r.status === 'draft' ? <LookBadge look="neutral" size="sm">Draft</LookBadge> : null}
                  {r.status === 'void' ? <LookBadge look="neutral" size="sm">Void</LookBadge> : null}
                </span>
                {/* On a phone the hidden columns fold into this line. */}
                <span className="block text-xs text-nw-text-3 md:hidden">
                  {hideTruck ? '' : `${r.unitNumber ? `Unit ${r.unitNumber}` : 'No truck'} · `}
                  {r.categoryLabel}
                  {place ? ` · ${place}` : ''}
                </span>
                {r.description ? <span className="hidden max-w-72 truncate text-xs text-nw-text-3 md:block">{r.description}</span> : null}
              </Td>
              {hideTruck ? null : <Td className="hidden font-semibold whitespace-nowrap text-nw-text md:table-cell">{r.unitNumber || 'No truck'}</Td>}
              <Td className="hidden md:table-cell">
                <CategoryLabel category={r.category} label={r.categoryLabel} />
              </Td>
              <Td className={col('hidden lg:table-cell')}>
                <span className="block max-w-56 truncate text-nw-text">{r.vendorName ?? r.placeName ?? '—'}</span>
                {r.placeName && r.vendorName ? <span className="block max-w-56 truncate text-xs text-nw-text-3">{r.placeName}</span> : null}
                {cityState(r.city, r.state) ? (
                  <span className="flex items-center gap-1 text-xs text-nw-text-3">
                    <MapPin aria-hidden className="size-3" />
                    {cityState(r.city, r.state)}
                  </span>
                ) : null}
              </Td>
              <Td className="tabular text-right font-bold whitespace-nowrap text-nw-text">{money(r.amountCents)}</Td>
              <Td className={col('hidden xl:table-cell')}>
                <span className="block">{FLEET_EXPENSE_PAYER_LABEL[r.paidBy]}</span>
                {r.paymentMethod ? <span className="block text-xs text-nw-text-3">{FLEET_PAYMENT_METHOD_LABEL[r.paymentMethod]}{r.efsMasked ? ` ${r.efsMasked}` : ''}</span> : null}
              </Td>
              <Td className={col('hidden xl:table-cell')}>
                <span className="block">{FLEET_EXPENSE_CHARGE_TO_LABEL[r.chargeTo]}</span>
                {r.chargeDriverName ? <span className="block text-xs text-nw-text-3">{r.chargeDriverName}{r.chargeCents !== null && r.chargeCents !== r.amountCents ? ` · ${money(r.chargeCents)}` : ''}</span> : null}
              </Td>
              <Td className="hidden sm:table-cell">
                <PaymentStatusBadge status={r.paymentStatus} />
              </Td>
              <Td className={col('hidden lg:table-cell')}>
                <RecoveryStatusBadge status={r.recoveryStatus} />
              </Td>
              <Td className={col('hidden 2xl:table-cell text-nw-text-2')}>{r.source === 'work_order' ? 'Maintenance' : 'Manual'}</Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return <th className={cn('h-[36px] px-3 align-middle font-bold whitespace-nowrap', className)}>{children}</th>;
}

function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn('h-[48px] px-3 py-2 align-middle', className)}>{children}</td>;
}
