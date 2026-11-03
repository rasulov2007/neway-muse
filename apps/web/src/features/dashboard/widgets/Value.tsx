import { cn } from '@/design-system';
import { DASH, MASK, formatValue, type MetricKind } from '../metric';

export interface ValueProps {
  value: number | null | undefined;
  kind: MetricKind;
  /** True when the field is hidden by financial masking. */
  masked?: boolean;
  className?: string;
}

/** Table cell text: "—" for null, "••••••" when masked, otherwise the formatted number. */
export function Value({ value, kind, masked, className }: ValueProps) {
  const text = formatValue(value, kind, { masked });
  const unavailable = text === DASH || text === MASK;
  return <span className={cn(unavailable && 'text-faint', className)}>{text}</span>;
}
