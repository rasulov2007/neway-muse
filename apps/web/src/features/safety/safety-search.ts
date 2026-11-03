import { z } from 'zod';

/**
 * URL state for `/safety/compliance`, so every number on the command centre is a link to the
 * exact rows behind it and a filtered view can be shared as a URL.
 */
export const COMPLIANCE_TABS = [
  'drivers',
  'trucks',
  'trailers',
  'documents',
  'consents',
  'verification',
] as const;
export type ComplianceTab = (typeof COMPLIANCE_TABS)[number];

/** A "focus" narrows an entity tab to rows with a particular kind of problem. */
export const COMPLIANCE_FOCUSES = [
  'held',
  'expiring',
  'expired',
  'missing',
  'pending',
  'failed',
  'critical',
] as const;
export type ComplianceFocus = (typeof COMPLIANCE_FOCUSES)[number];

export const complianceSearchSchema = z.object({
  tab: z.enum(COMPLIANCE_TABS).optional().catch(undefined),
  state: z.enum(['compliant', 'at_risk', 'non_compliant']).optional().catch(undefined),
  focus: z.enum(COMPLIANCE_FOCUSES).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  /** `scope:id` of the entity whose drawer is open. */
  entity: z.string().optional().catch(undefined),
  /** Verification case whose drawer is open. */
  case: z.string().optional().catch(undefined),
});
export type ComplianceSearch = z.infer<typeof complianceSearchSchema>;

export const FOCUS_LABEL: Record<ComplianceFocus, string> = {
  held: 'Not dispatchable',
  expiring: 'Expiring within 30 days',
  expired: 'Expired',
  missing: 'Missing documents',
  pending: 'Pending verification',
  failed: 'Verification failed',
  critical: 'Critical',
};

// ---------------------------------------------------------------------------------------------
// The command centre (`/safety`)
// ---------------------------------------------------------------------------------------------

/** What the workbench shows: a compliance focus, or everything open. */
export const WORKBENCH_FOCUSES = [...COMPLIANCE_FOCUSES, 'all'] as const;
export type WorkbenchFocus = (typeof WORKBENCH_FOCUSES)[number];

export const WORKBENCH_SCOPES = ['all', 'driver', 'truck', 'trailer'] as const;
export type WorkbenchScope = (typeof WORKBENCH_SCOPES)[number];

export const WORKBENCH_GROUPS = ['requirement', 'entity'] as const;
export type WorkbenchGroup = (typeof WORKBENCH_GROUPS)[number];

/**
 * URL state for `/safety`: the tile that is active, the scope, the search, how the list is
 * grouped, which requirement is open and which record is selected - so a number on the page is
 * a link that opens exactly its rows, and a view can be handed to somebody else as a URL.
 */
export const safetySearchSchema = z.object({
  focus: z.enum(WORKBENCH_FOCUSES).optional().catch(undefined),
  scope: z.enum(WORKBENCH_SCOPES).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  group: z.enum(WORKBENCH_GROUPS).optional().catch(undefined),
  /** Requirement code whose row is expanded. */
  req: z.string().optional().catch(undefined),
  /** `scope:id` of the record whose panel is open. */
  entity: z.string().optional().catch(undefined),
});
export type SafetySearch = z.infer<typeof safetySearchSchema>;
