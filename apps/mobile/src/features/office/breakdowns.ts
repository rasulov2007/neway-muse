import type { BreakdownStatus } from '@neway/shared/mobile/breakdowns';
import type { StatusTone } from '@/ui/tokens';

/**
 * Breakdown status families. These words are new in M3 and not in SPEC §7's table: the families
 * below are the ones INTEGRATION.md lists for the owner's decision (Received warning · Assigned,
 * Shop arranged, In repair moving · Ready done · Closed neutral).
 */
export const BREAKDOWN_TONE: Record<BreakdownStatus, StatusTone> = {
  received: 'warning',
  assigned: 'moving',
  shop_arranged: 'moving',
  in_repair: 'moving',
  ready: 'success',
  closed: 'neutral',
};
