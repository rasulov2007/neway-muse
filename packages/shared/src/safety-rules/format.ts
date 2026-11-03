// Labels and number formatting the rules and summaries need (ported from
// docs/accidents/prototype/src/lib/format.ts). Money arguments are integer CENTS; the printed text is
// in dollars exactly as the prototype printed its whole-dollar amounts.
import type {
  CargoState,
  ClaimStatus,
  ClaimType,
  CpdpValue,
  EquipmentState,
  FaultValue,
  LegalValue,
  PreventValue,
  Severity,
  Stage,
  Tri,
} from './types.js';

/** Format cents as dollars: 184000 → "$1,840"; compact 1035000 → "$10.3K". */
export function money(cents?: number | null, opts: { compact?: boolean; cents?: boolean; sign?: boolean } = {}): string {
  if (cents === undefined || cents === null || Number.isNaN(cents)) return '—';
  const n = cents / 100;
  const neg = n < 0;
  const v = Math.abs(n);
  let s: string;
  if (opts.compact && v >= 1000) {
    s = v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : `$${(v / 1000).toFixed(v >= 1e5 ? 0 : 1).replace(/\.0$/, '')}K`;
  } else {
    s = '$' + v.toLocaleString('en-US', { minimumFractionDigits: opts.cents ? 2 : 0, maximumFractionDigits: opts.cents ? 2 : 0 });
  }
  return (neg ? '−' : opts.sign && n > 0 ? '+' : '') + s;
}

export function num(n: number, digits = 0): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function pct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}
export function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}

export const TRI_LABEL: Record<string, string> = { yes: 'Yes', no: 'No', unknown: 'Unknown', na: 'N/A', null: 'Not reported' };
export function triLabel(t: Tri): string {
  return TRI_LABEL[String(t)] ?? 'Not reported';
}

export const SEVERITY_LABEL: Record<Severity, string> = { minor: 'Minor', moderate: 'Moderate', serious: 'Serious', critical: 'Critical' };
export const STAGE_LABEL: Record<Stage, string> = {
  draft: 'Draft',
  initial_response: 'Initial response',
  investigation: 'Investigation',
  resolution: 'Resolution',
  closed: 'Closed',
};
export const STAGES: Stage[] = ['initial_response', 'investigation', 'resolution', 'closed'];

export const CLAIM_TYPE_LABEL: Record<ClaimType, string> = {
  physical_damage: 'Physical damage',
  auto_liability: 'Auto liability',
  cargo: 'Cargo',
  recovery: 'Recovery (subrogation)',
  workers_comp: "Workers' comp / occ. accident",
};
export const CLAIM_TYPE_HINT: Record<ClaimType, string> = {
  physical_damage: 'Damage to our tractor or trailer',
  auto_liability: 'Damage or injury we caused to others',
  cargo: 'Cargo damage, shortage, loss or theft',
  recovery: 'Money we recover from the other party',
  workers_comp: 'Injury to our driver (restricted)',
};
export const CLAIM_STATUSES: ClaimStatus[] = ['Draft', 'Open', 'Under review', 'Awaiting documents', 'Negotiating', 'Settled', 'Denied', 'Closed'];
export const OPEN_CLAIM = (s: ClaimStatus): boolean => !['Settled', 'Denied', 'Closed'].includes(s);

export const FAULT_LABEL: Record<FaultValue, string> = {
  not_determined: 'Not determined',
  not_at_fault: 'Not at fault',
  partial: 'Partially at fault',
  at_fault: 'At fault',
};
export const PREVENT_LABEL: Record<PreventValue, string> = {
  not_determined: 'Not determined',
  non_preventable: 'Non-preventable',
  preventable: 'Preventable',
};
export const CPDP_LABEL: Record<CpdpValue, string> = {
  not_applicable: 'Not applicable (not DOT-reportable)',
  not_eligible: 'Not an eligible crash type',
  eligible_not_submitted: 'Eligible — not submitted',
  submitted: 'Submitted to DataQs — pending',
  not_preventable: 'FMCSA: Not preventable',
  preventable: 'FMCSA: Preventable',
  undecided: 'FMCSA: Undecided',
};
export const LEGAL_LABEL: Record<LegalValue, string> = {
  unknown: 'Not assessed',
  no_claim_expected: 'No third-party claim expected',
  disputed: 'Disputed',
  third_party_liable: 'Third party liable',
  shared: 'Shared liability',
  company_liable: 'Company liable',
  in_litigation: 'In litigation',
};

export const EQUIP_STATUS_LABEL: Record<EquipmentState['status'], string> = {
  unknown: 'Not confirmed',
  operational: 'Operational',
  at_scene: 'At scene',
  towed_storage: 'Towed — in storage',
  at_shop: 'At shop — awaiting repair',
  in_repair: 'In repair',
  returned: 'Returned to service',
  total_loss: 'Total loss',
  not_involved: 'Not involved',
};
export const CARGO_STATUS_LABEL: Record<CargoState['status'], string> = {
  na: 'No cargo (empty/bobtail)',
  unknown: 'Unknown',
  no_damage: 'No damage',
  damaged: 'Damaged',
  loss: 'Total loss / theft',
};
export const CARGO_PLAN_LABEL: Record<NonNullable<CargoState['plan']>, string> = {
  none_needed: 'No action needed',
  transload: 'Transload to another trailer',
  repower: 'Repower with another truck',
  delivered_as_is: 'Delivered as is',
  rejected: 'Rejected by receiver',
  salvage: 'Salvage',
};

export const ACCIDENT_TYPES = [
  'Rear-end — we struck the vehicle ahead',
  'Rear-end — struck by another vehicle',
  'Sideswipe / lane change',
  'Intersection / turning',
  'Backing',
  'Parking / struck fixed object',
  'Struck while parked or stopped',
  'Struck fixed object on roadway',
  'Run off road / rollover',
  'Jackknife / loss of control',
  'Animal strike',
  'Road debris / tire debris',
  'Cargo shift (no collision)',
  'Other',
];

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase();
}
