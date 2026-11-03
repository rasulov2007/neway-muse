import { PaintBucket } from 'lucide-react';
import { Button, DropdownMenu, MenuItem, cn } from '@/design-system';
import { TINT_CLASS, TINT_LABEL } from './sheet';

/** The ten Sheets tints, applied to the selected cell or range. Stored on the server. */
export function FillPalette({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (tint: number) => void;
}) {
  return (
    <DropdownMenu
      trigger={
        <Button variant="secondary" size="sm" icon={<PaintBucket />} disabled={disabled}>
          Fill
        </Button>
      }
    >
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((tint) => (
        <MenuItem key={tint} onSelect={() => onPick(tint)}>
          <span
            aria-hidden
            className={cn(
              'mr-2 inline-block size-3.5 rounded-sm border border-nw-border',
              TINT_CLASS[tint] ?? 'bg-nw-panel',
            )}
          />
          {TINT_LABEL[tint]}
        </MenuItem>
      ))}
    </DropdownMenu>
  );
}
