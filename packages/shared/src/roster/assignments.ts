import { z } from 'zod';

/**
 * A driver in a truck: since when, and what went with the unit (owner's ask, 2026-09-21).
 *
 * The open record is the single source of truth (0047): `trucks.currentDriverId` and
 * `drivers.currentTruckId` are kept in step with it in the same transaction by every writer (the
 * truck page, the driver page, truck creation), and the database allows one open record per truck
 * and per driver. A record closes when the driver leaves or is replaced and is never deleted.
 */

/** The things handed over with a unit. `other` carries its own label. */
export const ASSIGNMENT_ITEMS = ['tablet', 'gps', 'eld', 'fuel_card', 'toll_tag', 'keys', 'other'] as const;
export type AssignmentItem = (typeof ASSIGNMENT_ITEMS)[number];
export const ASSIGNMENT_ITEM_LABEL: Record<AssignmentItem, string> = {
  tablet: 'Tablet',
  gps: 'GPS',
  eld: 'ELD',
  fuel_card: 'Fuel card',
  toll_tag: 'Toll tag',
  keys: 'Keys',
  other: 'Other',
};

export const AssignmentEquipmentSchema = z.object({
  item: z.enum(ASSIGNMENT_ITEMS),
  /** Shown; for `other` it is whatever was typed. */
  label: z.string().trim().min(1).max(60),
  /** Serial, model, tag number — free text. */
  detail: z.string().trim().max(200).nullable(),
  /** Handed over at pickup; in a returned list, came back at drop. */
  handedOver: z.boolean(),
});
export type AssignmentEquipment = z.infer<typeof AssignmentEquipmentSchema>;

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the date');

/** The image types a pickup or drop photo may be (phone cameras: JPEG, HEIC; screenshots: PNG, WebP). */
export const ASSIGNMENT_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
/** Each photo is capped below the 25 MB file limit: a phone photo is 2–8 MB. */
export const ASSIGNMENT_PHOTO_MAX_BYTES = 15 * 1024 * 1024;
export const ASSIGNMENT_PHOTO_MAX_COUNT = 12;

export const AssignmentPhotoStageSchema = z.enum(['pickup', 'drop']);
export type AssignmentPhotoStage = z.infer<typeof AssignmentPhotoStageSchema>;

/** A photo linked to an assignment: taken when the driver picked the unit up, or dropped it. */
export const AssignmentPhotoSchema = z.object({
  id: z.string(),
  stage: AssignmentPhotoStageSchema,
  fileId: z.string(),
  /** The path the client fetches the bytes from. */
  url: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  uploadedByName: z.string(),
  uploadedAt: z.string(),
});
export type AssignmentPhoto = z.infer<typeof AssignmentPhotoSchema>;

/** What `POST /trucks/:id/assignment/photos` answers: a stored image, not linked to anything yet. */
export const AssignmentPhotoUploadSchema = z.object({
  fileId: z.string(),
  url: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
});
export type AssignmentPhotoUpload = z.infer<typeof AssignmentPhotoUploadSchema>;

export const UploadAssignmentPhotoSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  /** A whole `data:image/...;base64,` URL. */
  content: z.string().min(1),
});
export type UploadAssignmentPhotoInput = z.infer<typeof UploadAssignmentPhotoSchema>;

const PhotoIds = z.array(z.string().min(1)).max(ASSIGNMENT_PHOTO_MAX_COUNT).default([]);

/** Where an assignment row came from. */
export const ASSIGNMENT_SOURCES = ['truck_page', 'driver_page', 'truck_create', 'backfill'] as const;

export const TruckDriverAssignmentSchema = z.object({
  id: z.string(),
  truckId: z.string(),
  unitNumber: z.string(),
  driverId: z.string(),
  driverName: z.string(),
  driverNumber: z.string(),
  /** `YYYY-MM-DD` in the company calendar. */
  assignedOn: z.string(),
  endedOn: z.string().nullable(),
  endReason: z.string().nullable(),
  equipment: z.array(AssignmentEquipmentSchema),
  note: z.string().nullable(),
  version: z.number().int(),
  createdByName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The start date was reconstructed (backfill) and is shown as "about <date>". */
  assignedOnApproximate: z.boolean(),
  source: z.string(),
  /** What came back with the unit at drop (`handedOver` = returned); null until the drop is recorded. */
  returnedEquipment: z.array(AssignmentEquipmentSchema).nullable(),
  dropNote: z.string().nullable(),
  endedByName: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** Who last edited the record after it was written, and when; null when never edited. */
  editedByName: z.string().nullable(),
  editedAt: z.string().nullable(),
  pickupPhotos: z.array(AssignmentPhotoSchema),
  dropPhotos: z.array(AssignmentPhotoSchema),
});
export type TruckDriverAssignment = z.infer<typeof TruckDriverAssignmentSchema>;

export const TruckAssignmentViewSchema = z.object({
  current: TruckDriverAssignmentSchema.nullable(),
  /** Closed assignments, newest first. */
  history: z.array(TruckDriverAssignmentSchema),
});
export type TruckAssignmentView = z.infer<typeof TruckAssignmentViewSchema>;

/** The drop of the driver a new assignment replaces on the same unit (Change). */
export const DropDetailsSchema = z.object({
  /** The day the unit came back. Not before that driver's start, not in the future. */
  endedOn: IsoDay,
  /** The handed-over list with `handedOver` meaning "returned"; serials may be corrected. */
  returnedEquipment: z.array(AssignmentEquipmentSchema).default([]),
  dropNote: z.string().trim().max(1000).nullable().optional(),
  dropPhotoIds: PhotoIds,
});
export type DropDetailsInput = z.infer<typeof DropDetailsSchema>;
export type DropDetailsRequest = z.input<typeof DropDetailsSchema>;

export const AssignDriverSchema = z.object({
  driverId: z.string().min(1, 'Pick the driver'),
  assignedOn: IsoDay,
  equipment: z.array(AssignmentEquipmentSchema).default([]),
  note: z.string().trim().max(1000).nullable().optional(),
  pickupPhotoIds: PhotoIds,
  /**
   * The open assignment the caller saw on this unit (null: none). When given, a unit whose open
   * assignment is something else by now is a 409, never a silent replace.
   */
  expectedCurrentId: z.string().nullable().optional(),
  /** The replaced driver's drop, when the unit had one (Change). */
  previousDrop: DropDetailsSchema.optional(),
});
export type AssignDriverInput = z.infer<typeof AssignDriverSchema>;
export type AssignDriverRequest = z.input<typeof AssignDriverSchema>;

/**
 * An edit to any assignment, open or closed: every field the record holds, with the same rules as
 * when it was written. Version-checked; audited with before and after.
 */
export const UpdateAssignmentSchema = z.object({
  version: z.number().int(),
  assignedOn: IsoDay.optional(),
  equipment: z.array(AssignmentEquipmentSchema).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  /** Closed assignments only. */
  endedOn: IsoDay.optional(),
  returnedEquipment: z.array(AssignmentEquipmentSchema).optional(),
  dropNote: z.string().trim().max(1000).nullable().optional(),
  addPickupPhotoIds: z.array(z.string().min(1)).max(ASSIGNMENT_PHOTO_MAX_COUNT).optional(),
  addDropPhotoIds: z.array(z.string().min(1)).max(ASSIGNMENT_PHOTO_MAX_COUNT).optional(),
  /** Photos taken off the record (voided, kept). */
  removePhotoIds: z.array(z.string().min(1)).optional(),
});
export type UpdateAssignmentInput = z.infer<typeof UpdateAssignmentSchema>;

export const EndAssignmentSchema = z.object({
  version: z.number().int(),
  /** The drop date; the company's today when absent. Not before the start, not in the future. */
  endedOn: IsoDay.optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  returnedEquipment: z.array(AssignmentEquipmentSchema).optional(),
  dropNote: z.string().trim().max(1000).nullable().optional(),
  dropPhotoIds: PhotoIds,
});
export type EndAssignmentInput = z.infer<typeof EndAssignmentSchema>;
export type EndAssignmentRequest = z.input<typeof EndAssignmentSchema>;

/** Voiding a closed assignment entered by mistake or as a test: hidden, kept, audited with the reason. */
export const VoidAssignmentSchema = z.object({
  version: z.number().int(),
  reason: z.string().trim().min(3, 'Say why this entry is being voided').max(500),
});
export type VoidAssignmentInput = z.infer<typeof VoidAssignmentSchema>;
