import { Modal } from '@/design-system';
import { formatDateTime } from '@/lib/format';
import { useBoardHistory } from './api';

const COLUMN_WORD: Record<string, string> = {
  status: 'Status',
  load_number: 'Load #',
  truck: 'Truck #',
  trailer: 'Trailer #',
  phone: 'Phone',
  eta: 'ETA',
  route: 'Route',
  miles: 'Miles',
  notes: 'Note',
  amount: 'Amount',
  wk_miles: 'Miles',
  wk_load: 'Load #',
  wk_comment: 'Comment',
};

/** Edit history — NAME, newest first, up to 30 entries: who changed what, from what, to what. */
export function HistoryPopup({
  driverId,
  driverName,
  onClose,
}: {
  driverId: string;
  driverName: string;
  onClose: () => void;
}) {
  const history = useBoardHistory(driverId);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      title={`Edit history — ${driverName}`}
    >
      {history.isPending ? (
        <p className="py-6 text-center text-sm text-nw-text-3">Loading…</p>
      ) : (history.data ?? []).length === 0 ? (
        <p className="py-6 text-center text-sm text-nw-text-3">Nothing typed on this row yet.</p>
      ) : (
        <ul className="divide-y divide-nw-border">
          {(history.data ?? []).map((e) => (
            <li key={e.id} className="flex flex-col gap-0.5 py-2 text-[12.5px]">
              <span className="flex items-center gap-2">
                <span className="font-semibold text-nw-text">
                  {COLUMN_WORD[e.column] ?? e.column}
                </span>
                <span className="text-xs text-nw-text-3">{e.day}</span>
                <span className="ml-auto text-xs text-nw-text-3">
                  {e.byName} · {formatDateTime(e.at)}
                  {e.source !== 'user' ? ' · AI' : ''}
                </span>
              </span>
              <span className="text-nw-text-2">
                {e.oldValue !== null ? (
                  <s className="text-nw-text-3">{e.oldValue}</s>
                ) : (
                  <i className="text-nw-text-3">empty</i>
                )}
                {' → '}
                {e.newValue !== null ? e.newValue : <i className="text-nw-text-3">cleared</i>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
