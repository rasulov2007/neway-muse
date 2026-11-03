import { z } from 'zod';

/**
 * Booking a load.
 *
 * The fields here are the ones the operations engines need to judge the load the moment it exists:
 * a rate and both mile figures so the cost engine can restate it on total miles, and both
 * appointments so the risk engine has a window to measure an ETA against. Anything the system can
 * derive — load number, status, timeline, stop ids — is not asked for.
 */

export const EQUIPMENT_OPTIONS = [
  { value: 'dry_van', label: 'Dry van' },
  { value: 'reefer', label: 'Reefer' },
  { value: 'flatbed', label: 'Flatbed' },
] as const;

const requiredText = (field: string) => z.string().trim().min(1, `${field} is required`);

/** Two-letter USPS state code, so lanes match the rest of the dataset. */
const stateCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use the two-letter state code');

/** Optional: five digits, or ZIP+4. */
const zipCode = z
  .string()
  .trim()
  .regex(/^(\d{5}(-\d{4})?)?$/, 'ZIP is five digits')
  .optional();

/** Live or drop at a stop; a form that never set it means Live. */
const stopHandling = z.enum(['live', 'drop']).optional();

/**
 * An empty numeric field is empty, not zero.
 *
 * The form used to start every money and mileage box at `0`, which a person then has to select and
 * delete before typing — and a zero left behind reads as a real figure. Blank stays blank, and the
 * field's own rule decides whether blank is allowed.
 */
function emptyToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (value === '' || value === null || Number.isNaN(value) ? undefined : value),
    schema,
  );
}

export const loadFormSchema = z
  .object({
    /** The number on the rate confirmation. Left blank, the next number in the sequence is used. */
    loadNumber: z.string().trim().max(24, 'That load number is too long').optional(),
    /**
     * Booking offers only the two states a load can start in. Editing has to accept whatever
     * state the load is already in, including the ones reached by dispatch or by paperwork —
     * a form that cannot represent its own record is a form that silently rewrites it.
     */
    status: z.enum([
      'booked',
      'assigned',
      'dispatched',
      'at_pickup',
      'loading',
      'loaded',
      'in_transit',
      'at_delivery',
      'unloading',
      'delivered',
      'closed',
      'cancelled',
      'tonu',
    ]),
    // Optional: a load often arrives from a broker before anybody knows whose freight it is.
    customerId: z.string().optional(),
    brokerId: z.string().optional(),
    brokerReference: z.string().trim().max(40).optional(),
    // Optional for the same reason: the rate confirmation does not always say what is on it.
    commodity: z.string().trim().max(80).optional(),
    // Optional (owner, 2026-09-22): the rate confirmation does not always carry a weight.
    weightLbs: emptyToUndefined(
      z.coerce.number().int().min(1).max(80_000, 'Gross weight cannot exceed 80,000 lb'),
    ).optional(),
    // Optional (owner, 2026-10-13): the RC does not always say; blank stays blank.
    equipmentType: z.enum(['dry_van', 'reefer', 'flatbed']).or(z.literal('')),
    hazmat: z.boolean(),
    rate: emptyToUndefined(z.coerce.number().min(1, 'Rate is required').max(1_000_000)),
    /**
     * What the driver is paid on (owner, 2026-10-23): blank means the same as the rate. The
     * invoice to the broker always bills the rate above; driver pay reads this.
     */
    driverRate: emptyToUndefined(z.coerce.number().min(0).max(1_000_000)).optional(),
    loadedMiles: emptyToUndefined(
      z.coerce.number().int().min(1, 'Loaded miles are required').max(10_000),
    ),
    emptyMiles: emptyToUndefined(z.coerce.number().int().min(0).max(10_000)).optional(),
    /** The street or facility line of the stop; the city and state stay their own fields. */
    originStreet: z.string().trim().max(120).optional(),
    /** The facility's own name (shipper / receiver), apart from its street (owner, 2026-10-13). */
    originFacility: z.string().trim().max(120).optional(),
    originCity: requiredText('Origin city'),
    originState: stateCode,
    originZip: zipCode,
    destinationStreet: z.string().trim().max(120).optional(),
    destinationFacility: z.string().trim().max(120).optional(),
    destinationCity: requiredText('Destination city'),
    destinationState: stateCode,
    destinationZip: zipCode,
    pickupAt: requiredText('Pickup appointment'),
    /** End of the window, wall clock at the stop. Blank means the customer gave one time (P0.4). */
    pickupEndAt: z.string().optional(),
    deliveryAt: requiredText('Delivery appointment'),
    deliveryEndAt: z.string().optional(),
    /** Live or drop at the stop (owner, 2026-10-25); Live unless somebody says otherwise. */
    originHandling: stopHandling,
    destinationHandling: stopHandling,
    // Intermediate stops between the first pickup and the final delivery.
    extraStops: z
      .array(
        z.object({
          kind: z.enum(['pickup', 'delivery']),
          street: z.string().trim().max(120).optional(),
          facility: z.string().trim().max(120).optional(),
          city: requiredText('City'),
          state: stateCode,
          zip: zipCode,
          at: requiredText('Appointment'),
          endAt: z.string().optional(),
          handling: stopHandling,
        }),
      )
      .max(6)
      .optional(),
    // Assignment at booking time, exactly as the old TMS allowed. All optional: a load can be
    // booked before anybody is on it.
    driverId: z.string().optional(),
    /** Team driving: the second driver on the load; pay is shared, never doubled. */
    coDriverId: z.string().optional(),
    truckId: z.string().optional(),
    trailerId: z.string().optional(),
    dispatcherId: z.string().optional(),
    /** The second owner of a rolling load (rule 1.7). */
    updaterId: z.string().optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .refine((values) => new Date(values.deliveryAt).getTime() > new Date(values.pickupAt).getTime(), {
    path: ['deliveryAt'],
    message: 'Delivery must be after pickup',
  });

export type LoadFormValues = z.infer<typeof loadFormSchema>;

/**
 * What the fields hold while somebody is typing, before the schema has coerced anything.
 *
 * Money and mileage are text in the DOM and empty when untouched; the parsed values are numbers.
 * Defaults belong to this shape, not to the parsed one.
 */
export type LoadFormInput = z.input<typeof loadFormSchema>;

/**
 * Revenue per total mile at the entered numbers. Shown live while booking, because that is the
 * figure that decides whether a load is worth taking, and it is not the RPM on the rate con.
 */
export function previewRevenuePerTotalMile(
  rate: number,
  loadedMiles: number,
  emptyMiles: number,
): number | null {
  const total = (loadedMiles || 0) + (emptyMiles || 0);
  if (!rate || total <= 0) return null;
  return Math.round((rate / total) * 100) / 100;
}
