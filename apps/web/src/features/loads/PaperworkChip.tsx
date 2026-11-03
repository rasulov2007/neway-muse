import { FileWarning } from 'lucide-react';
import { missingPaperwork, paperworkLabel } from '@neway/shared';
import type { Load } from '@/demo';

/**
 * What a delivered load is still missing on paper.
 *
 * Delivery and paperwork are two different facts: the freight arrived, and the document that
 * proves it may not have been filed yet. The status says the first; this chip says the second,
 * beside it, so "Delivered" is never read as "ready to bill". Billing enforces the same fact.
 */
export function PaperworkChip({ load, className }: { load: Pick<Load, 'status' | 'documents'>; className?: string }) {
  const label = paperworkLabel(missingPaperwork(load));
  if (!label) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm bg-warning-soft px-1.5 py-0.5 text-[11px] font-semibold text-warning-text ${className ?? ''}`}
      title="The freight is delivered. This document is not on file yet, so the load cannot be invoiced."
    >
      <FileWarning aria-hidden className="size-3" /> {label}
    </span>
  );
}
