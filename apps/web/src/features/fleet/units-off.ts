import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api-client';

/**
 * Trucks whose driver is HOME or on VACATION on today's Daily board (owner, 2026-10-28), by unit
 * number. A role that may not read it simply sees no marks: a refused read never blanks the page.
 */
export interface UnitOff {
  truckUnit: string;
  status: 'HOME' | 'VACATION';
  driverName: string;
}

export function useUnitsOff() {
  return useQuery({
    queryKey: ['dispatch', 'units-off'],
    queryFn: () => apiGet<{ day: string; units: UnitOff[] }>('/dispatch/board/units-off'),
    retry: false,
    staleTime: 60_000,
    select: (data) => new Map(data.units.map((u) => [u.truckUnit.trim().toUpperCase(), u])),
  });
}
