import type { ExpiryTone } from '@neway/shared';
import { StatusSymbol } from '@/design-system';
import { EXPIRY_LOOK } from '@/features/documents/ExpiryBadge';
import { worstExpiryTone, type UnitDocumentIssues } from '../unit-documents';

/** The chip's fill per expiry band (the shared bands: red, red, yellow, blue). */
const CHIP_TONE: Record<ExpiryTone, string> = {
  expired: 'border-danger-border bg-danger-soft text-danger-text',
  danger: 'border-danger-border bg-danger-soft text-danger-text',
  warning: 'border-warning-border bg-warning-soft text-warning-text',
  info: 'border-info-border bg-info-soft text-info-text',
  normal: 'border-line bg-surface text-muted',
  none: 'border-line bg-surface text-muted',
};

/**
 * The paperwork warning beside a unit's status: "Registration expired", "No annual inspection"
 * or "2 documents expiring".
 *
 * Three findings, in the order the yard cares about them: a document that expired, a document
 * that was never filed at all — the unit created without its paperwork — and a document about to
 * expire. The first two leave the unit out of service, so they read in the danger family with the
 * octagon; the third takes the shared expiry band of the soonest document (red within a month,
 * yellow within two, blue within three) with that band's symbol. The chip's action opens the unit's Documents tab, at the type it named when
 * it named one, so "No registration" is the button that attaches the registration.
 */
export function UnitDocumentChip({
  issues,
  onOpen,
}: {
  issues: UnitDocumentIssues;
  /** The type the chip is about, when it is about one; the tab opens there to attach it. */
  onOpen: (requirementCode?: string) => void;
}) {
  const expired = issues.expired;
  const expiring = issues.expiring;
  const missing = issues.missing ?? [];
  if (expired.length === 0 && expiring.length === 0 && missing.length === 0) return null;

  const label =
    expired.length === 1
      ? `${expired[0]!.typeName} expired`
      : expired.length > 1
        ? `${expired.length} documents expired`
        : missing.length === 1
          ? missing[0]!.label
          : missing.length > 1
            ? `${missing.length} documents missing`
            : expiring.length === 1
              ? `${expiring[0]!.typeName} ${expiring[0]!.expiry.label.toLowerCase()}`
              : `${expiring.length} documents expiring`;

  // Nothing on file is the same consequence as an expired document — the unit cannot be
  // dispatched — so it reads in the same family, with the same octagon.
  const band: ExpiryTone =
    expired.length > 0 || missing.length > 0
      ? 'expired'
      : worstExpiryTone(expiring.map((i) => i.expiry.tone));
  const look = EXPIRY_LOOK[band];
  const tone = CHIP_TONE[band];

  // A chip about exactly one type can attach that type; one summarising several opens the tab.
  const code =
    expired.length === 0 && missing.length === 1
      ? missing[0]!.code
      : expired.length === 1 && missing.length === 0
        ? expired[0]!.document.requirementCode
        : undefined;
  const attaching = missing.length > 0;

  return (
    <button
      type="button"
      onClick={() => onOpen(code)}
      data-testid="unit-document-chip"
      data-expiry-tone={band}
      className={`inline-flex h-[22px] items-center gap-1 rounded-sm border px-2 text-xs font-semibold hover:underline ${tone}`}
      title={
        issues.hold ??
        [
          ...missing.map((m) => `${m.typeName}: nothing on file`),
          ...[...expired, ...expiring].map((i) => `${i.typeName}: ${i.expiry.label.toLowerCase()}`),
        ].join(', ')
      }
    >
      <StatusSymbol family={look.symbol} size={13} className={look.iconClass} />
      {label}
      {attaching ? <span className="font-semibold underline">· Attach</span> : null}
    </button>
  );
}
