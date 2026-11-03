import { windowClosed, windowLabel, type ComponentCondition } from '@/demo';
import { formatIsoDate } from '@/lib/format';

/** "2 weeks · closes Sep 20 · from Aug 31" */
export function detail(condition: ComponentCondition, today: string): string {
  const parts: string[] = [];
  if (condition.source) {
    const window = windowLabel(condition.source);
    if (window) parts.push(window);
    if (condition.closesOn) {
      parts.push(
        windowClosed(condition, today)
          ? `closed ${formatIsoDate(condition.closesOn)}`
          : `closes ${formatIsoDate(condition.closesOn)}`,
      );
    } else if (condition.milesRemaining !== null) {
      parts.push(
        condition.milesRemaining <= 0
          ? 'miles used up'
          : `${condition.milesRemaining.toLocaleString('en-US')} mi left`,
      );
    }
    if (condition.carriedOver) parts.push(`from ${formatIsoDate(condition.source.weekStart)}`);
    if (condition.stale) parts.push('re-check');
  }
  return parts.join(' · ');
}
