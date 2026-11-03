import { useQuery } from '@tanstack/react-query';
import type { VacationRequestList } from '@neway/shared';
import { apiGet } from '@/lib/api-client';

/** Vacation requests drivers sent from the driver app (mobile M3), with the decision and parked-truck state. */
export function useVacationRequests() {
  return useQuery({ queryKey: ['drivers', 'vacation-requests'], queryFn: () => apiGet<VacationRequestList>('/drivers/vacation-requests') });
}
