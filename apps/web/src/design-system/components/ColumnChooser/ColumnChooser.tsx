import { Columns3 } from 'lucide-react';
import { Button, type ButtonSize } from '../Button';
import {
  DropdownMenu,
  MenuCheckboxItem,
  MenuItem,
  MenuLabel,
  MenuSeparator,
} from '../DropdownMenu';

export interface ColumnChooserColumn {
  id: string;
  label: string;
  visible: boolean;
  /** Columns that cannot be hidden render disabled. Defaults to `true`. */
  canHide?: boolean;
}

export interface ColumnChooserProps {
  columns: ColumnChooserColumn[];
  onToggle: (id: string, visible: boolean) => void;
  /** Adds a "Show all columns" item. */
  onReset?: () => void;
  label?: string;
  size?: ButtonSize;
  className?: string;
}

/** Dropdown of column checkboxes. Stays open while toggling so several columns can be changed at once. */
export function ColumnChooser({
  columns,
  onToggle,
  onReset,
  label = 'Columns',
  size = 'sm',
  className,
}: ColumnChooserProps) {
  const hiddenCount = columns.filter((column) => !column.visible).length;
  return (
    <DropdownMenu
      trigger={
        <Button size={size} variant="secondary" icon={<Columns3 />} className={className}>
          {label}
          {hiddenCount > 0 ? (
            <span className="tabular text-nw-text-3">({hiddenCount} hidden)</span>
          ) : null}
        </Button>
      }
    >
      <MenuLabel>Columns</MenuLabel>
      {columns.map((column) => (
        <MenuCheckboxItem
          key={column.id}
          checked={column.visible}
          disabled={column.canHide === false}
          onCheckedChange={(checked) => onToggle(column.id, checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          {column.label}
        </MenuCheckboxItem>
      ))}
      {onReset ? (
        <>
          <MenuSeparator />
          <MenuItem disabled={hiddenCount === 0} onSelect={onReset}>
            Show all columns
          </MenuItem>
        </>
      ) : null}
    </DropdownMenu>
  );
}
