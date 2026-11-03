import { z } from 'zod';

/**
 * Tire positions (owner brief, 2026-10-13): which wheel positions fail most across the fleet.
 *
 * One layout today - a 3-axle tractor (steer + two drive axles) pulling a 2-axle trailer, 18
 * positions - kept as data so another axle layout is a second entry here, not a rewrite. L is the
 * driver side, R the passenger side; O / I are the outer and inner tire of a dual.
 */

export const TIRE_GROUPS = ['steer', 'drive', 'trailer'] as const;
export type TireGroup = (typeof TIRE_GROUPS)[number];

export type TireAxleId = 'S' | 'D1' | 'D2' | 'T1' | 'T2';
export interface TireAxle {
  id: TireAxleId;
  group: TireGroup;
  label: string;
  /** Duals: four tires (LO, LI, RI, RO); otherwise one per side. */
  duals: boolean;
}

export const TIRE_AXLES: readonly TireAxle[] = [
  { id: 'S', group: 'steer', label: 'Steer', duals: false },
  { id: 'D1', group: 'drive', label: 'Drive 1', duals: true },
  { id: 'D2', group: 'drive', label: 'Drive 2', duals: true },
  { id: 'T1', group: 'trailer', label: 'Trailer 1', duals: true },
  { id: 'T2', group: 'trailer', label: 'Trailer 2', duals: true },
];

/**
 * How a roman (or plain) axle number on a record reads, by the kind of unit it was written on.
 * Default: a tractor's I is the steer, II and III the drive axles; a trailer's I and II its axles.
 */
export const TIRE_AXLE_NUMBERING: Record<'truck' | 'trailer', Partial<Record<number, TireAxleId>>> = {
  truck: { 1: 'S', 2: 'D1', 3: 'D2' },
  trailer: { 1: 'T1', 2: 'T2' },
};

export type TireSide = 'L' | 'R';
export type TireDual = 'O' | 'I';

export const TIRE_POSITION_IDS = [
  'S-L', 'S-R',
  'D1-LO', 'D1-LI', 'D1-RI', 'D1-RO',
  'D2-LO', 'D2-LI', 'D2-RI', 'D2-RO',
  'T1-LO', 'T1-LI', 'T1-RI', 'T1-RO',
  'T2-LO', 'T2-LI', 'T2-RI', 'T2-RO',
] as const;
export type TirePositionKey = (typeof TIRE_POSITION_IDS)[number];
export const UNASSIGNED_TIRE = 'UNASSIGNED' as const;
export const TirePositionIdSchema = z.enum([...TIRE_POSITION_IDS, UNASSIGNED_TIRE]);
export type TirePositionId = z.infer<typeof TirePositionIdSchema>;

export interface TirePosition {
  id: TirePositionKey;
  axle: TireAxleId;
  group: TireGroup;
  side: TireSide;
  dual: TireDual | null;
}

export const TIRE_POSITIONS: readonly TirePosition[] = TIRE_POSITION_IDS.map((id) => {
  const [axle, rest] = id.split('-') as [TireAxleId, string];
  const group = TIRE_AXLES.find((a) => a.id === axle)!.group;
  return { id, axle, group, side: rest[0] as TireSide, dual: (rest[1] as TireDual | undefined) ?? null };
});

export const TIRE_GROUP_LABEL: Record<TireGroup, string> = { steer: 'Steer', drive: 'Drive', trailer: 'Trailer' };
export const TIRE_GROUP_SIZE: Record<TireGroup, number> = { steer: 2, drive: 8, trailer: 8 };

const SIDE_WORD: Record<TireSide, string> = { L: 'Left', R: 'Right' };
const DUAL_WORD: Record<TireDual, string> = { O: 'outer', I: 'inner' };

/** "Steer · Left", "Drive 1 · Left outer", "Unassigned". */
export function tirePositionLabel(id: TirePositionId): string {
  if (id === UNASSIGNED_TIRE) return 'Unassigned';
  const p = TIRE_POSITIONS.find((x) => x.id === id)!;
  const axle = TIRE_AXLES.find((a) => a.id === p.axle)!.label;
  return `${axle} · ${SIDE_WORD[p.side]}${p.dual ? ` ${DUAL_WORD[p.dual]}` : ''}`;
}

/** The table chip: "Steer L", "Drive 1 RO", "Trailer 2 LO". */
export function tirePositionChip(id: TirePositionId): string {
  if (id === UNASSIGNED_TIRE) return 'Unassigned';
  const p = TIRE_POSITIONS.find((x) => x.id === id)!;
  return `${TIRE_AXLES.find((a) => a.id === p.axle)!.label} ${p.side}${p.dual ?? ''}`;
}

export const TIRE_EVENT_TYPES = ['replaced', 'blowout', 'repaired'] as const;
export type TireEventType = (typeof TIRE_EVENT_TYPES)[number];
export const TIRE_EVENT_TYPE_LABEL: Record<TireEventType, string> = {
  replaced: 'Replaced',
  blowout: 'Blowouts',
  repaired: 'Patched / repaired',
};

export const TIRE_WINDOWS = ['7d', '30d', '90d', '12m'] as const;
export type TireWindow = (typeof TIRE_WINDOWS)[number];
export const TIRE_WINDOW_LABEL: Record<TireWindow, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '12 months' };

// ------------------------------------------------------------------------------------- parser

/** Bumped whenever the rules change, so text read by older rules is read again. */
export const TIRE_PARSER_VERSION = 3;

export interface ParsedTireEvent {
  positionId: TirePositionId;
  eventType: TireEventType;
  quantity: number;
  /** 0-1: how sure the rules are. Unassigned is always low. */
  confidence: number;
  /** Why it is unassigned, or what was read, for the person tagging it by hand. */
  note: string | null;
}

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
/** "two drive tires" is a count, not "all of them". */
const WORDS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, TEN: 10, TWELVE: 12, PAIR: 2, BOTH: 2 };

const TIRE_WORD = /\bTIRES?\b|\bTYRES?\b|BLOW\s?-?OUTS?\b|\bBLOWN\b|\bBLEW\b|\bSTEM\s+VALVES?\b/;
const BLOWOUT = /BLOW\s?-?OUTS?\b|\bBLOWN\b|\bBLEW\b/;
const REPLACED = /\bNEW\b|\bREPLAC|\bUSED\b|\bINSTALL|\bMOUNT/;
const REPAIRED = /\bPATCH|\bPLUG|\bREPAIR|\bSTEM\s+VALVE|\bFIX/;
const CHECK_ONLY = /\bCHECK|\bPSI\b|\bPRESSURE\b|\bROTAT|\bALIGN|\bINSPECT|\bBALANC/;

function axleNumber(u: string): number | null {
  const m =
    /\b(III|II|IV|V|I|[1-5])(?:ST|ND|RD|TH)?\s+AXLE\b/.exec(u) ?? /\bAXLE\s*#?\s*(III|II|IV|V|I|[1-5])\b/.exec(u);
  if (!m) return null;
  const v = m[1]!;
  return ROMAN[v] ?? Number(v);
}

function describe(axles: TireAxleId[], side: TireSide | null, dual: TireDual | null): string {
  const names = axles.map((a) => TIRE_AXLES.find((x) => x.id === a)!.label).join(' or ');
  return [names, side ? SIDE_WORD[side] : null, dual ? DUAL_WORD[dual] : null].filter(Boolean).join(' · ');
}

/**
 * Reads tire work out of a free-text repair description, by rules only (no AI), so the same text
 * always reads the same way. A tire whose axle or side is not said is UNASSIGNED with low
 * confidence: the rules never guess a position silently.
 */
export function parseTireText(text: string | null | undefined, unitKind: 'truck' | 'trailer' | null): ParsedTireEvent[] {
  if (!text || !text.trim()) return [];
  const clauses = text
    .split(/[·•;,\n]+|\s+-\s+/)
    .flatMap((c) => c.split(/(?=\b(?:trk|trl)\b)/i))
    .map((c) => c.trim())
    .filter(Boolean);
  const out: ParsedTireEvent[] = [];
  for (const clause of clauses) {
    const u = ` ${clause.toUpperCase()} `;
    if (!TIRE_WORD.test(u)) continue;
    // A check, rotation or alignment is not a tire event - unless the clause also replaces or fixes one.
    if (CHECK_ONLY.test(u) && !BLOWOUT.test(u) && !REPLACED.test(u) && !REPAIRED.test(u)) continue;

    const eventType: TireEventType = BLOWOUT.test(u) ? 'blowout' : REPLACED.test(u) ? 'replaced' : REPAIRED.test(u) ? 'repaired' : 'replaced';

    // Quantity: "2 tires", "8 drive tires", "2 new tire"; plural with no number = the whole group.
    const qm = /\b(\d{1,2}|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|TEN|TWELVE|PAIR|BOTH)\s*(?:X\s*)?(?:OF\s+)?(?:(?:NEW|USED|STEER|DRIVE|TRAILER|TRL|RECAP|RETREAD)\s+)*(?:TIRES?|TYRES?)\b/.exec(u);
    const plural = /\bTIRES\b|\bTYRES\b/.test(u);
    const quantity: number | 'all' = qm ? Math.max(1, WORDS[qm[1]!] ?? Number(qm[1])) : plural ? 'all' : 1;
    const unassigned = (note: string): ParsedTireEvent => ({
      positionId: UNASSIGNED_TIRE,
      eventType,
      quantity: quantity === 'all' ? 1 : quantity,
      confidence: 0.3,
      note,
    });

    // Which unit the clause is about. Trailer work belongs to the trailer, not the truck pulling it.
    const saysTrailer = /\bTRL\b|\bTRAILER\b/.test(u);
    const saysTruck = /\bTRK\b|\bTRUCK\b|\bTRACTOR\b/.test(u);
    const kind = saysTrailer ? 'trailer' : saysTruck ? 'truck' : unitKind;
    if (unitKind && kind !== unitKind) {
      out.push(unassigned(kind === 'trailer' ? 'A trailer tire written on a truck record' : 'A truck tire written on a trailer record'));
      continue;
    }

    // Shorthand. Two letters: LF / RF = steer. Three letters name a dual on a tandem, by the shop
    // convention: F = the forward axle, R = the rear one (a tractor's drives, a trailer's axles),
    // then I / O - RRI = right rear inner, LFO = left front outer.
    const code = /\b([LR])([FR])([IO])?\b/.exec(u);
    let side: TireSide | null = code ? (code[1] as TireSide) : null;
    let dual: TireDual | null = code?.[3] ? (code[3] as TireDual) : null;
    if (!side) {
      if (/\b(LH|LEFT|DRIVER'?S?|DS|L)\b/.test(u)) side = 'L';
      else if (/\b(RH|RIGHT|PASSENGER|PS|R)\b/.test(u)) side = 'R';
    }
    if (!dual) {
      if (/\b(OUTER|OUTSIDE)\b|\b(?:LH|RH|L|R|LEFT|RIGHT)\s+OUT\b/.test(u)) dual = 'O';
      else if (/\b(INNER|INSIDE)\b|\b(?:LH|RH|L|R|LEFT|RIGHT)\s+IN\b/.test(u)) dual = 'I';
    }

    let axles: TireAxleId[] = [];
    let readNote: string | null = null;
    const n = axleNumber(u);
    if (code?.[3] && n === null && kind) {
      const forward = code[2] === 'F';
      axles = [kind === 'trailer' ? (forward ? 'T1' : 'T2') : forward ? 'D1' : 'D2'];
      readNote = `${code[0]} read as ${TIRE_AXLES.find((a) => a.id === axles[0])!.label} (${forward ? 'forward' : 'rear'} axle of the tandem)`;
    } else if (n !== null) {
      const a = kind ? TIRE_AXLE_NUMBERING[kind][n] : undefined;
      if (!a) {
        out.push(unassigned(kind ? `Axle ${n} is not on a ${kind} in this layout` : `Axle ${n}, but the unit kind is unknown`));
        continue;
      }
      axles = [a];
    } else if (/\bSTEER\b/.test(u) || code?.[2] === 'F') {
      axles = ['S'];
    } else if (/\bDRIVE\b/.test(u)) {
      axles = ['D1', 'D2'];
    } else if (saysTrailer && kind === 'trailer' && /\bTRAILER\s+TIRES?\b|\bTRL\s+TIRES?\b/.test(u)) {
      axles = ['T1', 'T2'];
    } else if (code?.[2] === 'R') {
      axles = kind === 'trailer' ? ['T1', 'T2'] : kind === 'truck' ? ['D1', 'D2'] : [];
    }
    if (code?.[2] === 'F' && !code[3] && kind === 'trailer') axles = ['T1'];
    if (axles.length === 0) {
      out.push(unassigned(side ? `${SIDE_WORD[side]} side, axle not said` : 'Position not said'));
      continue;
    }
    if (kind === 'trailer' && axles.some((a) => a === 'S' || a === 'D1' || a === 'D2')) {
      out.push(unassigned('A steer or drive tire on a trailer record'));
      continue;
    }

    const candidates = TIRE_POSITIONS.filter(
      (p) => axles.includes(p.axle) && (!side || p.side === side) && (!dual || p.dual === null || p.dual === dual),
    );
    const count = quantity === 'all' ? candidates.length : quantity;
    const sure = readNote ? 0.7 : 0.9;
    if (count === candidates.length) {
      for (const p of candidates) out.push({ positionId: p.id, eventType, quantity: 1, confidence: sure, note: readNote });
    } else if (candidates.length === 1) {
      out.push({ positionId: candidates[0]!.id, eventType, quantity: count, confidence: count === 1 ? sure : 0.6, note: count === 1 ? readNote : `${count} tires on one position` });
    } else {
      out.push(unassigned(`${describe(axles, side, dual)} - ${dual || !axles.some((a) => a !== 'S') ? 'which tire' : 'inner or outer'} not said`));
    }
  }
  return out;
}

/** Splits the record's tire amount over its events by quantity, to the cent; the last takes the rounding. */
export function allocateTireCost<T extends { quantity: number }>(events: T[], amountCents: number): Array<T & { costCents: number }> {
  const total = events.reduce((s, e) => s + e.quantity, 0);
  if (total === 0) return events.map((e) => ({ ...e, costCents: 0 }));
  let left = amountCents;
  return events.map((e, i) => {
    const cents = i === events.length - 1 ? left : Math.round((amountCents * e.quantity) / total);
    left -= cents;
    return { ...e, costCents: cents };
  });
}

// ---------------------------------------------------------------------------------- the wire

/** What was done to one tire on a tire work order (owner mockup, 2026-10-14). */
export const TIRE_ACTIONS = ['new', 'used', 'repair', 'valve', 'rotate'] as const;
export type TireAction = (typeof TIRE_ACTIONS)[number];

export const TireEventSchema = z.object({
  id: z.string(),
  recordKind: z.enum(['work_order', 'service_record', 'fleet_expense']),
  recordId: z.string(),
  positionId: TirePositionIdSchema,
  eventType: z.enum(TIRE_EVENT_TYPES),
  quantity: z.number().int().positive(),
  costCents: z.number().int(),
  source: z.enum(['parsed', 'manual']),
  confidence: z.number(),
  note: z.string().nullable(),
  /** The unit that owns the tire (a trailer's tire is the trailer's, whatever order it was on). */
  unitId: z.string().optional(),
  unitKind: z.enum(['truck', 'trailer']).nullable().optional(),
  recordedOnUnitId: z.string().nullable().optional(),
  eventOn: z.string().nullable().optional(),
  action: z.enum(TIRE_ACTIONS).nullable().optional(),
  brand: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  treadRemoved32: z.number().nullable().optional(),
  tireCostCents: z.number().nullable().optional(),
  laborCents: z.number().nullable().optional(),
  odometer: z.number().nullable().optional(),
  vendorName: z.string().nullable().optional(),
});
export type TireEvent = z.infer<typeof TireEventSchema>;

export interface TirePositionsResponse {
  events: TireEvent[];
}

export const TireTagInputSchema = z.object({
  /** The record's active event ids as the tagger saw them: a stale tag is refused, never merged. */
  basis: z.array(z.string()),
  unitId: z.string().default(''),
  unitKind: z.enum(['truck', 'trailer']).nullable().default(null),
  events: z
    .array(
      z.object({
        positionId: TirePositionIdSchema,
        eventType: z.enum(TIRE_EVENT_TYPES),
        quantity: z.number().int().positive().max(18).default(1),
      }),
    )
    .min(1, 'Pick at least one position')
    .max(19),
});
export type TireTagInput = z.infer<typeof TireTagInputSchema>;

export const TIRE_ACTION_LABEL: Record<TireAction, string> = {
  new: 'Replace · new',
  used: 'Replace · used',
  repair: 'Repair · patch',
  valve: 'Repair · valve/stem',
  rotate: 'Rotate',
};
export const TIRE_REASONS = ['Worn tread', 'Puncture / road hazard', 'Sidewall damage', 'Blowout', 'Irregular wear', 'Flat spot', 'Valve / stem leak', 'Failed inspection'] as const;
export const TIRE_DAMAGE_REASONS: readonly string[] = ['Puncture / road hazard', 'Sidewall damage', 'Blowout'];
/** The tires a fleet buys, by group, with a usual price - a starting point the shop's invoice overrides. */
export const TIRE_CATALOG: Record<TireGroup, { brand: string; model: string; cents: number }[]> = {
  steer: [
    { brand: 'Michelin', model: 'X Line Energy Z', cents: 59_000 },
    { brand: 'Bridgestone', model: 'R284 Ecopia', cents: 54_500 },
    { brand: 'Continental', model: 'HSR2', cents: 52_000 },
  ],
  drive: [
    { brand: 'Michelin', model: 'X Line Energy D', cents: 53_500 },
    { brand: 'Goodyear', model: 'G399 LHD', cents: 49_500 },
    { brand: 'Bridgestone', model: 'M726 ELA', cents: 50_500 },
    { brand: 'Double Coin', model: 'RLB490', cents: 31_800 },
  ],
  trailer: [
    { brand: 'Bridgestone', model: 'R197', cents: 37_200 },
    { brand: 'Goodyear', model: 'G316 LHT', cents: 35_600 },
    { brand: 'Double Coin', model: 'RT600', cents: 24_800 },
  ],
};
export const actionEventType = (action: TireAction, reason: string | null | undefined): TireEventType =>
  action === 'repair' || action === 'valve' ? 'repaired' : reason === 'Blowout' ? 'blowout' : 'replaced';

/** What the work order form sends with a tire repair: the positions, prefilled by the parser. */
export const WorkOrderTirePositionSchema = z.object({
  positionId: TirePositionIdSchema,
  eventType: z.enum(TIRE_EVENT_TYPES),
  quantity: z.number().int().positive().max(18).default(1),
  /** Tire work order details: what was done to this tire and what it cost. */
  action: z.enum(TIRE_ACTIONS).optional(),
  brand: z.string().trim().max(80).nullable().optional(),
  model: z.string().trim().max(80).nullable().optional(),
  reason: z.string().trim().max(80).nullable().optional(),
  treadRemoved32: z.number().min(0).max(32).nullable().optional(),
  tireCostCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  laborCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  /** A trailer's tire on a truck's order belongs to the trailer. */
  ownerUnitId: z.string().min(1).nullable().optional(),
  ownerUnitKind: z.enum(['truck', 'trailer']).nullable().optional(),
});
export type WorkOrderTirePosition = z.infer<typeof WorkOrderTirePositionSchema>;

// ------------------------------------------------------------------------------- the figures

export interface TireRecordRef {
  /** `${kind}:${id}` */
  key: string;
  date: string;
  unitId: string;
  unitNumber: string;
}

export interface TirePositionStat {
  id: TirePositionKey;
  count: number;
  costCents: number;
  sharePct: number;
  lastDate: string | null;
  topUnits: Array<{ unitId: string; unitNumber: string; count: number }>;
}

export interface TireGroupStat {
  group: TireGroup;
  tires: number;
  count: number;
  sharePct: number;
  perTire: number;
}

export interface TirePositionSummary {
  positions: Record<TirePositionKey, TirePositionStat>;
  groups: TireGroupStat[];
  /** Ranked, most first; positions with none are left out. */
  ranking: TirePositionStat[];
  max: number;
  /** Tires on known positions. */
  total: number;
  unassigned: { count: number; recordKeys: string[] };
  insights: {
    top: TirePositionStat | null;
    outer: number;
    inner: number;
    /** Outer duals more than 1.4 times the inner ones: curb strikes or alignment. */
    outerHeavy: boolean;
    left: number;
    right: number;
    repeat: Array<{ unitId: string; unitNumber: string; positionId: TirePositionKey; times: number }>;
  };
}

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * The map's figures from the same records the table shows - so the two can never disagree - and
 * the tire events that belong to them, for one event type.
 */
export function summarizeTirePositions(
  records: TireRecordRef[],
  events: Array<Pick<TireEvent, 'positionId' | 'eventType' | 'quantity' | 'costCents'> & { recordKey: string }>,
  metric: TireEventType,
): TirePositionSummary {
  const byKey = new Map(records.map((r) => [r.key, r]));
  const positions = Object.fromEntries(
    TIRE_POSITIONS.map((p) => [p.id, { id: p.id, count: 0, costCents: 0, sharePct: 0, lastDate: null, topUnits: [] } as TirePositionStat]),
  ) as Record<TirePositionKey, TirePositionStat>;
  const units = new Map<TirePositionKey, Map<string, { unitId: string; unitNumber: string; count: number }>>();
  const hits = new Map<string, { unitId: string; unitNumber: string; positionId: TirePositionKey; dates: string[] }>();
  const unassignedKeys = new Set<string>();
  let unassigned = 0;
  for (const e of events) {
    if (e.eventType !== metric) continue;
    const r = byKey.get(e.recordKey);
    if (!r) continue;
    if (e.positionId === UNASSIGNED_TIRE) {
      unassigned += e.quantity;
      unassignedKeys.add(e.recordKey);
      continue;
    }
    const s = positions[e.positionId];
    s.count += e.quantity;
    s.costCents += e.costCents;
    if (!s.lastDate || r.date > s.lastDate) s.lastDate = r.date;
    const m = units.get(e.positionId) ?? new Map();
    const u = m.get(r.unitId) ?? { unitId: r.unitId, unitNumber: r.unitNumber, count: 0 };
    u.count += e.quantity;
    m.set(r.unitId, u);
    units.set(e.positionId, m);
    const hk = `${r.unitId}|${e.positionId}`;
    const h = hits.get(hk) ?? { unitId: r.unitId, unitNumber: r.unitNumber, positionId: e.positionId, dates: [] };
    h.dates.push(r.date);
    hits.set(hk, h);
  }
  const total = TIRE_POSITIONS.reduce((s, p) => s + positions[p.id].count, 0);
  for (const p of TIRE_POSITIONS) {
    const s = positions[p.id];
    s.sharePct = total > 0 ? (s.count / total) * 100 : 0;
    s.topUnits = [...(units.get(p.id)?.values() ?? [])].sort((a, b) => b.count - a.count || a.unitNumber.localeCompare(b.unitNumber)).slice(0, 3);
  }
  const groups: TireGroupStat[] = TIRE_GROUPS.map((g) => {
    const count = TIRE_POSITIONS.filter((p) => p.group === g).reduce((s, p) => s + positions[p.id].count, 0);
    return { group: g, tires: TIRE_GROUP_SIZE[g], count, sharePct: total > 0 ? (count / total) * 100 : 0, perTire: count / TIRE_GROUP_SIZE[g] };
  });
  const ranking = TIRE_POSITIONS.map((p) => positions[p.id])
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count || TIRE_POSITION_IDS.indexOf(a.id) - TIRE_POSITION_IDS.indexOf(b.id));
  const sum = (f: (p: TirePosition) => boolean) => TIRE_POSITIONS.filter(f).reduce((s, p) => s + positions[p.id].count, 0);
  const outer = sum((p) => p.dual === 'O');
  const inner = sum((p) => p.dual === 'I');
  const repeat = [...hits.values()]
    .map((h) => {
      const d = [...h.dates].sort();
      let best = 1;
      for (let i = 0; i < d.length; i++) {
        let j = i;
        while (j + 1 < d.length && daysBetween(d[i]!, d[j + 1]!) <= 90) j++;
        best = Math.max(best, j - i + 1);
      }
      return { unitId: h.unitId, unitNumber: h.unitNumber, positionId: h.positionId, times: best };
    })
    .filter((h) => h.times >= 2)
    .sort((a, b) => b.times - a.times || a.unitNumber.localeCompare(b.unitNumber));
  return {
    positions,
    groups,
    ranking,
    max: Math.max(0, ...TIRE_POSITIONS.map((p) => positions[p.id].count)),
    total,
    unassigned: { count: unassigned, recordKeys: [...unassignedKeys] },
    insights: {
      top: ranking[0] ?? null,
      outer,
      inner,
      outerHeavy: inner > 0 ? outer > inner * 1.4 : outer > 0,
      left: sum((p) => p.side === 'L'),
      right: sum((p) => p.side === 'R'),
      repeat,
    },
  };
}
