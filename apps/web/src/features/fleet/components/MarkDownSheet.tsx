import { useMutation } from '@tanstack/react-query';
import {
  Ban,
  CircleAlert,
  CircleDot,
  Disc,
  DoorOpen,
  Home,
  Info,
  Lightbulb,
  Link2,
  Route,
  Store,
  Thermometer,
  TriangleAlert,
  Truck as TruckIcon,
  Wind,
  Zap,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Combobox,
  DatePicker,
  Drawer,
  FormField,
  Select,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import {
  DOWN_HOLD_LABEL,
  DOWN_PLACE_LABEL,
  DOWN_SYSTEMS,
  markDown,
  type DownHold,
  type DownPlace,
  type DownSystem,
} from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { formatNumber } from '@/lib/format';
import { useInvalidateFleet } from '../useFleet';

/** A unit the sheet can mark down, reduced to what it actually needs to know. */
export interface MarkDownUnit {
  id: string;
  unitNumber: string;
  unitType: 'truck' | 'trailer';
  description: string;
  driverName: string | null;
  odometer: number | null;
  location: string | null;
  /** A finding the sheet was opened from, so it links itself rather than being retyped. */
  issue?: { id: string; label: string } | null;
  /** The load the unit is on or about to take, so Dispatch is warned before it is a problem. */
  nextLoad?: { number: string; when: string } | null;
}

/** The system chips, in the order the mockup puts them. One tap is the whole answer. */
const SYSTEM_ICON: Record<DownSystem, ReactNode> = {
  Brakes: <Disc />,
  'Tires & wheels': <CircleDot />,
  Lights: <Lightbulb />,
  'Air & leaks': <Wind />,
  'Engine & warning light': <CircleAlert />,
  Electrical: <Zap />,
  Cooling: <Thermometer />,
  'Body & doors': <DoorOpen />,
  Coupling: <Link2 />,
  Other: <Ban />,
};

const PLACE_ICON: Record<DownPlace, ReactNode> = {
  shop: <Store />,
  yard: <Home />,
  road: <Route />,
};

/**
 * Mark a truck down.
 *
 * About ten seconds, and deliberately not a form. The person using it is standing next to a
 * problem, not next to a record: they tap a system, type a few words and say where the unit is.
 * Everything else — the time, their name, the odometer, the driver, the load that is now at risk —
 * is filled in, because a field that has to be looked up is a field that ends up empty.
 *
 * Nothing here is an approval step. The repair is recorded later, from the invoice
 * (Fleet specification §5.1; mockup C1 in the proposal).
 */
export function MarkDownSheet({
  unit,
  open,
  onOpenChange,
  onDone,
  choices,
}: {
  unit: MarkDownUnit | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
  /** Offered when the sheet is opened from the page header rather than from a unit's own row. */
  choices?: MarkDownUnit[];
}) {
  const { toast } = useToast();
  const account = useAccount();
  const invalidate = useInvalidateFleet();

  const [system, setSystem] = useState<DownSystem | null>(null);
  const [note, setNote] = useState('');
  const [place, setPlace] = useState<DownPlace>('road');
  const [placeName, setPlaceName] = useState('');
  const [expectedBack, setExpectedBack] = useState<Date | null>(null);
  const [hold, setHold] = useState<DownHold | ''>('');
  const [linked, setLinked] = useState(true);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Opened from a row, the unit is a fact. Opened from the header, it is the first question.
  const target = unit ?? (choices ?? []).find((c) => c.id === pickedId) ?? null;

  const save = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error('Pick the unit that is down');
      return markDown({
        unitId: target.id,
        unitNumber: target.unitNumber,
        unitType: target.unitType,
        system,
        note,
        place,
        placeName,
        expectedBack: expectedBack ? expectedBack.toISOString().slice(0, 10) : null,
        hold: hold === '' ? null : hold,
        markedByName: account?.name ?? 'Unknown',
        odometer: target.odometer,
        driverName: target.driverName,
        issueIds: linked && target.issue ? [target.issue.id] : [],
      });
    },
    onSuccess: async (period) => {
      await invalidate();
      toast({
        tone: 'success',
        title: `${period.unitNumber} is down`,
        description: `${period.number} · downtime is counting from now.`,
      });
      reset();
      onOpenChange(false);
      onDone?.();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'That could not be recorded'),
  });

  function reset() {
    setSystem(null);
    setNote('');
    setPlace('road');
    setPlaceName('');
    setExpectedBack(null);
    setHold('');
    setLinked(true);
    setPickedId(null);
    setError(null);
  }

  // The five required words: a system and where it is. Everything else can follow later.
  const valid = target !== null && system !== null && note.trim() !== '';

  const placeHint = useMemo<Record<DownPlace, string>>(
    () => ({
      shop: placeName || 'pick the shop',
      yard: 'home yard',
      road: target?.location ?? 'last known position',
    }),
    [placeName, target],
  );

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      size="lg"
      title="Mark a truck down"
      description="About 10 seconds. The repair is recorded later, from the invoice."
      footer={
        <>
          <span className="mr-auto text-xs text-muted">Nothing else is required now</span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            icon={<TriangleAlert />}
            loading={save.isPending}
            disabled={!valid}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            Mark down
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}

        {/* The unit, as a fact rather than a picker: the sheet was opened from it. */}
        <section>
          <SheetLabel>Unit</SheetLabel>
          {unit === null && choices && choices.length > 0 ? (
            <Combobox
              aria-label="Unit"
              className="mb-2"
              options={choices.map((c) => ({
                value: c.id,
                label: c.unitNumber,
                description: c.description,
              }))}
              value={pickedId}
              onValueChange={setPickedId}
              placeholder="Search units…"
            />
          ) : null}
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-subtle px-3 py-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-text">
              <TruckIcon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">
                {target ? `${target.unitNumber} · ${target.description}` : 'Pick the unit that is down'}
              </span>
              <span className="block truncate text-xs text-secondary">
                {[
                  target?.driverName,
                  target?.location,
                  target?.odometer ? `${formatNumber(target.odometer)} mi` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'No driver or position on file'}
              </span>
            </span>
          </div>
        </section>

        {/* Why it is down: a system and a few words. The system is what makes repeats findable. */}
        <section>
          <SheetLabel hint="pick a system · a few words help">
            Why is it down? <span className="text-danger-text">*</span>
          </SheetLabel>
          <div className="grid grid-cols-5 gap-1.5">
            {DOWN_SYSTEMS.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={system === name}
                onClick={() => setSystem(system === name ? null : name)}
                className={cn(
                  'flex h-[52px] flex-col items-center justify-center gap-1 rounded-lg px-1 text-center text-[11px] leading-tight font-medium',
                  system === name
                    ? 'bg-primary-soft text-primary-text ring-2 ring-primary'
                    : 'bg-surface text-secondary ring-1 ring-line-strong',
                )}
              >
                <span className="[&>svg]:size-4" aria-hidden>
                  {SYSTEM_ICON[name]}
                </span>
                {name}
              </button>
            ))}
          </div>
          <Textarea
            className="mt-2"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Slack adjuster out of stroke, axle 3 left"
            aria-label="What is wrong"
          />
          {target?.issue ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-secondary">
              <Link2 className="size-3.5 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {linked ? `Linked to ${target.issue.label}` : `Not linked to ${target.issue.label}`}
              </span>
              <Button variant="link" size="sm" onClick={() => setLinked(!linked)}>
                {linked ? 'Unlink' : 'Link'}
              </Button>
            </p>
          ) : null}
        </section>

        {/* Where it is, because "down" without a place cannot be chased. */}
        <section>
          <SheetLabel hint="suggested from the last position">
            Where is it? <span className="text-danger-text">*</span>
          </SheetLabel>
          <div className="grid grid-cols-3 gap-1.5">
            {(['shop', 'yard', 'road'] as DownPlace[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={place === key}
                onClick={() => setPlace(key)}
                className={cn(
                  'grid gap-0.5 rounded-lg px-3 py-2 text-left',
                  place === key
                    ? 'bg-primary-soft ring-2 ring-primary'
                    : 'bg-surface ring-1 ring-line-strong',
                )}
              >
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-[13px] font-semibold [&>svg]:size-4',
                    place === key ? 'text-primary-text' : 'text-ink',
                  )}
                >
                  {PLACE_ICON[key]}
                  {DOWN_PLACE_LABEL[key]}
                </span>
                <span className="truncate text-[11px] text-muted">{placeHint[key]}</span>
              </button>
            ))}
          </div>
          {place === 'shop' ? (
            <Textarea
              className="mt-2"
              rows={1}
              value={placeName}
              onChange={(event) => setPlaceName(event.target.value)}
              placeholder="Midwest Diesel Repair"
              aria-label="Which shop"
            />
          ) : null}
        </section>

        {/* Both optional, and they stay optional: the shop often has not said yet. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Expected back" description="Optional. Add it when the shop says.">
            <DatePicker value={expectedBack} onChange={(d) => setExpectedBack(d ?? null)} />
          </FormField>
          <FormField label="Holding it" description="Optional.">
            <Select
              aria-label="Holding it"
              value={hold}
              onValueChange={(value) => setHold(value as DownHold | '')}
              placeholder="Skip for now"
              options={[
                { value: '', label: 'Skip for now' },
                ...Object.entries(DOWN_HOLD_LABEL).map(([value, label]) => ({ value, label })),
              ]}
            />
          </FormField>
        </div>

        {/*
         * What pressing the button does, before it is pressed.
         *
         * The consequences are the reason anybody marks a truck down at all, so they are shown
         * rather than discovered: the unit leaves dispatch, the clock starts, and the load nobody
         * had thought about yet is raised while there is still time to move it.
         */}
        <section className="overflow-hidden rounded-lg border border-line bg-surface-subtle">
          <header className="flex items-center justify-between border-b border-line px-3 py-2 text-[11px] font-bold tracking-wider text-muted uppercase">
            <span>When you press Mark down</span>
            <span>Automatic</span>
          </header>
          <Consequence tone="danger" icon={<TriangleAlert />}>
            <b>
              {target?.unitNumber ?? 'The unit'} shows Down on Trucks, Dispatch and Today from now,
              and downtime starts counting.
            </b>
            <small>
              Filled in: {account?.name ?? 'you'}
              {target?.odometer ? ` · ${formatNumber(target.odometer)} mi` : ''}
              {target?.location ? ` · ${target.location}` : ''}
              {target?.driverName ? ` · ${target.driverName}` : ''}
            </small>
          </Consequence>
          {target?.nextLoad ? (
            <Consequence tone="warning" icon={<TriangleAlert />}>
              <b>
                Load {target.nextLoad.number} {target.nextLoad.when}.
              </b>
              <small>Dispatch is asked to swap the truck or move the load.</small>
            </Consequence>
          ) : null}
          <Consequence tone="muted" icon={<Info />}>
            <b>The finding stays open until a recorded repair fixes it.</b>
            <small>
              When the truck is back, Record repair finds this down period and fills in its dates.
            </small>
          </Consequence>
        </section>
      </div>
    </Drawer>
  );
}

function SheetLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2 text-xs font-semibold text-secondary">
      <span>{children}</span>
      {hint ? <span className="font-medium text-muted">{hint}</span> : null}
    </div>
  );
}

function Consequence({
  tone,
  icon,
  children,
}: {
  tone: 'danger' | 'warning' | 'muted';
  icon: ReactNode;
  children: ReactNode;
}) {
  const colour =
    tone === 'danger' ? 'text-danger-text' : tone === 'warning' ? 'text-warning-text' : 'text-muted';
  return (
    <div className="grid grid-cols-[16px_1fr] gap-2.5 border-t border-line px-3 py-2 first-of-type:border-t-0">
      <span className={cn('mt-0.5 [&>svg]:size-4', colour)} aria-hidden>
        {icon}
      </span>
      <p className="text-xs leading-relaxed text-ink [&>small]:mt-0.5 [&>small]:block [&>small]:text-muted">
        {children}
      </p>
    </div>
  );
}
