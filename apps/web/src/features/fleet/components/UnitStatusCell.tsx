import { useState } from 'react';
import { Ban, ChevronDown, Pencil, RotateCcw } from 'lucide-react';
import { actionsFor } from '@neway/shared';
import { Badge, DropdownMenu, MenuItem, cn, type BadgeTone } from '@/design-system';
import { useInShopIssues } from './in-shop-issues';
import { unitStatusLook } from './unit-status-look';
import { UnitExitDialog } from './UnitExitDialog';
import { UnitStatusDialog } from './UnitStatusDialog';

/**
 * A unit's status in a list: the word, why it is off the road when it is, and a menu that changes
 * it. The menu offers only what the lifecycle table allows from the unit's stored status, and the
 * change goes through the same dialog as the unit page — so taking a unit off the road still asks
 * for the account. Clicks stay inside the cell so the row does not open behind the menu.
 */
export function UnitStatusCell({
  entity,
  id,
  unitNumber,
  status,
  tone,
  label,
  title,
}: {
  entity: 'truck' | 'trailer';
  id: string;
  unitNumber: string;
  /** The unit's stored status, which decides the actions. */
  status: string;
  tone: BadgeTone;
  label: string;
  title?: string;
}) {
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const look = unitStatusLook(id, status, label, tone);
  // In the shop: what for, from its open work order (owner, 2026-10-19), as Inactive says why.
  const inShop = label === 'In maintenance';
  const issue = useInShopIssues(inShop).get(id) ?? null;
  const shownTone = look.tone;
  const text = inShop && issue && !look.exit ? `${look.text} · ${issue.short}` : look.text;
  const fullTitle = [title, look.detail, inShop ? (issue?.detail ?? 'No open work order') : null].filter(Boolean).join('. ');
  // Off the road with an account on file, the badge edits that account (owner, 2026-10-10): the
  // same questions as taking it off the road, filled in, so the missing details get added. Bringing
  // the unit back stays on the unit page's menu, not one click away in a list.
  const exit = look.exit && !look.exit.redacted ? look.exit : null;
  const actions = exit
    ? []
    : actionsFor(entity, status).filter(
        (action) => action.kind === 'status' && !action.key.startsWith('reactivate'),
      );
  const menu = exit !== null || actions.length > 0;

  const badge = (
    <Badge
      dot
      tone={shownTone}
      title={fullTitle || undefined}
      // One width for every status, so the column reads as a column (owner, 2026-10-10).
      className={cn(inShop && issue && !look.exit ? 'w-[236px]' : 'w-[168px]', 'justify-start')}
    >
      <span className="min-w-0 flex-1 truncate text-left">{text}</span>
      {menu ? <ChevronDown className="-mr-0.5 size-3 shrink-0 opacity-70" aria-hidden /> : null}
    </Badge>
  );

  if (!menu) return badge;
  return (
    <span
      className="inline-flex"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <DropdownMenu
        align="start"
        trigger={
          <button
            type="button"
            aria-label={`Change status of ${unitNumber}: ${text}`}
            className="cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {badge}
          </button>
        }
      >
        {exit ? (
          <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
            Edit
          </MenuItem>
        ) : null}
        {actions.map((action) => (
          <MenuItem
            key={action.key}
            icon={action.destructive ? <Ban /> : <RotateCcw />}
            destructive={action.destructive}
            onSelect={() => setActionKey(action.key)}
          >
            {action.label}
          </MenuItem>
        ))}
      </DropdownMenu>
      {editing && exit ? (
        <UnitExitDialog
          entity={entity}
          unitId={id}
          unitNumber={exit.unitNumber}
          toStatus={exit.toStatus}
          actionLabel="Edit"
          existing={exit}
          onClose={() => setEditing(false)}
        />
      ) : null}
      {actionKey ? (
        <UnitStatusDialog
          entity={entity}
          id={id}
          status={status}
          label={`${entity === 'truck' ? 'Unit' : 'Trailer'} ${unitNumber}`}
          actionKey={actionKey}
          onOpenChange={(open) => {
            if (!open) setActionKey(null);
          }}
        />
      ) : null}
    </span>
  );
}
