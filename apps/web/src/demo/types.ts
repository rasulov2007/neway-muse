import type { ChosenRoute } from '@neway/shared';
import type { LoadSegment } from './recovery-split';
/**
 * Frontend mirror of the entity shapes in docs/DATABASE.md §3, simplified for the demo dataset.
 *
 * Every status field is a union of codes from `design-system/status.ts` so badges, tables and
 * charts resolve through the one status map. Money is in dollars (2-decimal numbers), distances
 * in miles, timestamps as ISO 8601 strings.
 */
import type { StatusCode } from '@/design-system/status';

export type IsoDateTime = string;
/** `YYYY-MM-DD` */
export type IsoDate = string;

/**
 * Notification / insight severity (docs/DATABASE.md §3.16). Not a status: `success` is a
 * semantic tone in the design system, not a status code, so this union stands on its own.
 */
export type Severity = 'critical' | 'warning' | 'info' | 'success';

export type Department =
  'dispatch' | 'safety' | 'maintenance' | 'accounting' | 'hr' | 'fleet' | 'management';

export interface Address {
  line1: string;
  city: string;
  state: string;
  zip: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Company {
  id: string;
  slug: string;
  name: string;
  legalName: string;
  status: Extract<StatusCode, 'active' | 'suspended' | 'closed'>;
  plan: string;
  timezone: string;
  usdot: string;
  mcNumber: string;
  scac: string;
  phone: string;
  address: Address;
  demo: boolean;
}

export interface Membership {
  companyId: string;
  companyName: string;
  companyCity: string;
  role: string;
  status: Extract<StatusCode, 'active' | 'pending' | 'suspended'>;
  isCurrent: boolean;
}

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  phone: string;
  title: string;
  department: Department;
  role: string;
  status: Extract<StatusCode, 'active' | 'inactive'>;
  lastLoginAt: IsoDateTime;
}

export type TruckStatus = Extract<
  StatusCode,
  | 'active'
  | 'driving'
  | 'available'
  | 'idle'
  | 'in_shop'
  | 'out_of_service'
  | 'maintenance'
  | 'accident'
  // A unit parked indefinitely: the lifecycle has always been able to reach it, and the roster
  // stores it, so the type says so too.
  | 'inactive'
  | 'sold'
  // Archived (owner, 2026-10-05): off every list, picker and count; history keeps its number.
  | 'archived'
>;

export type FleetHealth = Extract<StatusCode, 'healthy' | 'needs_attention' | 'critical'>;

export interface TruckLocation extends GeoPoint {
  city: string;
  state: string;
  updatedAt: IsoDateTime;
  speedMph: number;
  engineState: 'on' | 'off' | 'idle';
  /** Degrees clockwise from north, when the feed reported one. The map's arrow needs it. */
  headingDegrees?: number | null;
}

export interface Truck {
  id: string;
  unitNumber: string;
  vin: string;
  year: number;
  make: string;
  model: string;
  /** Registration, colour and terminal are `null` until entered; the page prints "Not set". */
  plate: string | null;
  plateState: string | null;
  color: string | null;
  status: TruckStatus;
  health: FleetHealth;
  ownership: 'owned' | 'leased' | 'owner_operator' | 'vendor';
  /** The vendor the truck runs for (owner, 2026-10-28); null or absent on a company truck. */
  vendor?: import('@neway/shared').TruckVendor | null;
  odometer: number;
  odometerAt: IsoDateTime;
  engineHours: number;
  /** Null until entered from the unit's page; PM scheduling runs from the day it was added until then. */
  inServiceDate: IsoDate | null;
  currentDriverId: string | null;
  currentDriverName: string | null;
  currentTrailerId: string | null;
  currentLoadId: string | null;
  location: TruckLocation | null;
  nextServiceOdometer: number;
  nextServiceDate: IsoDate;
  nextServiceType: MaintenanceType;
  telematicsProvider: string;
  telematicsStatus: Extract<StatusCode, 'connected' | 'disconnected' | 'error'>;
  /** Rolling fuel economy used by the MPG-drop detector. */
  mpg30d: number;
  mpg90d: number;
  idlePercent30d: number;
  idlePercent90d: number;
  homeTerminal: string | null;
  /** The record's last write, from the server: the version an archive or restore quotes back. */
  updatedAt?: IsoDateTime;
}

export type TrailerType = 'dry_van' | 'reefer' | 'flatbed';
export type TrailerStatus = Extract<
  StatusCode,
  'available' | 'assigned' | 'in_shop' | 'out_of_service' | 'sold'
>;

export interface Trailer {
  id: string;
  unitNumber: string;
  vin: string;
  /*
   * Null when nobody recorded one. 155 of the 160 trailers imported from Ditat have neither a
   * year nor a make, and the page prints "Not set" for both rather than a year somebody invented.
   */
  year: number | null;
  make: string | null;
  /** Added 2026-10-22; null for every trailer recorded before the form asked for it. */
  model: string | null;
  type: TrailerType;
  /** Length, plate and the next inspection are `null` until entered; the page prints "Not set". */
  lengthFt: number | null;
  plate: string | null;
  plateState: string | null;
  status: TrailerStatus;
  ownership: 'owned' | 'leased';
  currentTruckId: string | null;
  currentTruckUnit: string | null;
  location: { city: string; state: string } | null;
  nextInspectionDate: IsoDate | null;
}

export type DriverStatus = Extract<
  StatusCode,
  | 'driving'
  | 'dispatched'
  | 'available'
  | 'off_duty'
  | 'sleeper'
  | 'suspended'
  | 'terminated'
  | 'inactive'
>;

export type ComplianceStatus = Extract<StatusCode, 'verified' | 'expiring' | 'expired' | 'missing'>;

export interface Driver {
  id: string;
  driverNumber: string;
  firstName: string;
  lastName: string;
  name: string;
  phone: string;
  /** A second number and what it is; both null when there is none. */
  secondaryPhone?: string | null;
  secondaryPhoneLabel?: 'cell' | 'home' | 'spouse' | 'dispatch_only' | null;
  email: string;
  driverType: 'company' | 'owner_operator' | 'lease_operator';
  cdlState: string;
  cdlClass: 'A' | 'B';
  cdlEndorsements: string[];
  cdlExpiresOn: IsoDate;
  cdlStatus: ComplianceStatus;
  medicalCardExpiresOn: IsoDate;
  medicalCardStatus: ComplianceStatus;
  /** Date of birth (owner, 2026-10-25); null or absent when not recorded. Personal data. */
  dateOfBirth?: IsoDate | null;
  hireDate: IsoDate;
  status: DriverStatus;
  dispatcherId: string;
  dispatcherName: string;
  currentTruckId: string | null;
  currentTruckUnit: string | null;
  currentTrailerId: string | null;
  homeCity: string;
  homeState: string;
  safetyScore: number;
  safetyEvents30d: number;
  payPlan: { kind: 'per_mile' | 'percent_of_linehaul' | 'lease_owner' | 'lease_to_own' | 'owner_truck'; rate: number };
  preferredLanguage: 'en' | 'es' | 'ru' | 'uz' | 'uk';
  /** Archived (owner, 2026-10-02): hidden from the Drivers page and pickers, kept, restorable. */
  archivedAt?: string | null;
  archivedReason?: string | null;
  /** The row's last write, from the API; an edit quotes it back so a stale save is refused. */
  updatedAt?: string;
}

export interface Customer {
  id: string;
  name: string;
  mcNumber: string | null;
  usdot: string | null;
  address: Address;
  paymentTermsDays: number;
  creditLimit: number;
  status: Extract<StatusCode, 'active' | 'inactive' | 'on_hold' | 'archived'>;
  primaryContact: { name: string; email: string; phone: string };
  loadsLast90d: number;
  revenueLast90d: number;
}

export interface Broker {
  id: string;
  name: string;
  mcNumber: string;
  usdot: string;
  address: Address;
  paymentTermsDays: number;
  /** Null until the carrier has hauled enough freight to rate them. Zero would read as bad. */
  rating: number | null;
  doNotUse: boolean;
  doNotUseReason: string | null;
  status: Extract<StatusCode, 'active' | 'inactive' | 'on_hold' | 'archived'>;
  primaryContact: { name: string; email: string; phone: string };
  loadsLast90d: number;
  revenueLast90d: number;
  outstandingBalance: number;
  /** Where the record came from, and its key there, when it was imported rather than typed. */
  source?: string | null;
  externalId?: string | null;
}

export interface Facility extends GeoPoint {
  id: string;
  name: string;
  address: Address;
  timezone: string;
  appointmentRequired: boolean;
  avgDwellMinutes: number;
  hours: string;
}

export type LoadStatus = Extract<
  StatusCode,
  | 'booked'
  | 'assigned'
  | 'dispatched'
  | 'at_pickup'
  | 'loading'
  | 'loaded'
  | 'in_transit'
  | 'at_delivery'
  | 'unloading'
  | 'delivered'
  | 'closed'
  | 'cancelled'
  | 'tonu'
>;

export type LoadExceptionCode = Extract<StatusCode, 'at_risk' | 'delayed' | 'problem'>;

export interface LoadException {
  code: LoadExceptionCode;
  reason: string;
  raisedAt: IsoDateTime;
}

export type StopStatus = Extract<
  StatusCode,
  'pending' | 'in_transit' | 'in_progress' | 'completed' | 'cancelled'
>;

export interface Stop {
  id: string;
  sequence: number;
  kind: 'pickup' | 'delivery';
  facilityId: string;
  facilityName: string;
  /** The street line, kept apart from the facility's name (owner, 2026-10-13). */
  address?: string | null;
  city: string;
  state: string;
  /** ZIP when it was given; the first thing the zone lookup reads (P0.4). */
  zip?: string | null;
  /** IANA zone of the place. Empty when nobody could work it out - shown as unknown, never guessed. */
  timezone: string;
  appointmentStartAt: IsoDateTime;
  appointmentEndAt: IsoDateTime;
  /** The customer gave one time, not a window (P0.4). */
  appointmentNoWindow?: boolean;
  /** Live load / unload or drop (owner, 2026-10-25); absent on older stops = live. */
  handling?: 'live' | 'drop' | null;
  status: StopStatus;
  arrivedAt: IsoDateTime | null;
  departedAt: IsoDateTime | null;
  /** When the freight went on (the BOL's moment) - separate from the departure (rule 1.5). */
  loadedAt?: IsoDateTime | null;
  /** Free time here before detention, from the rate con; the config default when absent. */
  freeTimeMinutes?: number | null;
  /** When the receiver confirmed the appointment, if somebody recorded it. */
  appointmentConfirmedAt?: IsoDateTime | null;
  detentionMinutes: number;
  notes: string | null;
}

export type ChargeType =
  'linehaul' | 'fuel_surcharge' | 'detention' | 'layover' | 'lumper' | 'stop_charge' | 'tonu';

export interface LoadCharge {
  id: string;
  type: ChargeType;
  description: string;
  amount: number;
  /** What the driver is paid on for this charge (detention, layover); null or absent = `amount`. */
  driverAmount?: number | null;
  billable: boolean;
  payableToDriver: boolean;
  /** A drafted charge (detention, rule 1.8) is one nobody has accepted yet. */
  status?: 'draft' | 'accepted' | 'dropped';
  stopId?: string | null;
}

export type ExpenseCategory = 'fuel' | 'driver_pay' | 'tolls' | 'maintenance' | 'other';

export interface LoadExpense {
  id: string;
  category: ExpenseCategory;
  description: string;
  amount: number;
  source: 'fuel_allocation' | 'driver_pay' | 'toll' | 'maintenance_allocation' | 'manual';
}

export interface LoadFinancials {
  revenue: number;
  fuel: number;
  driverPay: number;
  tolls: number;
  maintenanceAllocation: number;
  other: number;
  grossProfit: number;
  rpm: number;
  costPerMile: number;
  profitPerMile: number;
}

export type LoadEventKind =
  | 'booked'
  | 'assigned'
  | 'dispatched'
  | 'arrived'
  | 'loading_started'
  | 'loaded'
  | 'departed'
  | 'eta_changed'
  | 'exception_raised'
  | 'document_uploaded'
  | 'note_added'
  | 'delivered'
  | 'closed'
  | 'cancelled';

export type ActorType = 'user' | 'driver' | 'system' | 'ai';

export interface LoadEvent {
  id: string;
  at: IsoDateTime;
  kind: LoadEventKind;
  actorType: ActorType;
  actorName: string;
  title: string;
  detail: string | null;
  stopId: string | null;
}

export interface LoadNote {
  id: string;
  kind: 'internal' | 'broker' | 'driver';
  body: string;
  authorName: string;
  at: IsoDateTime;
  pinned: boolean;
}

export type DocumentType =
  | 'rate_confirmation'
  | 'bol'
  | 'pod'
  | 'invoice'
  | 'lumper_receipt'
  | 'detention'
  | 'tonu'
  | 'layover'
  | 'other';

export type DocumentReviewState = 'received' | 'reviewed' | 'verified';

export interface LoadDocument {
  id: string;
  type: DocumentType;
  title: string;
  fileName: string;
  sizeBytes: number;
  uploadedAt: IsoDateTime;
  uploadedBy: string;
  /**
   * The older field. `missing` is the placeholder for paperwork not yet arrived; `pending` an
   * upload no person has verified; `verified` a person's word - set only by `review` now.
   */
  status: Extract<StatusCode, 'pending' | 'verified' | 'missing'>;
  /** Where the document stands with a person (P0.5): received on upload, then reviewed, then verified. */
  review?: DocumentReviewState;
  reviewedBy?: string | null;
  reviewedAt?: IsoDateTime | null;
  verifiedBy?: string | null;
  verifiedAt?: IsoDateTime | null;
  /** SHA-256 of the bytes, when the browser could compute it; how the same file under two types is caught. */
  fileHash?: string | null;
  /** Where the bytes live in the file store (`/files/:id`); absent on seeded paperwork. */
  fileUrl?: string;
  fileId?: string;
  /** The pre-file-store shape: the file inline as a data URL. Read, never written. */
  dataUrl?: string;
  /** MIME type of the uploaded file, for choosing preview vs open-in-tab. */
  mimeType?: string;
}

export interface Load {
  id: string;
  loadNumber: string;
  status: LoadStatus;
  exception: LoadException | null;
  customerId: string;
  customerName: string;
  brokerId: string | null;
  brokerName: string | null;
  brokerReference: string;
  commodity: string;
  weightLbs: number;
  pieces: number;
  equipmentType: TrailerType;
  temperatureF: number | null;
  hazmat: boolean;
  dispatcherId: string;
  dispatcherName: string;
  driverId: string | null;
  driverName: string | null;
  truckId: string | null;
  truckUnit: string | null;
  trailerId: string | null;
  trailerUnit: string | null;
  origin: { city: string; state: string };
  destination: { city: string; state: string };
  stops: Stop[];
  rate: number;
  /**
   * What the driver is paid on, when it is not the rate (owner, 2026-10-23): the broker pays
   * `rate`, the driver's statement figures pay on this. Null or absent = the same as the rate.
   */
  driverRate?: number | null;
  loadedMiles: number;
  emptyMiles: number;
  rpm: number;
  charges: LoadCharge[];
  expenses: LoadExpense[];
  /**
   * Null until costs post against the load. A freshly booked load has a rate and miles but no
   * fuel, driver pay or maintenance yet, and reporting those as zero would understate cost per
   * mile for every load in its first hours.
   */
  financials: LoadFinancials | null;
  timeline: LoadEvent[];
  notes: LoadNote[];
  documents: LoadDocument[];
  pickupAt: IsoDateTime;
  deliveryAt: IsoDateTime;
  etaAt: IsoDateTime | null;
  /** A person's ETA from a check call; stands in for the projection until a newer position. */
  manualEta?: { at: IsoDateTime; stopId: string | null; recordedAt: IsoDateTime; byName: string } | null;
  /** The second owner of a rolling load (rule 1.7). */
  updaterId?: string | null;
  updaterName?: string | null;
  milesRemaining: number | null;
  bookedAt: IsoDateTime;
  dispatchedAt: IsoDateTime | null;
  deliveredAt: IsoDateTime | null;
  invoiceId: string | null;
  /**
   * Set once a load has been handed from one driver to another mid-run. Until then a load has one
   * driver and needs no segments; after a recovery the miles and the linehaul belong to two
   * people, and pay has to follow the split rather than the name currently on the load.
   */
  segments?: LoadSegment[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** The road chosen from TollGuru's route options (owner, 2026-10-27); absent or null = none. */
  route?: ChosenRoute | null;
  /** Set on a recovery draft for the one write that carries it to the server; never stored. */
  recoveryEvent?: { fromDriverName: string; fromUnit: string; summary: string };
}

export type MaintenanceType =
  | 'oil_change'
  | 'pm_service'
  | 'brake_inspection'
  | 'brake_repair'
  | 'tire_rotation'
  | 'tire_replacement'
  | 'dot_inspection'
  | 'coolant'
  | 'transmission'
  | 'engine'
  | 'dpf'
  | 'battery'
  | 'electrical'
  // Trailer work: what breaks on a box that has no engine.
  | 'lights'
  | 'doors_seals'
  | 'floor_walls'
  | 'landing_gear'
  | 'suspension'
  | 'reefer_unit'
  | 'other';

export type MaintenanceStatus = Extract<
  StatusCode,
  'ok' | 'due_soon' | 'overdue' | 'scheduled' | 'in_shop'
>;

/** One PM schedule row (docs/DATABASE.md §3.9 `pm_schedules`). */
export interface MaintenanceItem {
  id: string;
  truckId: string;
  unitNumber: string;
  type: MaintenanceType;
  typeLabel: string;
  intervalMiles: number | null;
  intervalDays: number | null;
  lastDoneAt: IsoDate;
  lastDoneOdometer: number;
  nextDueAt: IsoDate;
  nextDueOdometer: number;
  /** Positive = miles left; negative = miles overdue. */
  milesUntilDue: number;
  daysUntilDue: number;
  status: MaintenanceStatus;
  scheduledFor: IsoDate | null;
  vendorName: string | null;
  /** The vendor record the shop was picked from. Null on rows booked before the picker existed. */
  vendorId?: string | null;
}

export type RepairOrderStatus = Extract<
  StatusCode,
  'draft' | 'open' | 'scheduled' | 'in_shop' | 'completed' | 'cancelled'
>;

/**
 * A file attached to a work order - the shop's invoice, almost always.
 *
 * Held as a data URL because this store has no file server; the same shape the load documents use.
 */
export interface WorkOrderInvoice {
  id: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  /** Where the bytes live in the file store (`/files/:id`). */
  fileUrl?: string;
  fileId?: string;
  /** The pre-file-store shape: the file inline as a data URL. Read, never written. */
  dataUrl?: string;
  uploadedAt: IsoDateTime;
  uploadedBy: string;
  /** What the paperwork says the work cost, when it differs from the estimate. */
  amount: number | null;
  /** As printed on the shop's invoice; optional because a photo of a paper bill may not show one. */
  invoiceNumber?: string | null;
  invoiceDate?: IsoDate | null;
}

/** Why a work order was completed with no invoice on file. */
export type NoInvoiceReason = 'warranty' | 'internal_shop' | 'invoice_to_follow' | 'lease_operator';

/**
 * Who pays for a repair.
 *
 * A repair on an owner-operator's or a lease driver's unit is their cost, not the carrier's.
 * Billing it to the company is how fleet spend and cost per mile stop describing the fleet.
 */
export interface WorkOrderBilling {
  party: 'company' | 'owner';
  /** The driver the owner's share is charged to; null when the company pays. */
  ownerDriverId: string | null;
  ownerDriverName: string | null;
  /**
   * What the company keeps of the total when the bill is split (warranty portions, goodwill,
   * "the company covers the tyres"). Null means the whole amount goes to `party`.
   */
  companyAmount: number | null;
  /** Why it is split; required whenever it is. */
  note: string | null;
  /** The deduction raised against the driver for their share, once there is one. */
  deductionPlanId: string | null;
  /** What the default was, so the person can see why it was suggested. */
  suggestedFrom: string;
}

export interface RepairOrder {
  id: string;
  roNumber: string;
  /** The walk-around defect this order was opened for, when it was (brief §4.5). The link, not the sentence. */
  defectId?: string | null;
  /**
   * The unit the order is about. A truck by default; `unitType: 'trailer'` with `trailerId` set
   * makes it a trailer order, and `truckId` is then empty — a trailer is not a truck, and an
   * order that pretended otherwise would put the trailer's cost on a truck's page.
   */
  truckId: string;
  unitType?: 'truck' | 'trailer';
  trailerId?: string | null;
  unitNumber: string;
  status: RepairOrderStatus;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  type: MaintenanceType;
  summary: string;
  /** The vendor as written; `vendorId` points at the record it was matched or chosen from. */
  vendorName: string;
  vendorId?: string | null;
  technician: string;
  openedAt: IsoDateTime;
  promisedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  /**
   * When the unit went back on the road.
   *
   * Distinct from `completedAt`, which is when the paperwork was settled: a truck released on
   * Tuesday whose invoice is entered on Friday was earning for three of those days. Without this
   * field downtime was measured from the invoice, which is why time out of service read long.
   * Required when a repair is written up as completed (Fleet specification §2.3).
   */
  backInServiceAt?: IsoDateTime | null;
  /**
   * Set when the order was completed without an invoice, on purpose and with a reason. Cleared
   * the moment an invoice is attached. Absent on orders completed the normal way.
   */
  awaitingInvoice?: { reason: NoInvoiceReason; note: string; at: IsoDateTime; by: string } | null;
  /** Who this repair is charged to. Absent means the company, as every order used to be. */
  billing?: WorkOrderBilling | null;
  odometer: number;
  downtimeMinutes: number;
  partsTotal: number;
  laborTotal: number;
  feesTotal: number;
  total: number;
  warranty: boolean;
  notes: string | null;
  /** The shop's paperwork. Empty until somebody uploads it. */
  invoices?: WorkOrderInvoice[];
}

/** A note somebody keeps on a unit. Not a repair and not an inspection. */
export interface TruckNote {
  id: string;
  truckId: string;
  body: string;
  authorName: string;
  at: IsoDateTime;
}

export interface ServiceRecord {
  id: string;
  truckId: string;
  unitNumber: string;
  type: MaintenanceType;
  typeLabel: string;
  description: string;
  doneAt: IsoDate;
  odometer: number;
  vendorName: string;
  cost: number;
  repairOrderId: string | null;
}

export type FuelAnomaly =
  'location_mismatch' | 'duplicate' | 'impossible_gallons' | 'excess_consumption' | 'off_hours';

export interface FuelTransaction {
  id: string;
  truckId: string;
  unitNumber: string;
  driverId: string;
  driverName: string;
  loadId: string | null;
  at: IsoDateTime;
  station: { brand: string; name: string; city: string; state: string };
  product: 'diesel' | 'def';
  gallons: number;
  pricePerGallon: number;
  amount: number;
  odometer: number;
  cardLast4: string;
  anomalyFlags: FuelAnomaly[];
  status: Extract<StatusCode, 'verified' | 'warning' | 'problem'>;
}

export type SafetyEventKind =
  'speeding' | 'hard_brake' | 'hard_acceleration' | 'following_distance' | 'seatbelt';

export type SafetySeverity = 'low' | 'medium' | 'high';

export interface SafetyEvent {
  id: string;
  driverId: string;
  driverName: string;
  truckId: string;
  unitNumber: string;
  at: IsoDateTime;
  kind: SafetyEventKind;
  severity: SafetySeverity;
  location: { city: string; state: string };
  speedMph: number | null;
  speedLimitMph: number | null;
  coached: boolean;
  dismissed: boolean;
  status: Extract<StatusCode, 'open' | 'completed' | 'closed'>;
}

/**
 * `invoices.status` (docs/DATABASE.md §3.13). `void` is a reversal, never a deletion — a set of
 * books that can lose a row cannot be audited.
 */
export type InvoiceStatus = Extract<
  StatusCode,
  'draft' | 'issued' | 'sent' | 'paid' | 'partially_paid' | 'overdue' | 'disputed' | 'void' | 'submitted' | 'accepted' | 'funded' | 'superseded'
>;

export type AgingBucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';

export interface Invoice {
  id: string;
  invoiceNumber: string;
  loadId: string;
  loadNumber: string;
  billToType: 'customer' | 'broker';
  billToId: string;
  billToName: string;
  issuedOn: IsoDate | null;
  dueOn: IsoDate | null;
  paymentTermsDays: number;
  subtotal: number;
  total: number;
  paid: number;
  balance: number;
  status: InvoiceStatus;
  agingDays: number;
  agingBucket: AgingBucket;
  paidOn: IsoDate | null;
  disputeReason: string | null;
}

export type EntityType =
  | 'load'
  | 'truck'
  | 'trailer'
  | 'driver'
  | 'invoice'
  | 'repair_order'
  | 'maintenance'
  | 'fuel_transaction'
  | 'safety_event'
  | 'customer'
  | 'broker'
  | 'employee'
  /** A recruiting candidate (opens the candidate's DOT application). */
  | 'applicant'
  /** A candidate waiting for Safety's Qualified / Not qualified decision (opens Safety › Hiring decisions). */
  | 'hiring_safety'
  | 'company';

export interface EntityRef {
  type: EntityType;
  id: string;
  label: string;
}

/**
 * What kind of operational event a notification reports. Distinct from `department` (which owns
 * it) and from `entity` (what it points at): a CDL expiry is owned by safety, points at a driver
 * and is a `document` event. Classified where the event is raised, so the UI never has to guess
 * from the title text.
 */
export type NotificationKind =
  | 'load'
  | 'dispatch'
  | 'fleet'
  | 'maintenance'
  | 'driver'
  | 'finance'
  | 'document'
  | 'system'
  | 'comment'
  | 'report';

export interface Notification {
  id: string;
  kind: NotificationKind;
  severity: Severity;
  title: string;
  body: string;
  department: Department;
  entity: EntityRef | null;
  source: 'system' | 'workflow' | 'ai' | 'user';
  /**
   * True when a person has to do something about this, not merely read it. An overdue PM service
   * is action-required; a payment that landed is not. Set at the point the event is raised, since
   * that is the only place the operational meaning is known.
   */
  actionRequired: boolean;
  at: IsoDateTime;
  readAt: IsoDateTime | null;
}

export type TaskStatus = Extract<StatusCode, 'open' | 'in_progress' | 'completed' | 'cancelled'>;

export interface Task {
  id: string;
  title: string;
  description: string;
  assigneeId: string;
  assigneeName: string;
  department: Department;
  entity: EntityRef | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: TaskStatus;
  dueAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  source: 'user' | 'workflow' | 'ai';
  createdAt: IsoDateTime;
}

export interface ActivityItem {
  id: string;
  at: IsoDateTime;
  actorId: string;
  actorName: string;
  department: Department;
  action:
    'create' | 'update' | 'status_change' | 'assign' | 'approve' | 'upload' | 'comment' | 'login';
  summary: string;
  entity: EntityRef | null;
}

export type AiInsightKind =
  | 'load.late_risk'
  | 'truck.mpg_drop'
  | 'truck.pm_due'
  | 'truck.recurring_defect'
  | 'driver.safety_trend'
  | 'fuel.anomaly'
  | 'ar.aging'
  | 'document.expiring'
  | 'company.profit_change'
  | 'company.fuel_cost';

export interface AiEvidence {
  label: string;
  value: string;
  entity: EntityRef | null;
}

export interface AiInsight {
  id: string;
  kind: AiInsightKind;
  severity: Severity;
  department: Department;
  scope: EntityRef;
  title: string;
  detail: string;
  evidence: AiEvidence[];
  recommendation: string;
  rationale: string;
  detector: string;
  confidence: number;
  openedAt: IsoDateTime;
  status: Extract<StatusCode, 'open' | 'in_progress' | 'closed'>;
  actionStatus: Extract<StatusCode, 'pending' | 'completed' | 'cancelled'> | null;
}

export interface KpiValue {
  value: number;
  previous: number;
  /** Percent change vs the previous period (e.g. 6.4 → +6.4%). */
  deltaPercent: number;
}

export interface KpiSnapshot {
  asOf: IsoDateTime;
  totalTrucks: KpiValue;
  activeTrucks: KpiValue;
  activeLoads: KpiValue;
  revenueMtd: KpiValue;
  profitMtd: KpiValue;
  criticalAlerts: KpiValue;
}

export interface TimeSeriesPoint {
  date: IsoDate;
  value: number;
}

export interface RevenueProfitPoint {
  date: IsoDate;
  revenue: number;
  profit: number;
}

export interface StatusCount {
  status: StatusCode;
  label: string;
  count: number;
}

export interface DashboardSeries {
  dailyRevenueProfit: RevenueProfitPoint[];
  weeklyFuelCost: TimeSeriesPoint[];
  fleetHealth: StatusCount[];
  loadStatus: StatusCount[];
}

// ---------------------------------------------------------------------------------------------
// Safety & compliance (docs/DATABASE.md §3.10, §3.11). The requirement catalog and the
// qualification items are typed in @neway/shared so the compliance engine there can evaluate
// them; the entities below are what those items point at.
// ---------------------------------------------------------------------------------------------

/** Owner types a compliance document can attach to (`documents.owner_type`). */
/*
 * The qualification file's records — documents, consents, verification cases — are contracts in
 * @neway/shared now that compliance storage moved to PostgreSQL. Re-exported so the demo layer
 * keeps one vocabulary with the API; nothing here defines a second copy of them.
 */
export type {
  ComplianceDocument,
  ComplianceDocumentStatus,
  ComplianceOwnerType,
  ConsentEvent,
  ConsentPurpose,
  ConsentRequest,
  ConsentStatus,
  DocumentSource,
  VerificationCase,
  VerificationDecision,
  VerificationStage,
  VerificationStep,
  VerificationStepStatus,
} from '@neway/shared';

export type ComplianceAuditAction =
  | 'document_uploaded'
  | 'document_verified'
  | 'document_rejected'
  | 'item_updated'
  | 'item_waived'
  | 'hold_placed'
  | 'hold_released'
  | 'consent_sent'
  | 'consent_signed'
  | 'consent_declined'
  | 'verification_advanced'
  | 'decision_recorded'
  | 'status_changed';

/** Who changed what, when, from what to what, and why (docs/RBAC.md audit stream). */
export interface ComplianceAuditEntry {
  id: string;
  at: IsoDateTime;
  actorId: string;
  actorName: string;
  action: ComplianceAuditAction;
  entity: EntityRef;
  /** The requirement or document the change concerns, when there is one. */
  subject: string | null;
  before: string | null;
  after: string | null;
  reason: string | null;
  source: 'user' | 'system' | 'workflow' | 'integration';
}
