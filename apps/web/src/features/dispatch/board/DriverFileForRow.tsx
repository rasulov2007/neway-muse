import { useQueryClient } from '@tanstack/react-query';
import { Modal, StatusSymbol, cn, useToast } from '@/design-system';
import { DriverForm, type DriverFormPrefill } from '@/features/operations/DriverFormPage';
import { useHasPermission } from '@/features/operations/usePermissions';
import { boardKeys } from './api';

/**
 * A board row without a driver file (owner, 2026-10-26).
 *
 * The board's quick "Create new driver" adds a row and nothing else, and a load can only be
 * assigned to a driver file - so the board showed drivers nobody could give a load. The row says
 * so, and offers the Drivers module's own Add driver form, prefilled with what the row knows.
 * Everything else (email, CDL, home, pay) is typed by a person; nothing is invented.
 */

/** The board row facts the form starts from. */
export interface BoardRowForFile {
  /** The board (roster) row id. */
  id: string;
  name: string;
  phone: string;
  dispatcherId: string;
}

/** "XAVIER SUTTON" -> "Xavier Sutton"; the board shows names in capitals. */
function titleCase(word: string): string {
  return word
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * The board name split into first and last (the co-driver after "//" is not this driver), and the
 * first phone number with the junk a sheet paste leaves (a leading backtick, quotes) taken off.
 */
export function prefillFromBoardRow(row: BoardRowForFile): DriverFormPrefill {
  const own = (row.name.split('//')[0] ?? row.name).trim().replace(/\s+/g, ' ');
  const words = own ? own.split(' ') : [];
  const first = words.length > 1 ? words.slice(0, -1).join(' ') : (words[0] ?? '');
  const last = words.length > 1 ? words[words.length - 1]! : '';
  const firstPhone = (row.phone.split(/\s*(?:\/\/?|,|;)\s*/)[0] ?? '').replace(/[^\d+().\s-]/g, '').trim();
  return {
    firstName: titleCase(first),
    lastName: titleCase(last),
    phone: firstPhone,
    dispatcherId: row.dispatcherId || undefined,
    boardRowId: row.id,
  };
}

/** Whether the signed-in person may make a driver file (the Drivers page's Add driver). */
export function useCanCreateDriverFile(): boolean {
  return useHasPermission('drivers.edit');
}

/** The mark beside a board name: warning shape + word, and the action for those who may use it. */
export function NoDriverFileMark({ onCreate }: { onCreate?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-flex h-4 items-center gap-0.5 rounded bg-nw-warning-bg px-1 text-[9.5px] font-extrabold tracking-wide text-nw-warning-text uppercase"
        title="This board row has no driver file. Loads can only be assigned to a driver file."
      >
        <StatusSymbol family="warning" size={10} className="text-nw-warning-icon" />
        No driver file
      </span>
      {onCreate ? (
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onCreate();
          }}
          className={cn('rounded px-1 text-[11px] font-bold text-nw-accent-ink hover:underline')}
        >
          Create driver file
        </button>
      ) : null}
    </span>
  );
}

/** The Drivers module's Add driver form over the board, for one board row. */
export function CreateDriverFileDialog({ row, onClose }: { row: BoardRowForFile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="lg"
      title="Create driver file"
      description={`${row.name} is on the board without a driver file, so no load can be assigned. The file is linked to this board row when it is saved.`}
    >
      <DriverForm
        prefill={prefillFromBoardRow(row)}
        onCancel={onClose}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: boardKeys.all });
          toast({ tone: 'success', title: `${row.name} is linked to the new driver file`, description: 'Loads can be assigned once Safety clears the driver.' });
          onClose();
        }}
      />
    </Modal>
  );
}
