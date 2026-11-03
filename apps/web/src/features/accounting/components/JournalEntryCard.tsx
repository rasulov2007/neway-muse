import type { JournalEntry } from '@neway/shared';
import { Card } from '@/design-system';
import { formatIsoDate, formatMoney } from '@/lib/format';

/**
 * One journal entry with its debits and credits.
 *
 * The totals row is not decoration: showing debit and credit equal, side by side, is the proof that
 * the entry balances. A financial screen that asserts correctness without showing it is asking to
 * be believed rather than checked.
 */
export function JournalEntryCard({ entry }: { entry: JournalEntry }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink">{entry.memo}</span>
        <span className="text-xs text-muted">
          {formatIsoDate(entry.onDate)} · {entry.id} · {entry.source.replace(/_/g, ' ')}
        </span>
      </div>
      <table className="mt-2 w-full text-sm">
        <thead className="text-xs font-semibold text-secondary">
          <tr>
            <th className="py-1 text-left font-medium">Account</th>
            <th className="py-1 text-right font-medium">Debit</th>
            <th className="py-1 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((line, index) => (
            <tr key={`${line.accountCode}-${index}`} className="border-t border-line-soft">
              <td className="py-1">
                <span className="font-mono text-xs text-faint">{line.accountCode}</span>{' '}
                <span className="text-secondary">{line.memo}</span>
              </td>
              <td className="py-1 text-right tabular-nums">
                {line.debit > 0 ? formatMoney(line.debit / 100) : ''}
              </td>
              <td className="py-1 text-right tabular-nums">
                {line.credit > 0 ? formatMoney(line.credit / 100) : ''}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-line-strong font-semibold">
            <td className="py-1 text-muted">Balanced</td>
            <td className="py-1 text-right tabular-nums">{formatMoney(entry.totalCents / 100)}</td>
            <td className="py-1 text-right tabular-nums">{formatMoney(entry.totalCents / 100)}</td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}
