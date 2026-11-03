import type { DriverRelationRequest } from '@neway/shared';
import { StatusBadge } from '@/design-system';

/** The alert pill: "Needs contact" until a contact is recorded, then the status. Symbol + word. */
export function RequestStatus({ request, label }: { request: DriverRelationRequest; label?: string }) {
  if (request.needsContact) return <StatusBadge status="needs_contact" label={label} />;
  return <StatusBadge status={request.status === 'resolved' ? 'resolved' : 'contacted'} />;
}
