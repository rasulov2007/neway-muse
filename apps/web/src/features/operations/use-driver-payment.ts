import { useQuery } from '@tanstack/react-query';
import type { DriverPaymentDetails } from '@neway/shared';
import { apiGet } from '@/lib/api-client';

/** How the driver is paid, served masked. Null until it is set up. */
export function useDriverPayment(driverId: string) {
  return useQuery({
    queryKey: ['drivers', 'payment', driverId],
    queryFn: () => apiGet<DriverPaymentDetails | null>(`/drivers/${driverId}/payment`),
  });
}
