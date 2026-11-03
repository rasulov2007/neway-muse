import { getStatus } from '@/design-system/status';
import { DispatcherSelect } from '@/features/people/DispatcherSelect';
import { useDispatchers } from '@/features/people/useDispatchers';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Info, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller } from 'react-hook-form';
import {
  formatInstant,
  instantFromLocal,
  routeLine,
  localParts,
  resolveStopZone,
  stopHandlingOf,
  zoneAbbreviation,
  type DriverLastDrop,
  type RateConfirmationExtract,
  type StopHandling,
} from '@neway/shared';
import {
  createLoad,
  loadNextLoadNumber,
  peekNextLoadNumber,
  updateLoad,
  type Load,
  demoCurrentUser,
  listBrokers,
  listDrivers,
  listTrailers,
  listTrucks,
} from '@/demo';
import {
  BackButton,
  Button,
  Checkbox,
  Combobox,
  ConfirmDialog,
  ControlledField,
  cn,
  Form,
  FormField,
  FormActions,
  IconButton,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
  useZodForm,
} from '@/design-system';
import { deadheadMilesFor, ensureUsPlaces, loadedMilesFor, uploadLoadDocument } from '@/demo';
import { FileDropzone } from '@/features/fleet/components/FileDropzone';
import { hashFile, uploadFile } from '@/lib/files';
import { assertDispatchAllowed, isDispatchBlocked, type DispatchBlockedError } from '@/demo/dispatch-guard';
import { isStopEventsLoss, type StopEventsLossError } from '@/demo/route-guard';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api-client';
import { useAccount } from '@/features/auth/auth-context';
import { DispatchOverrideDialog } from '@/features/fleet/pti/DispatchOverrideDialog';
import { formatMoney } from '@/lib/format';
import { QuickCreateBrokerDialog } from './QuickCreateBrokerDialog';
import { canReadRc, rcToForm, readRateConfirmation, type RcFill } from './rc-reader';
import { DriverMessageCard } from './DriverMessageCard';
import { RouteOptionsPanel } from './RouteOptionsPanel';
import { teamsByDriver, useDriverTeams } from '@/features/operations/team-api';
import { bookedDriverMessage } from './booked-message';
import {
  EQUIPMENT_OPTIONS,
  loadFormSchema,
  previewRevenuePerTotalMile,
  type LoadFormInput,
  type LoadFormValues,
} from './LoadFormSchema';

const ALL = 10_000;

/**
 * Books a load.
 *
 * The load is written to the data layer, not simulated: on submit it appears in the loads register,
 * in the dispatch "no driver or unit" count and in that customer's and broker's performance, because
 * every one of those reads the same store.
 */
export function LoadFormPage() {
  const navigate = useNavigate();
  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/loads" />}
        title="Book a load"
        description="Enter what the rate confirmation says. Everything else is derived."
      />
      <div className="flex w-full max-w-300 flex-col gap-(--section-gap)">
        <LoadForm
          onCancel={() => void navigate({ href: '/loads' })}
          onBooked={(loadNumber) =>
            void navigate({ href: `/loads/${encodeURIComponent(loadNumber)}` })
          }
        />
      </div>
    </div>
  );
}

/**
 * The booking form itself, page-free so the Loads register can raise it in a
 * modal (the NWF way: book without leaving the list). `onBooked` receives the
 * new load number after the store and toast are done.
 */
const BLANK_LOAD_FORM: LoadFormInput = {
  loadNumber: '',
  status: 'booked',
  driverId: '',
  coDriverId: '',
  truckId: '',
  trailerId: '',
  dispatcherId: '',
  updaterId: '',
  customerId: '',
  brokerId: '',
  brokerReference: '',
  commodity: '',
  // Money and mileage start empty, not at zero: a zero somebody has to delete before typing is
  // both a nuisance and, left behind, a figure that reads as real.
  weightLbs: undefined,
  equipmentType: '',
  hazmat: false,
  rate: undefined,
  driverRate: undefined,
  loadedMiles: undefined,
  emptyMiles: undefined,
  originCity: '',
  originState: '',
  destinationCity: '',
  destinationState: '',
  pickupAt: '',
  pickupEndAt: '',
  deliveryAt: '',
  deliveryEndAt: '',
  originStreet: '',
  originFacility: '',
  destinationFacility: '',
  originZip: '',
  destinationZip: '',
  // Live unless somebody says drop (owner, 2026-10-25).
  originHandling: 'live',
  destinationHandling: 'live',
  extraStops: [],
  notes: '',
};

/**
 * `datetime-local` wants wall-clock text, and the wall clock is the stop's (P0.4): an 8:00 AM
 * Atlanta appointment reads 8:00 here whether the person typing sits in Chicago or Tashkent.
 * A stop with no zone is shown in UTC and labelled so; nothing is silently converted.
 */
function localDateTime(iso: string | null | undefined, zone: string | null | undefined): string {
  const parts = localParts(iso, zone || 'UTC');
  return parts ? `${parts.date}T${parts.time}` : '';
}

/** The instant a wall-clock field means at a stop, or null when the text does not parse. */
function instantAt(text: string | undefined, zone: string | null | undefined): string | null {
  if (!text) return null;
  const [date, time] = text.split('T');
  if (!date || !time) return null;
  return instantFromLocal(date, time, zone || 'UTC');
}

/** `CDT`, or what to show when the place's clock is not known. */
function zoneLabel(zone: string | null | undefined, atText: string | undefined): string {
  if (!zone) return 'zone unknown';
  const at = instantAt(atText, zone);
  return zoneAbbreviation(at ? new Date(at) : new Date(), zone);
}

/**
 * The zone a stop's inputs are read in: the stored one while the stop is still the same place,
 * otherwise the new place's own. The same rule the store applies on save, so what the person
 * sees next to the field is what will be written.
 */
function zoneForStop(
  stored: { city: string; state: string; timezone: string } | undefined,
  city: string,
  state: string,
  zip: string | undefined,
): string | null {
  const same =
    stored &&
    stored.city.trim().toLowerCase() === city.trim().toLowerCase() &&
    stored.state.trim().toUpperCase() === state.trim().toUpperCase();
  if (same && stored.timezone) return stored.timezone;
  return resolveStopZone({ zip, city, state }).zone;
}

/**
 * The street line a stop was booked with. Stops booked before Street and Facility were apart
 * kept both in the facility name; that line comes back as the street. The auto "City pickup"
 * label is neither.
 */
function streetOf(stop: { facilityName: string; address?: string | null; city: string; kind: string } | undefined): string {
  if (!stop) return '';
  if (stop.address !== undefined && stop.address !== null) return stop.address;
  const auto = `${stop.city} ${stop.kind}`;
  return stop.facilityName && stop.facilityName !== auto ? stop.facilityName : '';
}

/** The facility's name, when the stop was booked with Street and Facility apart. */
function facilityOf(stop: { facilityName: string; address?: string | null; city: string; kind: string } | undefined): string {
  if (!stop || stop.address === undefined || stop.address === null) return '';
  const auto = `${stop.city} ${stop.kind}`;
  return stop.facilityName && stop.facilityName !== auto ? stop.facilityName : '';
}

/**
 * The Live / Drop to store for a stop. A stop booked before the choice existed reads Live and is
 * left without one while it stays Live, so saving an untouched load changes nothing.
 */
function handlingFor(stored: Load['stops'][number] | undefined, value: StopHandling | undefined): StopHandling | undefined {
  const chosen = value ?? 'live';
  if (stored && (stored.handling === undefined || stored.handling === null) && chosen === 'live') return undefined;
  return chosen;
}

/** The load as the form sees it: every field filled, so nothing is lost by opening the editor. */
function defaultsFromLoad(load: Load): LoadFormValues {
  const first = load.stops[0];
  const last = load.stops[load.stops.length - 1];
  const middle = load.stops.slice(1, -1);
  return {
    ...BLANK_LOAD_FORM,
    loadNumber: load.loadNumber,
    status: load.status,
    driverId: load.driverId ?? '',
    coDriverId: (load as Load & { coDriverId?: string | null }).coDriverId ?? '',
    truckId: load.truckId ?? '',
    trailerId: load.trailerId ?? '',
    dispatcherId: load.dispatcherId,
    updaterId: load.updaterId ?? '',
    customerId: load.customerId,
    brokerId: load.brokerId ?? '',
    brokerReference: load.brokerReference ?? '',
    commodity: load.commodity,
    weightLbs: load.weightLbs,
    equipmentType: load.equipmentType,
    hazmat: load.hazmat,
    rate: load.rate,
    driverRate: load.driverRate ?? undefined,
    loadedMiles: load.loadedMiles,
    emptyMiles: load.emptyMiles,
    originCity: first?.city ?? load.origin.city,
    originState: first?.state ?? load.origin.state,
    originStreet: streetOf(first),
    originFacility: facilityOf(first),
    originZip: first?.zip ?? '',
    destinationCity: last?.city ?? load.destination.city,
    destinationState: last?.state ?? load.destination.state,
    destinationStreet: streetOf(last),
    destinationFacility: facilityOf(last),
    destinationZip: last?.zip ?? '',
    pickupAt: localDateTime(first?.appointmentStartAt ?? load.pickupAt, first?.timezone),
    pickupEndAt: windowEnd(first),
    deliveryAt: localDateTime(last?.appointmentStartAt ?? load.deliveryAt, last?.timezone),
    deliveryEndAt: windowEnd(last),
    originHandling: stopHandlingOf(first),
    destinationHandling: stopHandlingOf(last),
    extraStops: middle.map((stop) => ({
      handling: stopHandlingOf(stop),
      kind: stop.kind,
      street: streetOf(stop),
      facility: facilityOf(stop),
      city: stop.city,
      state: stop.state,
      zip: stop.zip ?? '',
      at: localDateTime(stop.appointmentStartAt, stop.timezone),
      endAt: windowEnd(stop),
    })),
    notes: '',
  };
}

/** The window's end as the form shows it; blank when the customer gave one time. */
function windowEnd(stop: Load['stops'][number] | undefined): string {
  if (!stop || stop.appointmentNoWindow) return '';
  if (Date.parse(stop.appointmentEndAt) <= Date.parse(stop.appointmentStartAt)) return '';
  return localDateTime(stop.appointmentEndAt, stop.timezone);
}

/**
 * The For driver rate as stored (owner, 2026-10-23): blank, or the same as the rate, is null -
 * "pay on the rate" - so a rate the broker later moves is followed until somebody sets otherwise.
 */
function forDriverRate(values: Pick<LoadFormValues, 'rate' | 'driverRate'>): number | null {
  if (values.driverRate === undefined || values.driverRate === null) return null;
  return Math.round(values.driverRate * 100) === Math.round((values.rate ?? 0) * 100) ? null : values.driverRate;
}

export function LoadForm({
  onCancel,
  onBooked,
  initial,
}: {
  onCancel: () => void;
  onBooked: (loadNumber: string) => void;
  /**
   * The load being edited. Absent means this is a booking.
   *
   * Editing and booking are the same form on purpose: a correction that cannot reach a field the
   * booking screen offered is not an edit, it is a dead end — which is what sent people back to
   * the old system to fix an address.
   */
  initial?: Load;
}) {
  const editing = Boolean(initial);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Create load was pressed with no RC chosen. */
  const [rcMissing, setRcMissing] = useState(false);
  /*
   * The rate confirmation, chosen before the load exists (owner's brief, 2026-09-21).
   *
   * Nothing is uploaded until the load is created and has its permanent id; the file waits in the
   * browser as "Ready to attach", so cancelling the form leaves nothing behind. Creating is two
   * steps - the load, then the RC against that exact id - and a failure on the second leaves the
   * load in `unattached` so Retry attaches to it and never books a second load.
   */
  const [rc, setRc] = useState<File | null>(null);
  const [unattached, setUnattached] = useState<Load | null>(null);
  /** The load just created and its Telegram message: shown in place of the form until Done. */
  const [booked, setBooked] = useState<{ load: Load; text: string } | null>(null);
  // Route options open by themselves once the load exists; Skip or a choice closes them.
  const [routeStep, setRouteStep] = useState<'open' | 'chosen' | 'skipped'>('open');
  /**
   * Whoever is signed in is the dispatcher on this load.
   *
   * It is not a choice: permission to book a load is what makes somebody the dispatcher on it, and
   * a picker here only ever produced loads stamped with the wrong name. Reassigning one later is
   * done from the load itself, where it is audited.
   */
  const account = useAccount();
  const dispatcherName = account?.name ?? demoCurrentUser.name;
  const dispatcherId = account?.userId ?? demoCurrentUser.id;
  // A broker the system has never seen, typed into the picker mid-load.
  const [newBroker, setNewBroker] = useState<string | null>(null);
  // The number a new load gets is the store's, read once when the form opens and assigned on save.
  const [nextNumber, setNextNumber] = useState(() => (initial ? initial.loadNumber : peekNextLoadNumber()));
  // Read again once the loads (and the highest number used, hidden loads included) have arrived.
  useEffect(() => {
    if (initial) return;
    let live = true;
    void loadNextLoadNumber().then((n) => live && setNextNumber(n), () => undefined);
    return () => {
      live = false;
    };
  }, [initial]);

  const brokers = useQuery({
    queryKey: ['brokers', 'picker'],
    queryFn: () => listBrokers({ pageSize: ALL }),
  });
  const drivers = useQuery({
    queryKey: ['drivers', 'picker'],
    queryFn: () => listDrivers({ pageSize: ALL }),
  });
  const trucks = useQuery({
    queryKey: ['trucks', 'picker'],
    queryFn: () => listTrucks({ pageSize: ALL }),
  });
  const trailers = useQuery({
    queryKey: ['trailers', 'picker'],
    queryFn: () => listTrailers({ pageSize: ALL }),
  });

  const form = useZodForm(loadFormSchema, {
    defaultValues: initial ? defaultsFromLoad(initial) : BLANK_LOAD_FORM,
  });

  const rate = Number(form.watch('rate')) || 0;
  /**
   * Miles come from the stops, not from typing.
   *
   * The route recomputes whenever a stop, or the driver, changes. A figure the dispatcher has
   * edited by hand is never overwritten — `milesTouched` remembers that — because a number that
   * silently replaces what somebody entered is worse than no calculation.
   */
  /*
   * The dispatcher on an existing load is whoever is recorded on it - shown by name, and changed
   * only through Reassign (P0.2). The form used to fall back to the signed-in person whenever the
   * stored id was not in the picker's list, which reassigned the load to whoever opened it.
   */
  const dispatcherList = useDispatchers();
  const watchedDispatcherId = form.watch('dispatcherId');
  const recordedDispatcher =
    initial && watchedDispatcherId === initial.dispatcherId
      ? initial.dispatcherName
      : (dispatcherList.data?.find((d) => d.id === watchedDispatcherId)?.name ?? dispatcherName);
  const [reassigning, setReassigning] = useState(false);
  const watchedExtraStops = form.watch('extraStops');
  const extraStops = useMemo(() => watchedExtraStops ?? [], [watchedExtraStops]);
  const originCity = form.watch('originCity');
  const originState = form.watch('originState');
  const originZip = form.watch('originZip');
  const destinationCity = form.watch('destinationCity');
  const destinationState = form.watch('destinationState');
  const destinationZip = form.watch('destinationZip');
  const driverId = form.watch('driverId');
  // Team or Solo (owner, 2026-10-25): the driver's team partner is offered as the co-driver, never set by itself.
  const teams = useDriverTeams();
  const teamPartner = driverId ? (teamsByDriver(teams.data).get(driverId) ?? null) : null;
  const coDriverValue = form.watch('coDriverId');
  const [milesTouched, setMilesTouched] = useState({ loaded: false, empty: false });
  // Loaded miles the RC printed, once the reader put them in the field (owner, 2026-10-26).
  const [rcMiles, setRcMiles] = useState<number | null>(null);

  // The clock each stop's times are typed in (P0.4): the stored zone while the place is the same.
  const storedStops = useMemo(() => initial?.stops ?? [], [initial]);
  const zones = useMemo(
    () => ({
      origin: zoneForStop(storedStops[0], originCity, originState, originZip),
      destination: zoneForStop(
        storedStops[storedStops.length - 1],
        destinationCity,
        destinationState,
        destinationZip,
      ),
      extra: (extraStops ?? []).map((stop, index) =>
        zoneForStop(storedStops[index + 1], stop.city, stop.state, stop.zip),
      ),
    }),
    [
      storedStops,
      originCity,
      originState,
      originZip,
      destinationCity,
      destinationState,
      destinationZip,
      extraStops,
    ],
  );
  const originZone = zones.origin;
  const destinationZone = zones.destination;
  const extraZones = zones.extra;

  // Real US coordinates by ZIP and city (owner, 2026-10-13), fetched once for the miles.
  const places = useQuery({ queryKey: ['geo', 'us-places'], queryFn: ensureUsPlaces, staleTime: Infinity });
  const originZipValue = form.watch('originZip');
  const destinationZipValue = form.watch('destinationZip');
  const route = useMemo(() => {
    void places.data;
    const middle = (extraStops ?? []).map((stop) => ({ city: stop.city, state: stop.state, zip: stop.zip }));
    return loadedMilesFor([
      { city: originCity, state: originState, zip: originZipValue },
      ...middle,
      { city: destinationCity, state: destinationState, zip: destinationZipValue },
    ]);
  }, [originCity, originState, originZipValue, destinationCity, destinationState, destinationZipValue, extraStops, places.data]);

  /*
   * Empty miles: from the driver's last delivery to this first pickup, worked out by itself.
   *
   * The last delivery is the server's answer (owner, 2026-10-25), read from the loads table: the
   * browser's own copy of the list is only as fresh as this tab's last load read, so a load
   * somebody else booked for the driver since - or one this tab never fetched - left the field
   * empty. The browser's copy is used only when the server cannot be asked.
   */
  const lastDrop = useQuery({
    queryKey: ['loads', 'driver-last-drop', driverId || null, initial?.id ?? null],
    queryFn: () =>
      apiGet<{ drop: DriverLastDrop | null }>('/loads/driver-last-drop', {
        driverId,
        excludeLoadId: initial?.id,
      }),
    enabled: Boolean(driverId),
    staleTime: 30_000,
    retry: false,
  });
  const deadhead = useMemo(() => {
    void places.data;
    const pickup = { city: originCity, state: originState, zip: originZipValue };
    if (driverId && lastDrop.isPending) return { miles: null, note: 'Loading…' };
    return deadheadMilesFor(driverId || null, pickup, initial?.id ?? null, lastDrop.isSuccess ? lastDrop.data.drop : undefined);
  }, [driverId, originCity, originState, originZipValue, places.data, initial?.id, lastDrop.isPending, lastDrop.isSuccess, lastDrop.data]);

  /*
   * Miles are a suggestion, not a correction (P0.2). On a fresh booking an empty mileage box is
   * filled from the route once, because nothing typed is being replaced. On an existing load the
   * stored figure stays exactly as it is - the route's number is offered beside the field and
   * written only when the person takes it. A form that rewrote the miles on every open is why a
   * load saved without a single change came back different.
   */
  const loadedMilesText = form.watch('loadedMiles');
  const emptyMilesText = form.watch('emptyMiles');
  useEffect(() => {
    if (editing || milesTouched.loaded || rcMiles !== null || route.miles === null) return;
    if (loadedMilesText === undefined || loadedMilesText === '' || loadedMilesText === null) {
      form.setValue('loadedMiles', route.miles, { shouldDirty: true });
    }
  }, [editing, route.miles, milesTouched.loaded, rcMiles, loadedMilesText, form]);

  useEffect(() => {
    if (editing || milesTouched.empty || deadhead.miles === null) return;
    if (emptyMilesText === undefined || emptyMilesText === '' || emptyMilesText === null) {
      form.setValue('emptyMiles', deadhead.miles, { shouldDirty: true });
    }
  }, [editing, deadhead.miles, milesTouched.empty, emptyMilesText, form]);

  const loadedMiles = Number(form.watch('loadedMiles')) || 0;
  const emptyMiles = Number(form.watch('emptyMiles')) || 0;
  const loadedSuggestion = route.miles !== null && route.miles !== loadedMiles ? route.miles : null;
  // Where the figure in the box came from; nothing is said once a person has typed it.
  const loadedSource =
    editing || milesTouched.loaded || loadedMiles <= 0
      ? null
      : rcMiles !== null && loadedMiles === rcMiles
        ? 'From the RC'
        : route.miles !== null && loadedMiles === route.miles
          ? 'Estimated (straight line × 1.18)'
          : null;
  const emptySuggestion =
    deadhead.miles !== null && deadhead.miles !== emptyMiles ? deadhead.miles : null;
  const totalMiles = loadedMiles + emptyMiles;
  const revenuePerTotalMile = previewRevenuePerTotalMile(rate, loadedMiles, emptyMiles);
  const revenuePerLoadedMile = loadedMiles > 0 && rate > 0 ? rate / loadedMiles : null;
  const setStops = (next: LoadFormValues['extraStops']) =>
    form.setValue('extraStops', next, { shouldDirty: true });

  /**
   * The unit is held (§9.1). The store refused the write; the dialog asks for the reason and
   * re-runs the same values with it, so the override is written before the load is.
   */
  const [blocked, setBlocked] = useState<{
    error: DispatchBlockedError;
    values: LoadFormValues;
  } | null>(null);
  /** A route change that would clear a recorded arrival or departure; the person confirms first. */
  const [losing, setLosing] = useState<{
    error: StopEventsLossError;
    values: LoadFormValues;
  } | null>(null);

  /**
   * The stops as the store takes them: each time read in its own stop's clock. The zone is the
   * same one shown beside the field, so a person who typed 8:00 for Atlanta gets 8:00 Atlanta.
   */
  /**
   * The street to store. A stop booked before Street and Facility were apart kept its line in
   * the facility name; left as it was, that line is not re-saved as a street of its own.
   */
  function addressFor(stored: Load['stops'][number] | undefined, street: string | undefined, facility: string | undefined): string | null {
    const s = street?.trim() || '';
    if (stored && (stored.address === undefined || stored.address === null) && !facility?.trim() && s === streetOf(stored)) return null;
    return s || null;
  }

  function stopsFrom(values: LoadFormValues) {
    const middle = (values.extraStops ?? []).map((m, index) => {
      const zone = zoneForStop(storedStops[index + 1], m.city, m.state, m.zip);
      return {
        kind: m.kind,
        facilityName: m.facility?.trim() || undefined,
        address: addressFor(storedStops[index + 1], m.street, m.facility),
        city: m.city,
        state: m.state,
        zip: m.zip || null,
        at: instantAt(m.at, zone) ?? '',
        endAt: instantAt(m.endAt, zone),
        noWindow: !m.endAt,
        handling: handlingFor(storedStops[index + 1], m.handling),
      };
    });
    return {
      pickup: {
        kind: 'pickup' as const,
        facilityName: values.originFacility?.trim() || undefined,
        address: addressFor(storedStops[0], values.originStreet, values.originFacility),
        city: values.originCity,
        state: values.originState,
        zip: values.originZip || null,
        at: instantAt(values.pickupAt, originZone) ?? '',
        endAt: instantAt(values.pickupEndAt, originZone),
        noWindow: !values.pickupEndAt,
        handling: handlingFor(storedStops[0], values.originHandling),
      },
      middle,
      delivery: {
        kind: 'delivery' as const,
        facilityName: values.destinationFacility?.trim() || undefined,
        address: addressFor(storedStops[storedStops.length - 1], values.destinationStreet, values.destinationFacility),
        city: values.destinationCity,
        state: values.destinationState,
        zip: values.destinationZip || null,
        at: instantAt(values.deliveryAt, destinationZone) ?? '',
        endAt: instantAt(values.deliveryEndAt, destinationZone),
        noWindow: !values.deliveryEndAt,
        handling: handlingFor(storedStops[storedStops.length - 1], values.destinationHandling),
      },
    };
  }

  /**
   * Saving a load that already exists.
   *
   * The assignment goes to the server on its own, because a driver and a truck carry a rule, a
   * permission and an audit entry that a browser write cannot honour. Everything else - the
   * freight, the stops, the money - is still the collection's own edit. The assignment goes
   * first: if it is refused, nothing else has been written either.
   */
  async function saveExisting(
    values: LoadFormValues & { dispatchOverride?: string; confirmClearEvents?: boolean },
    stops: ReturnType<typeof stopsFrom>,
  ): Promise<Load> {
    const load = initial!;
    const nextDriver = values.driverId || null;
    const nextTruck = values.truckId || null;
    const nextTrailer = values.trailerId || null;
    const assignmentMoved =
      nextDriver !== (load.driverId ?? null) ||
      nextTruck !== (load.truckId ?? null) ||
      nextTrailer !== (load.trailerId ?? null);

    if (assignmentMoved) {
      // The out-of-service guard still runs here, before the server is asked: a blocked unit
      // opens the override dialog rather than being refused twice.
      if (nextTruck) {
        await assertDispatchAllowed(
          { id: nextTruck, unitNumber: truckOptions.find((t) => t.value === nextTruck)?.label ?? nextTruck },
          { ref: load.loadNumber },
          values.dispatchOverride ? { reason: values.dispatchOverride } : null,
        );
      }
      await apiPost(`/loads/${load.id}/assignment`, {
        driverId: nextDriver,
        driverName: nextDriver ? (driverOptions.find((d) => d.value === nextDriver)?.label ?? null) : null,
        truckId: nextTruck,
        truckUnit: nextTruck ? (truckOptions.find((t) => t.value === nextTruck)?.label ?? null) : null,
        trailerId: nextTrailer,
        trailerUnit: nextTrailer ? (trailerOptions.find((t) => t.value === nextTrailer)?.label ?? null) : null,
        expectedUpdatedAt: load.updatedAt,
      });
    }

    return updateLoad({
      loadId: load.id,
      // Status and assignment are the server's now; this write carries the rest.
      dispatcherId: values.dispatcherId || load.dispatcherId,
      updaterId: values.updaterId || null,
      updaterName: values.updaterId ? (dispatcherList.data?.find((d) => d.id === values.updaterId)?.name ?? null) : null,
      customerId: values.customerId ?? '',
      brokerId: values.brokerId || null,
      brokerReference: values.brokerReference ?? '',
      commodity: values.commodity ?? '',
      weightLbs: values.weightLbs ?? 0,
      equipmentType: (values.equipmentType || undefined) as Load['equipmentType'],
      hazmat: values.hazmat,
      rate: values.rate ?? 0,
      driverRate: forDriverRate(values),
      loadedMiles: values.loadedMiles ?? 0,
      emptyMiles: values.emptyMiles ?? 0,
      stops: [stops.pickup, ...stops.middle, stops.delivery],
      confirmClearEvents: values.confirmClearEvents === true,
    });
  }

  /** Books a new load or saves the one being edited: the write the form always did. */
  function createOrUpdate(
    values: LoadFormValues & { dispatchOverride?: string; confirmClearEvents?: boolean },
  ): Promise<Load> {
    const stops = stopsFrom(values);
    return initial
      ? saveExisting(values, stops)
      : createLoad({
          customerId: values.customerId ?? '',
          brokerId: values.brokerId || null,
          brokerReference: values.brokerReference ?? '',
          commodity: values.commodity ?? '',
          weightLbs: values.weightLbs ?? 0,
          equipmentType: (values.equipmentType || undefined) as Load['equipmentType'],
          hazmat: values.hazmat,
          rate: values.rate ?? 0,
          driverRate: forDriverRate(values),
          loadedMiles: values.loadedMiles ?? 0,
          emptyMiles: values.emptyMiles ?? 0,
          origin: {
            city: values.originCity,
            state: values.originState,
            zip: stops.pickup.zip,
            facilityName: stops.pickup.facilityName,
            address: stops.pickup.address,
            handling: stops.pickup.handling,
          },
          destination: {
            city: values.destinationCity,
            state: values.destinationState,
            zip: stops.delivery.zip,
            facilityName: stops.delivery.facilityName,
            address: stops.delivery.address,
            handling: stops.delivery.handling,
          },
          pickupAt: stops.pickup.at,
          pickupEndAt: stops.pickup.endAt,
          deliveryAt: stops.delivery.at,
          deliveryEndAt: stops.delivery.endAt,
          extraStops: stops.middle,
          dispatcherId: dispatcherId,
          dispatcherName,
          updaterId: values.updaterId || null,
          updaterName: values.updaterId ? (dispatcherList.data?.find((d) => d.id === values.updaterId)?.name ?? null) : null,
          loadNumber: undefined,
          // A driver on the load at booking dispatches it straight away (owner, 2026-10-13): it
          // never sits as Booked / Ready with somebody already on it.
          status: values.driverId ? 'dispatched' : 'booked',
          driverId: values.driverId || null,
          truckId: values.truckId || null,
          trailerId: values.trailerId || null,
          dispatchOverride: values.dispatchOverride ? { reason: values.dispatchOverride } : null,
          notes: values.notes?.trim() ? values.notes.trim() : null,
        });
  }

  /** The RC filed on a load that already exists; the one step Retry repeats. */
  async function attachRc(load: Load, file: File): Promise<Load> {
    const fileHash = await hashFile(file);
    const stored = await uploadFile(file);
    return uploadLoadDocument({
      loadId: load.id,
      type: 'rate_confirmation',
      fileName: file.name,
      sizeBytes: file.size,
      mimeType: file.type || 'application/pdf',
      fileUrl: stored.url,
      fileId: stored.id,
      uploadedBy: account?.name ?? demoCurrentUser.name,
      fileHash,
    });
  }

  const invalidateLoads = () =>
    // Operations reads one bundle; invalidating it is what makes the new load appear on the
    // dispatch board and in customer and broker performance without a reload.
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['loads'] }),
      queryClient.invalidateQueries({ queryKey: ['load'] }),
    ]);

  const retryAttach = useMutation({
    mutationFn: async () => {
      if (!unattached || !rc) throw new Error('Nothing to attach');
      return attachRc(unattached, rc);
    },
    onSuccess: async (load) => {
      setUnattached(null);
      setSubmitError(null);
      await invalidateLoads();
      toast({ tone: 'success', title: `Rate confirmation attached to ${load.loadNumber}` });
      setBooked({ load, text: bookedDriverMessage(load, rcExtract, driverRows.find((d) => d.id === load.driverId) ?? null) });
    },
    onError: (error: unknown) =>
      setSubmitError(
        error instanceof Error
          ? `RC upload failed again: ${error.message}`
          : 'RC upload failed again.',
      ),
  });

  const create = useMutation({
    mutationFn: async (
      values: LoadFormValues & { dispatchOverride?: string; confirmClearEvents?: boolean },
    ) => {
      if (rc && rc.size > 10 * 1024 * 1024) throw new Error('The rate confirmation is over 10 MB.');
      let load = await createOrUpdate(values);
      // The co-driver is an ordinary editable field on the server (team driving, accounting §6).
      const coBefore = (load as Load & { coDriverId?: string | null }).coDriverId ?? null;
      const coAfter = values.coDriverId || null;
      if (coAfter !== coBefore) {
        const out = await apiPatch<{ load: Load }>(`/loads/${load.id}`, { expectedUpdatedAt: load.updatedAt, patch: { coDriverId: coAfter, coDriverName: coAfter ? (driverOptions.find((d) => d.value === coAfter)?.label ?? null) : null } });
        load = out.load ?? load;
      }
      if (editing || !rc) return { load, attached: true as const, reason: null };
      try {
        return { load: await attachRc(load, rc), attached: true as const, reason: null };
      } catch (error) {
        return {
          load,
          attached: false as const,
          reason: error instanceof Error ? error.message : 'The file could not be stored.',
        };
      }
    },
    onSuccess: async ({ load, attached, reason }) => {
      await invalidateLoads();
      if (!attached) {
        // The load is real; the paperwork is not. Say exactly that, and keep the id for Retry.
        setUnattached(load);
        setSubmitError(`Load ${load.loadNumber} created, but RC upload failed. ${reason ?? ''}`);
        toast({
          tone: 'danger',
          title: 'Load created, but RC upload failed.',
          description: 'Retry the attachment; the load will not be created again.',
        });
        return;
      }
      toast({
        tone: 'success',
        title: editing ? `Load ${load.loadNumber} saved` : `Load ${load.loadNumber} booked`,
        description: editing
          ? undefined
          : rc
            ? 'Rate confirmation filed in its Documents: received, awaiting review.'
            : 'It is unassigned until a driver and unit are put on it.',
      });
      if (editing) {
        onBooked(load.loadNumber);
        return;
      }
      // The driver's Telegram message, ready the moment the load exists (owner, 2026-10-23):
      // the form steps aside for it, and Done goes on to the load as before.
      setBooked({ load, text: bookedDriverMessage(load, rcExtract, driverRows.find((d) => d.id === load.driverId) ?? null) });
    },
    onError: (error: unknown, values) => {
      if (isDispatchBlocked(error) && !values.dispatchOverride) {
        setBlocked({ error, values });
        return;
      }
      if (isStopEventsLoss(error) && !values.confirmClearEvents) {
        setLosing({ error, values });
        return;
      }
      setSubmitError(
        error instanceof Error
          ? error.message
          : editing
            ? 'The load could not be saved.'
            : 'The load could not be booked.',
      );
    },
  });

  // Assignment pickers are type-to-search lists, not dropdowns to scroll: a carrier with three
  // hundred drivers cannot be asked to find Robert by eye. All four are optional — choosing the
  // same row again clears it.
  const driverRows = drivers.data?.data ?? [];
  const driverOptions = driverRows.map((d) => ({
    value: d.id,
    label: `${d.name} · ${d.driverNumber}`,
    description: d.currentTruckUnit ? `Unit ${d.currentTruckUnit}` : 'No unit assigned',
  }));
  const truckOptions = (trucks.data?.data ?? []).map((t) => ({
    value: t.id,
    label: t.unitNumber,
    description: [t.make, t.model].filter(Boolean).join(' ') || undefined,
  }));
  const trailerOptions = (trailers.data?.data ?? []).map((t) => ({
    value: t.id,
    label: t.unitNumber,
    description: t.type,
  }));
  /**
   * Picking a driver fills in the unit they are already on.
   *
   * It is a default, not a rule: the truck and trailer stay editable, and a driver with no unit
   * clears nothing that was chosen by hand.
   */
  function chooseDriver(driverId: string | null) {
    form.setValue('driverId', driverId ?? '', { shouldDirty: true });
    const driver = driverRows.find((d) => d.id === driverId);
    if (!driver) return;
    if (driver.currentTruckId) {
      form.setValue('truckId', driver.currentTruckId, { shouldDirty: true });
    }
    if (driver.currentTrailerId) {
      form.setValue('trailerId', driver.currentTrailerId, { shouldDirty: true });
      return;
    }
    // The trailer the Daily board shows for the driver (owner, 2026-10-29): filled in when it is a
    // trailer on file, and only while nobody has picked one by hand in the meantime.
    const asked = driverId;
    void apiGet<{ trailerId: string | null; trailerUnit: string | null }>('/dispatch/board/driver-trailer', { driverId: asked })
      .then((r) => {
        if (r.trailerId && form.getValues('driverId') === asked && !form.getValues('trailerId')) form.setValue('trailerId', r.trailerId, { shouldDirty: true });
      })
      .catch(() => undefined);
  }

  /*
   * The RC reader: choosing the RC reads it and fills the form (owner, 2026-09-30). It only
   * proposes values - the dispatcher checks them and books the load as always.
   */
  const [rcFill, setRcFill] = useState<RcFill | null>(null);
  // What the reader read, for the driver's Telegram message (owner, 2026-10-17).
  const [rcExtract, setRcExtract] = useState<RateConfirmationExtract | null>(null);
  const readRc = useMutation({
    mutationFn: (file: File) => readRateConfirmation(file),
    onSuccess: (result) => {
      const fill = rcToForm(result.extract, brokers.data?.data ?? []);
      // A figure the person typed wins over the RC's.
      if (milesTouched.loaded) delete fill.values.loadedMiles;
      for (const [key, value] of Object.entries(fill.values)) {
        if (value === undefined) continue;
        form.setValue(key as 'notes', value as never, { shouldDirty: true });
      }
      setRcFill(fill);
      setRcExtract(result.extract);
      setRcMiles(typeof fill.values.loadedMiles === 'number' ? fill.values.loadedMiles : null);
    },
  });
  const chooseRc = (file: File | null) => {
    setRc(file);
    setRcFill(null);
    setRcExtract(null);
    setRcMiles(null);
    readRc.reset();
    if (file && canReadRc(file)) readRc.mutate(file);
  };
  // Not set up, a scan, or a broker the reader does not know: nothing to retry, fill by hand.
  const rcReadOff = readRc.error instanceof ApiError && (readRc.error.status === 503 || readRc.error.status === 422);

  // Brokers flagged do-not-use are absent on purpose; clearing the field books direct.
  const brokerOptions = (brokers.data?.data ?? [])
    .filter((b) => !b.doNotUse)
    .map((b) => ({ value: b.id, label: b.name, description: b.mcNumber }));

  if (booked) {
    return (
      <section aria-label="Load booked" className="flex w-full flex-col gap-3" data-testid="load-booked">
        <p className="text-sm font-semibold text-ink">
          Load {booked.load.loadNumber} booked. Copy the message for the driver’s Telegram chat.
        </p>
        {/* TollGuru's roads, cheapest first (owner, 2026-10-27); the chosen one goes into the message. */}
        {routeStep === 'open' ? (
          <RouteOptionsPanel
            load={booked.load}
            onChosen={(load) => {
              setBooked({ ...booked, load });
              setRouteStep('chosen');
            }}
            onSkip={() => setRouteStep('skipped')}
          />
        ) : booked.load.route ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink" data-testid="route-chosen">
            <span className="font-semibold">Route:</span> {booked.load.route.via} · {booked.load.route.miles} mi
            <Button type="button" size="sm" variant="ghost" onClick={() => setRouteStep('open')}>
              Change
            </Button>
          </p>
        ) : (
          <Button type="button" size="sm" variant="secondary" className="self-start" onClick={() => setRouteStep('open')}>
            Route options
          </Button>
        )}
        <DriverMessageCard initialText={booked.text} routeLine={booked.load.route ? routeLine(booked.load.route) : null} />
        <FormActions>
          <Button type="button" variant="primary" onClick={() => onBooked(booked.load.loadNumber)}>
            Done
          </Button>
        </FormActions>
      </section>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {submitError ? (
        <p role="alert" className="text-sm text-danger-text">
          {submitError}
        </p>
      ) : null}

      {/*
        The compact two-column sheet the dispatchers know.
        It carried section cards with a paragraph of prose each, which turned a form somebody fills
        in twenty times a day into something to read and put four nested scrollbars on screen. The
        fields are unchanged - every one of them - laid out on one grid, labelled and nothing else.
      */}
      {!editing ? (
        <section
          aria-label="Rate confirmation"
          className="flex flex-col gap-2 rounded-[10px] border border-nw-border bg-nw-subtle p-3"
        >
          <h3 className="text-sm font-bold text-ink">
            Rate confirmation (RC) <span className="text-nw-urgent-text" aria-hidden>*</span>
          </h3>
          <FileDropzone
            title="Rate confirmation"
            subtitle={
              rc
                ? `${Math.max(1, Math.round(rc.size / 1024))} KB · ${unattached ? 'Attachment failed' : 'Ready to attach'}`
                : 'Drop RC here or browse files · PDF or image (PDF, JPG, PNG)'
            }
            hint="Saved automatically in this load's Documents when you create the load."
            actionLabel="Browse files"
            file={rc}
            onFile={(file) => {
              if (file) setRcMissing(false);
              chooseRc(file);
            }}
            disabled={create.isPending || retryAttach.isPending}
          />
          {rcMissing && !rc ? (
            <p role="alert" className="text-sm font-semibold text-nw-urgent-text" data-testid="rc-required">
              The rate confirmation is required to create a load.
            </p>
          ) : null}
          {readRc.isPending ? (
            <p role="status" className="text-sm text-muted">
              Reading the RC… the form fills itself when it is done.
            </p>
          ) : null}
          {readRc.isError ? (
            <div role="status" className={cn('flex flex-wrap items-center gap-2 text-sm', rcReadOff ? 'text-muted' : 'text-danger-text')}>
              <span>
                {readRc.error instanceof ApiError ? `${readRc.error.title}. ${readRc.error.message}` : 'The RC could not be read. Fill the form by hand.'}
              </span>
              {!rcReadOff && rc ? (
                <Button size="sm" variant="secondary" onClick={() => readRc.mutate(rc)}>
                  Read again
                </Button>
              ) : null}
            </div>
          ) : null}
          {rcFill ? (
            <div role="status" className="flex flex-col gap-1.5 rounded-[8px] border border-nw-border bg-nw-panel p-2.5 text-sm">
              <p className="font-semibold text-ink">Filled from the RC — check every field before you create the load.</p>
              {rcFill.unknownBroker ? (
                <div className="flex flex-wrap items-center gap-2 text-warning-text">
                  <span>
                    Broker “{rcFill.unknownBroker.name}”{rcFill.unknownBroker.mc ? ` (MC ${rcFill.unknownBroker.mc})` : ''} is not in the broker list.
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => setNewBroker(rcFill.unknownBroker!.name)}>
                    Add this broker
                  </Button>
                </div>
              ) : null}
              {rcFill.warnings.length > 0 ? (
                <ul className="list-disc pl-5 text-warning-text">
                  {rcFill.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {unattached ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-danger-text">
              <span>Load {unattached.loadNumber} created, but RC upload failed.</span>
              <Button
                size="sm"
                variant="secondary"
                loading={retryAttach.isPending}
                disabled={!rc}
                onClick={() => {
                  setSubmitError(null);
                  retryAttach.mutate();
                }}
              >
                Retry attachment
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onBooked(unattached.loadNumber)}>
                Open the load without it
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      <Form
        form={form}
        onSubmit={(values: LoadFormValues) => {
          // One click, one load: a second submit while the first is in flight, or after a load
          // exists with its RC unattached, does nothing.
          if (create.isPending || retryAttach.isPending || unattached) return;
          // A new load needs its RC, the broker and the customer reference (owner, 2026-10-13).
          if (!editing) {
            let missing = false;
            if (!values.brokerId) {
              form.setError('brokerId', { message: 'Broker is required' });
              missing = true;
            }
            if (!values.brokerReference?.trim()) {
              form.setError('brokerReference', { message: 'Customer reference # is required' });
              missing = true;
            }
            if (!rc) {
              setRcMissing(true);
              missing = true;
            }
            if (missing) return;
          }
          create.mutate(values);
        }}
        className="gap-3"
      >
        {/* Customer & reference beside Load details, then the assignment - the owner's sheet. */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Section title="Customer & reference">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <ControlledField
                name="brokerId"
                label="Broker"
                required={!editing}
                render={({ field }) => (
                  <Combobox
                    id={field.id}
                    options={brokerOptions}
                    value={field.value || null}
                    onValueChange={(value) => field.onChange(value ?? '')}
                    onBlur={field.onBlur}
                    placeholder="No broker"
                    searchPlaceholder="Type a broker name or MC…"
                    emptyMessage="No broker matches"
                    loading={brokers.isPending}
                    onCreate={(name) => setNewBroker(name)}
                    createLabel={(name) => `+ Create broker “${name}”`}
                  />
                )}
              />
              <ControlledField
                name="brokerReference"
                label="Customer Reference #"
                required={!editing}
                render={({ field }) => (
                  <Input {...field} placeholder="REF-48210" autoComplete="off" />
                )}
              />
              <FormField
                label="Load number"
                description={editing ? undefined : 'Generated on save.'}
              >
                <span className="flex h-(--control-height-md) items-center rounded-md border border-line bg-surface-muted px-2.5 text-sm text-ink tabular-nums">
                  {editing ? initial?.loadNumber : nextNumber}
                </span>
              </FormField>
              {editing ? (
                <FormField
                  label="Status"
                  description={
                    <>
                      Moves from the{' '}
                      <Link to="/dispatch/daily" className="text-primary-text underline">
                        Daily Board
                      </Link>{' '}
                      or the load page&apos;s Record an event, not here.
                    </>
                  }
                >
                  <span className="flex h-(--control-height-md) items-center rounded-md border border-line bg-surface-muted px-2.5 text-sm text-ink">
                    {getStatus(initial?.status ?? 'booked').label}
                  </span>
                </FormField>
              ) : null}
            </div>
          </Section>
          <Section title="Load details">
            <div className="grid grid-cols-1 gap-y-3">
              <ControlledField
                name="equipmentType"
                label="Equipment"
                render={({ field }) => (
                  <Select
                    id={field.id}
                    placeholder="Not given"
                    options={[...EQUIPMENT_OPTIONS]}
                    value={field.value}
                    onValueChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
              <ControlledField
                name="hazmat"
                label="Hazmat"
                render={({ field }) => (
                  <Checkbox
                    id={field.id}
                    checked={Boolean(field.value)}
                    onCheckedChange={field.onChange}
                    label="Requires a hazmat endorsement"
                  />
                )}
              />
            </div>
          </Section>
        </div>

        <Section title="Assignment">
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            <ControlledField
              name="driverId"
              label="Driver"
              description="Type a name. The unit they are on fills in."
              render={({ field }) => (
                <Combobox
                  id={field.id}
                  options={driverOptions}
                  value={field.value || null}
                  onValueChange={chooseDriver}
                  onBlur={field.onBlur}
                  placeholder="No driver yet"
                  searchPlaceholder="Type a driver name or number…"
                  emptyMessage="No driver matches"
                  loading={drivers.isPending}
                />
              )}
            />
            <ControlledField
              name="coDriverId"
              label="Co-driver (team)"
              description={
                teamPartner && coDriverValue !== teamPartner.partnerId ? (
                  <span data-testid="team-partner-hint">
                    Team partner: {teamPartner.partnerName}.{' '}
                    <button
                      type="button"
                      className="cursor-pointer font-semibold text-nw-accent-ink underline"
                      onClick={() => form.setValue('coDriverId', teamPartner.partnerId, { shouldDirty: true })}
                    >
                      Use as co-driver
                    </button>
                  </span>
                ) : (
                  'Only for a team load. A percentage plan is shared, never paid twice.'
                )
              }
              render={({ field }) => (
                <Combobox
                  id={field.id}
                  options={driverOptions.filter((d) => d.value !== driverId)}
                  value={field.value || null}
                  onValueChange={(v) => form.setValue('coDriverId', v ?? '', { shouldDirty: true })}
                  onBlur={field.onBlur}
                  placeholder="No co-driver"
                  searchPlaceholder="Type a driver name or number…"
                  emptyMessage="No driver matches"
                  loading={drivers.isPending}
                />
              )}
            />
            <ControlledField
              name="truckId"
              label="Truck"
              render={({ field }) => (
                <Combobox
                  id={field.id}
                  options={truckOptions}
                  value={field.value || null}
                  onValueChange={(value) => field.onChange(value ?? '')}
                  onBlur={field.onBlur}
                  placeholder="No truck yet"
                  searchPlaceholder="Type a unit number…"
                  emptyMessage="No unit matches"
                  loading={trucks.isPending}
                />
              )}
            />
            <ControlledField
              name="trailerId"
              label="Trailer #"
              render={({ field }) => (
                <Combobox
                  id={field.id}
                  options={trailerOptions}
                  value={field.value || null}
                  onValueChange={(value) => field.onChange(value ?? '')}
                  onBlur={field.onBlur}
                  placeholder="No trailer yet"
                  searchPlaceholder="Type a trailer number…"
                  emptyMessage="No trailer matches"
                  loading={trailers.isPending}
                />
              )}
            />
            {/* No Updater on the form (owner, 2026-10-13). */}
            {editing && reassigning ? (
              <ControlledField
                name="dispatcherId"
                label="Dispatcher"
                description="The change is recorded on the load's timeline."
                render={({ field }) => (
                  <DispatcherSelect
                    id={field.id}
                    value={field.value || null}
                    onValueChange={(value) => field.onChange(value ?? initial?.dispatcherId ?? '')}
                    onBlur={field.onBlur}
                    placeholder="Choose a dispatcher"
                    currentLabel={
                      initial?.dispatcherId === field.value ? initial?.dispatcherName : null
                    }
                  />
                )}
              />
            ) : (
              <FormField
                label="Dispatcher"
                description={
                  editing ? 'As recorded on the load.' : 'You are the dispatcher on this load.'
                }
              >
                <span className="flex h-(--control-height-md) items-center justify-between gap-2 rounded-md border border-line bg-surface-muted px-2.5 text-sm text-ink">
                  <span className="truncate">{editing ? recordedDispatcher : dispatcherName}</span>
                  {editing ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() => setReassigning(true)}
                    >
                      Reassign
                    </Button>
                  ) : null}
                </span>
              </FormField>
            )}
          </div>
        </Section>

        {/* Stops: pickup first, delivery last, anything else in running order between them. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-ink">Stops</span>
            {(extraStops ?? []).length < 6 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                icon={<Plus />}
                onClick={() => {
                  // A route grows at the far end (owner, 2026-09-22): the delivery typed so far
                  // becomes a middle stop, and a fresh final Delivery card opens after it.
                  setStops([
                    ...(extraStops ?? []),
                    {
                      kind: 'delivery',
                      street: form.getValues('destinationStreet') ?? '',
                      facility: form.getValues('destinationFacility') ?? '',
                      city: form.getValues('destinationCity') ?? '',
                      state: form.getValues('destinationState') ?? '',
                      zip: form.getValues('destinationZip') ?? '',
                      at: form.getValues('deliveryAt') ?? '',
                      handling: form.getValues('destinationHandling') ?? 'live',
                    },
                  ]);
                  form.setValue('destinationHandling', 'live', { shouldDirty: true });
                  form.setValue('destinationStreet', '', { shouldDirty: true });
                  form.setValue('destinationFacility', '', { shouldDirty: true });
                  form.setValue('destinationCity', '', { shouldDirty: true });
                  form.setValue('destinationState', '', { shouldDirty: true });
                  form.setValue('destinationZip', '', { shouldDirty: true });
                  form.setValue('deliveryAt', '', { shouldDirty: true });
                }}
              >
                Add stop
              </Button>
            ) : null}
          </div>
          <StopLine
            index={1}
            kind="PICKUP"
            streetName="originStreet"
            facilityName="originFacility"
            cityName="originCity"
            stateName="originState"
            atName="pickupAt"
            handlingName="originHandling"
            zone={originZone}
            zoneText={zoneLabel(originZone, form.watch('pickupAt'))}
          />

          {(extraStops ?? []).map((stop, index) => (
            <ExtraStopCard
              key={index}
              index={index}
              stop={stop}
              zone={extraZones[index] ?? null}
              zoneText={zoneLabel(extraZones[index], stop.at)}
              onChange={(next) =>
                setStops((extraStops ?? []).map((item, i) => (i === index ? next : item)))
              }
            />
          ))}

          <StopLine
            index={2 + (extraStops ?? []).length}
            kind="DELIVERY"
            streetName="destinationStreet"
            facilityName="destinationFacility"
            cityName="destinationCity"
            stateName="destinationState"
            atName="deliveryAt"
            handlingName="destinationHandling"
            onRemove={
              (extraStops ?? []).length > 0
                ? () => {
                    const rest = [...(extraStops ?? [])];
                    const back = rest.pop();
                    if (!back) return;
                    setStops(rest);
                    form.setValue('destinationStreet', back.street ?? '', { shouldDirty: true });
                    form.setValue('destinationFacility', back.facility ?? '', { shouldDirty: true });
                    form.setValue('destinationCity', back.city, { shouldDirty: true });
                    form.setValue('destinationState', back.state, { shouldDirty: true });
                    form.setValue('destinationZip', back.zip ?? '', { shouldDirty: true });
                    form.setValue('deliveryAt', back.at, { shouldDirty: true });
                    form.setValue('destinationHandling', back.handling ?? 'live', { shouldDirty: true });
                  }
                : undefined
            }
            zone={destinationZone}
            zoneText={zoneLabel(destinationZone, form.watch('deliveryAt'))}
          />
        </div>

        <div className="flex flex-col gap-4">
          <Section title="Rates & freight">
            <div className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4">
              <ControlledField
                name="rate"
                label="Rate ($)"
                required
                render={({ field }) => (
                  <Input prefix="$" {...field} type="number" inputMode="decimal" placeholder="Enter amount" />
                )}
              />
              {/*
                Real vs For driver (owner, 2026-10-23): the rate above is what the broker pays and
                what the invoice bills; this is what the driver's statement pays on. Blank = the rate.
              */}
              <ControlledField
                name="driverRate"
                label={<span className="whitespace-nowrap">For driver ($)</span>}
                render={({ field }) => (
                  <Input
                    prefix="$"
                    {...field}
                    value={field.value ?? ''}
                    type="number"
                    inputMode="decimal"
                    placeholder={rate > 0 ? String(rate) : 'Same as rate'}
                  />
                )}
              />
              <ControlledField
                name="loadedMiles"
                label={<span className="whitespace-nowrap">Loaded miles</span>}
                required
                render={({ field }) => (
                  <Input
                    {...field}
                    type="number"
                    inputMode="numeric"
                    placeholder="Enter miles"
                    onChange={(event) => {
                      setMilesTouched((state) => ({ ...state, loaded: true }));
                      field.onChange(event);
                    }}
                  />
                )}
              />
              <ControlledField
                name="emptyMiles"
                label={<span className="whitespace-nowrap">Empty miles (DH)</span>}
                render={({ field }) => (
                  <Input
                    {...field}
                    type="number"
                    inputMode="numeric"
                    placeholder="Enter miles"
                    onChange={(event) => {
                      setMilesTouched((state) => ({ ...state, empty: true }));
                      field.onChange(event);
                    }}
                  />
                )}
              />
              <ControlledField
                name="weightLbs"
                label="Weight (lb)"
                render={({ field }) => (
                  <Input {...field} type="number" inputMode="numeric" placeholder="Enter weight" />
                )}
              />
            </div>
            {loadedSource !== null ? (
              <p className="text-xs text-muted" data-testid="loaded-miles-source">
                Loaded miles: {loadedSource}
              </p>
            ) : null}
            {/* The route's own numbers, offered on one line so the inputs above stay level. */}
            {loadedSuggestion !== null || emptySuggestion !== null ? (
              <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
                {loadedSuggestion !== null ? (
                  <span className="inline-flex items-center gap-x-1">
                    <span>{route.note}</span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() => {
                        setMilesTouched((state) => ({ ...state, loaded: true }));
                        form.setValue('loadedMiles', loadedSuggestion, { shouldDirty: true });
                      }}
                    >
                      Use {loadedSuggestion} mi
                    </Button>
                  </span>
                ) : null}
                {emptySuggestion !== null ? (
                  <span className="inline-flex items-center gap-x-1">
                    <span>{deadhead.note}</span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() => {
                        setMilesTouched((state) => ({ ...state, empty: true }));
                        form.setValue('emptyMiles', emptySuggestion, { shouldDirty: true });
                      }}
                    >
                      Use {emptySuggestion} mi
                    </Button>
                  </span>
                ) : null}
              </p>
            ) : null}
            {revenuePerTotalMile !== null ? (
              <p className="text-xs text-muted">
                Revenue per mile:{' '}
                <span className="tabular font-semibold text-ink">
                  {revenuePerLoadedMile === null ? '—' : formatMoney(revenuePerLoadedMile)}
                </span>{' '}
                loaded ·{' '}
                <span className="tabular font-semibold text-ink">
                  {formatMoney(revenuePerTotalMile)}
                </span>{' '}
                total ({totalMiles} mi)
              </p>
            ) : null}
          </Section>

          <ControlledField
            name="notes"
            label="Notes"
            render={({ field }) => <Textarea {...field} rows={3} placeholder="Add load notes..." />}
          />

          {!editing ? (
            <Section title="Stage">
              <div className="flex items-start gap-2 rounded-md border border-nw-border bg-nw-subtle px-3 py-2.5 text-sm">
                <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-nw-text-3" />
                <span>
                  <span className="block font-medium text-ink">
                    Determined by assignment and events
                  </span>
                  <span className="block text-xs text-muted">
                    The load stage will update automatically as drivers are assigned and events
                    occur.
                  </span>
                </span>
              </div>
            </Section>
          ) : null}
        </div>

        <FormActions>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            disabled={create.isPending || retryAttach.isPending || unattached !== null}
          >
            {editing ? 'Save changes' : rc ? 'Create load & attach RC' : 'Create Load'}
          </Button>
        </FormActions>
      </Form>

      <DispatchOverrideDialog
        blocked={blocked?.error ?? null}
        onCancel={() => setBlocked(null)}
        onOverride={(reason) => {
          const values = blocked?.values;
          if (!values) return Promise.resolve();
          return create.mutateAsync({ ...values, dispatchOverride: reason });
        }}
      />

      <ConfirmDialog
        open={losing !== null}
        onOpenChange={(open) => {
          if (!open) setLosing(null);
        }}
        tone="danger"
        title="Clear recorded times at these stops?"
        description={
          <span className="flex flex-col gap-2">
            <span>
              These stops changed city, and the arrival or departure recorded there belongs to the
              old place. Saving clears those times; the change is written to the timeline.
            </span>
            <ul className="list-disc pl-5">
              {(losing?.error.losses ?? []).map((loss) => {
                // The times read in the clock of the place they happened at, like everywhere else.
                const zone = storedStops.find((stop) => stop.id === loss.stopId)?.timezone;
                return (
                  <li key={loss.stopId}>
                    Stop {loss.index + 1}: {loss.from} → {loss.to}
                    {loss.arrivedAt ? ` · arrived ${formatInstant(loss.arrivedAt, zone).text}` : ''}
                    {loss.departedAt
                      ? ` · departed ${formatInstant(loss.departedAt, zone).text}`
                      : ''}
                  </li>
                );
              })}
            </ul>
          </span>
        }
        confirmLabel="Clear times and save"
        cancelLabel="Keep the times"
        onConfirm={() => {
          const values = losing?.values;
          setLosing(null);
          if (values) create.mutate({ ...values, confirmClearEvents: true });
        }}
      />

      {newBroker !== null ? (
        <QuickCreateBrokerDialog
          name={newBroker}
          onClose={() => setNewBroker(null)}
          onCreated={(broker) => {
            form.setValue('brokerId', broker.id, { shouldDirty: true });
            setNewBroker(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The first pickup and the final delivery, on the same grid as the stops between them.
 *
 * They are separate fields on the form rather than rows of `extraStops` because a load always has
 * exactly one of each and the risk engine reads them by name.
 */
function StopLine({
  index,
  kind,
  streetName,
  facilityName,
  cityName,
  stateName,
  atName,
  handlingName,
  zone,
  zoneText,
  onRemove,
}: {
  index: number;
  kind: 'PICKUP' | 'DELIVERY';
  /** The last stop can be taken off when it was added; the one before it becomes the delivery. */
  onRemove?: () => void;
  streetName: 'originStreet' | 'destinationStreet';
  facilityName: 'originFacility' | 'destinationFacility';
  cityName: 'originCity' | 'destinationCity';
  stateName: 'originState' | 'destinationState';
  atName: 'pickupAt' | 'deliveryAt';
  handlingName: 'originHandling' | 'destinationHandling';
  zone: string | null;
  zoneText: string;
}) {
  const zipName = kind === 'PICKUP' ? 'originZip' : 'destinationZip';
  return (
    <div className="rounded-[10px] border border-nw-border bg-nw-panel p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-full bg-nw-accent text-xs font-bold text-nw-on-accent">
          {index}
        </span>
        <span className="text-sm font-semibold text-ink">
          {kind === 'PICKUP' ? 'Pickup' : 'Delivery'}
        </span>
        <Controller<LoadFormValues, typeof handlingName>
          name={handlingName}
          render={({ field }) => (
            <HandlingChoice
              className="ml-auto"
              label={`${kind === 'PICKUP' ? 'Pickup' : 'Delivery'} ${index} live or drop`}
              value={field.value ?? 'live'}
              onChange={field.onChange}
            />
          )}
        />
        {onRemove ? (
          <IconButton
            label={`Remove stop ${index}`}
            variant="ghost"
            size="sm"
            onClick={onRemove}
          >
            <X />
          </IconButton>
        ) : null}
      </div>
      <div className="flex flex-col gap-3">
        {/* Facility and street apart, on every stop (owner, 2026-10-13). */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ControlledField
            name={facilityName}
            label="Facility"
            render={({ field }) => (
              <Input
                {...field}
                value={field.value ?? ''}
                aria-label={`${kind} facility`}
                placeholder={kind === 'PICKUP' ? 'Shipper, e.g. SCM Warehouse' : 'Receiver, e.g. Aldi DC Petersburg'}
              />
            )}
          />
          <ControlledField
            name={streetName}
            label="Street"
            render={({ field }) => (
              <Input
                {...field}
                value={field.value ?? ''}
                aria-label={`${kind} street`}
                placeholder="1601 Old Augusta Rd"
              />
            )}
          />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_5rem_8rem] gap-3">
          <ControlledField
            name={cityName}
            label="City"
            render={({ field }) => (
              <Input {...field} aria-label={`${kind} city`} placeholder="Enter city" />
            )}
          />
          <ControlledField
            name={stateName}
            label="State"
            render={({ field }) => (
              <Input
                {...field}
                aria-label={`${kind} state`}
                placeholder="ST"
                maxLength={2}
                className="uppercase"
              />
            )}
          />
          <ControlledField
            name={zipName}
            label="ZIP"
            render={({ field }) => (
              <Input
                {...field}
                value={field.value ?? ''}
                aria-label={`${kind} ZIP`}
                placeholder="Enter ZIP"
              />
            )}
          />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
          <ControlledField
            name={atName}
            label="Appointment"
            required
            render={({ field }) => (
              <Input {...field} aria-label={`${kind} appointment`} type="datetime-local" />
            )}
          />
          <span className="pb-2.5 text-xs text-muted">
            Time zone: <ZoneTag zone={zone} text={zoneText} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** A middle stop, drawn like the first and the last: numbered, with its own kind and street. */
function ExtraStopCard({
  index,
  stop,
  zone,
  zoneText,
  onChange,
}: {
  index: number;
  stop: NonNullable<LoadFormValues['extraStops']>[number];
  zone: string | null;
  zoneText: string;
  onChange: (next: NonNullable<LoadFormValues['extraStops']>[number]) => void;
}) {
  const n = index + 2;
  return (
    <div className="rounded-[10px] border border-nw-border bg-nw-panel p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-full bg-nw-accent text-xs font-bold text-nw-on-accent">
          {n}
        </span>
        <Select
          size="sm"
          aria-label={`Stop ${n} kind`}
          options={[
            { value: 'pickup', label: 'Pickup' },
            { value: 'delivery', label: 'Delivery' },
          ]}
          value={stop.kind}
          onValueChange={(value) => onChange({ ...stop, kind: value as 'pickup' | 'delivery' })}
        />
        <HandlingChoice
          className="ml-auto"
          label={`Stop ${n} live or drop`}
          value={stop.handling ?? 'live'}
          onChange={(handling) => onChange({ ...stop, handling })}
        />
      </div>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Facility">
            <Input
              aria-label={`Stop ${n} facility`}
              placeholder="Di Pinto Intl Logistics"
              value={stop.facility ?? ''}
              onChange={(event) => onChange({ ...stop, facility: event.target.value })}
            />
          </FormField>
          <FormField label="Street">
            <Input
              aria-label={`Stop ${n} street`}
              placeholder="1400 Corbin St"
              value={stop.street ?? ''}
              onChange={(event) => onChange({ ...stop, street: event.target.value })}
            />
          </FormField>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_5rem_8rem] gap-3">
          <FormField label="City">
            <Input
              aria-label={`Stop ${n} city`}
              placeholder="Enter city"
              value={stop.city}
              onChange={(event) => onChange({ ...stop, city: event.target.value })}
            />
          </FormField>
          <FormField label="State">
            <Input
              aria-label={`Stop ${n} state`}
              placeholder="ST"
              maxLength={2}
              className="uppercase"
              value={stop.state}
              onChange={(event) => onChange({ ...stop, state: event.target.value })}
            />
          </FormField>
          <FormField label="ZIP">
            <Input
              aria-label={`Stop ${n} ZIP`}
              placeholder="Enter ZIP"
              value={stop.zip ?? ''}
              onChange={(event) => onChange({ ...stop, zip: event.target.value })}
            />
          </FormField>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
          <FormField label="Appointment" required>
            <Input
              aria-label={`Stop ${n} appointment`}
              type="datetime-local"
              value={stop.at}
              onChange={(event) => onChange({ ...stop, at: event.target.value })}
            />
          </FormField>
          <span className="pb-2.5 text-xs text-muted">
            Time zone: <ZoneTag zone={zone} text={zoneText} />
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Live or drop at a stop (owner, 2026-10-25): a live load / unload with the driver at the dock,
 * or a drop - leave the trailer. Live unless somebody says otherwise; the driver's Telegram
 * message opens with the first pickup's and the last delivery's ("LIVE / DROP").
 */
function HandlingChoice({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: StopHandling;
  onChange: (next: StopHandling) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex gap-0.5 rounded-[9px] bg-nw-segment p-[3px]', className)}>
      {(['live', 'drop'] as const).map((option) => {
        const on = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option)}
            className={cn(
              'inline-flex h-6 items-center rounded-[7px] px-2.5 text-xs font-semibold whitespace-nowrap transition-colors',
              on ? 'bg-nw-panel text-nw-accent-ink shadow-segment ring-1 ring-nw-border' : 'text-nw-text-2 hover:text-nw-text',
            )}
          >
            {option === 'live' ? 'Live' : 'Drop'}
          </button>
        );
      })}
    </div>
  );
}

/** A titled block of the booking sheet, as the owner drew it. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

/** The clock a stop's times are read in (P0.4). Unknown is said, never filled in. */
function ZoneTag({ zone, text }: { zone: string | null; text: string }) {
  return (
    <span
      className={
        zone
          ? 'w-14 truncate text-xs font-medium text-secondary'
          : 'w-14 truncate text-xs font-medium text-warning-text'
      }
      title={
        zone ?? 'No zone could be found for this city and state. Check the spelling or add a ZIP.'
      }
    >
      {text}
    </span>
  );
}
