/**
 * Presentation and routing for a notification's event kind and its related TMS object.
 *
 * Two separate concerns live here on purpose:
 *  - `KINDS` describes the event (icon, label, tint) — what happened.
 *  - `entityTarget()` resolves the object the event points at to a real route — what to open.
 *
 * Every href below is an existing route. An entity type with no page yet resolves to `null`, and
 * the row then renders the object as plain text rather than a link that goes nowhere.
 */
import type { EntityRef, EntityType, NotificationKind, Severity } from '@/demo';
import {
  Boxes,
  CircleCheck,
  FileText,
  Info,
  MessageSquare,
  OctagonAlert,
  Receipt,
  Route,
  Settings,
  TrendingUp,
  Truck,
  User,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { BadgeTone } from '@/design-system';
import { hrefs } from '@/features/dashboard/links';

export interface KindDefinition {
  label: string;
  icon: LucideIcon;
  /** Tint for the leading icon tile. Neutral by default so severity keeps the colour budget. */
  tile: string;
}

export const KINDS: Record<NotificationKind, KindDefinition> = {
  load: { label: 'Load', icon: Boxes, tile: 'bg-primary-soft text-primary-text' },
  dispatch: { label: 'Dispatch', icon: Route, tile: 'bg-primary-soft text-primary-text' },
  fleet: { label: 'Fleet', icon: Truck, tile: 'bg-violet-soft text-violet-text' },
  maintenance: { label: 'Maintenance', icon: Wrench, tile: 'bg-violet-soft text-violet-text' },
  driver: { label: 'Driver', icon: User, tile: 'bg-neutral-soft text-neutral-text' },
  finance: { label: 'Finance', icon: Receipt, tile: 'bg-success-soft text-success-text' },
  document: { label: 'Document', icon: FileText, tile: 'bg-warning-soft text-warning-text' },
  system: { label: 'System', icon: Settings, tile: 'bg-neutral-soft text-neutral-text' },
  comment: { label: 'Comment', icon: MessageSquare, tile: 'bg-neutral-soft text-neutral-text' },
  report: { label: 'Report', icon: TrendingUp, tile: 'bg-info-soft text-info-text' },
};

/** Kind order for the Type filter, so the dropdown reads operationally rather than alphabetically. */
export const KIND_ORDER: readonly NotificationKind[] = [
  'dispatch',
  'load',
  'fleet',
  'maintenance',
  'driver',
  'finance',
  'document',
  'report',
  'comment',
  'system',
];

export interface SeverityDefinition {
  label: string;
  tone: BadgeTone;
  icon: LucideIcon;
}

/** Priority badges. Soft badge variants only: no saturated fills in a dense operational list. */
export const SEVERITIES: Record<Severity, SeverityDefinition> = {
  critical: { label: 'Critical', tone: 'danger', icon: OctagonAlert },
  warning: { label: 'Warning', tone: 'warning', icon: Info },
  info: { label: 'Info', tone: 'info', icon: Info },
  success: { label: 'Success', tone: 'success', icon: CircleCheck },
};

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'warning', 'info', 'success'];

export interface EntityTarget {
  /** "Load", "Unit", "Driver" — the object type, shown above the identifier. */
  typeLabel: string;
  /** The identifier itself, e.g. "L-100245" or "Unit 3091". */
  label: string;
  /** Existing route, or null when this entity type has no page yet. */
  href: string | null;
  /** Button copy for the row's primary action, e.g. "Open load". */
  action: string;
}

const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  load: 'Load',
  truck: 'Unit',
  trailer: 'Trailer',
  driver: 'Driver',
  invoice: 'Invoice',
  repair_order: 'Repair order',
  maintenance: 'Maintenance',
  fuel_transaction: 'Fuel',
  safety_event: 'Safety event',
  customer: 'Customer',
  broker: 'Broker',
  employee: 'Employee',
  applicant: 'Candidate',
  hiring_safety: 'Hiring decision',
  company: 'Company',
};

/** `Unit 3091` → `3091`, so the trucks route gets the unit number its search param expects. */
function unitNumber(label: string): string {
  return label.replace(/^unit\s+/i, '').trim();
}

/**
 * Resolves the route for a notification's related object. `kind` refines the destination where
 * the entity alone is ambiguous: a maintenance event on a truck opens the maintenance list, a
 * document event on a driver opens driver compliance, and a fleet event opens the unit itself.
 */
export function entityTarget(
  entity: EntityRef | null,
  kind: NotificationKind,
): EntityTarget | null {
  if (!entity) return null;
  const typeLabel = ENTITY_TYPE_LABELS[entity.type];
  const base = { typeLabel, label: entity.label };

  switch (entity.type) {
    case 'load':
      return { ...base, href: hrefs.load(entity.label), action: 'Open load' };
    case 'truck':
      if (kind === 'maintenance')
        return { ...base, href: hrefs.maintenance, action: 'Open maintenance' };
      return { ...base, href: hrefs.truck(unitNumber(entity.label)), action: 'Open unit' };
    case 'trailer':
      if (kind === 'maintenance')
        return { ...base, href: hrefs.maintenance, action: 'Open maintenance' };
      return { ...base, href: '/fleet/trailers', action: 'Open trailer' };
    case 'driver':
      if (kind === 'document')
        return { ...base, href: '/safety/compliance', action: 'Open compliance' };
      return { ...base, href: hrefs.drivers, action: 'Open driver' };
    case 'invoice':
      return { ...base, href: '/accounting/invoices', action: 'Open invoice' };
    case 'fuel_transaction':
      return { ...base, href: hrefs.fuel, action: 'Open fuel' };
    case 'safety_event':
      return { ...base, href: hrefs.safety, action: 'Open safety' };
    case 'repair_order':
    case 'maintenance':
      return { ...base, href: hrefs.maintenance, action: 'Open maintenance' };
    case 'customer':
      return { ...base, href: '/customers', action: 'Open customer' };
    case 'broker':
      return { ...base, href: '/brokers', action: 'Open broker' };
    case 'employee':
      return { ...base, href: '/hr/employees', action: 'Open employee' };
    case 'applicant':
      return { ...base, href: `/hr/recruiting/${encodeURIComponent(entity.id)}`, action: 'Open candidate' };
    case 'hiring_safety':
      return { ...base, href: `/safety/hiring?case=${encodeURIComponent(entity.id)}`, action: 'Open hiring decision' };
    case 'company':
    default:
      // The company itself has no detail page; the object is shown, but not as a link.
      return { ...base, href: null, action: '' };
  }
}

/**
 * Some events have no entity but still have an obvious destination — a settlement batch belongs
 * in accounting, a platform notice in integrations. Used only when `entity` is null, so it never
 * overrides a real object reference.
 */
export function fallbackTarget(kind: NotificationKind): { href: string; action: string } | null {
  switch (kind) {
    case 'finance':
      return { href: hrefs.settlements, action: 'Open settlements' };
    case 'system':
      return { href: '/admin/integrations', action: 'Open integrations' };
    case 'report':
      return { href: hrefs.reports, action: 'Open reports' };
    case 'document':
      return { href: '/safety/compliance', action: 'Open compliance' };
    default:
      return null;
  }
}
