import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CancelVacationInput,
  DriverVacationList,
  DriverVacationView,
  RecordVacationReturnInput,
  StartVacationInput,
  UpdateVacationInput,
} from '@neway/shared';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';
import { invalidateRoster } from '@/demo/roster-api';

/** Driver vacations (owner, 2026-10-17): one place for the list, one driver's history and the writes. */
const enc = encodeURIComponent;

export function useVacationList(enabled = true) {
  return useQuery({ queryKey: ['drivers', 'vacations'], queryFn: () => apiGet<DriverVacationList>('/drivers/vacations'), enabled });
}

export function useDriverVacations(driverId: string) {
  return useQuery({ queryKey: ['drivers', 'vacations', driverId], queryFn: () => apiGet<DriverVacationView[]>(`/drivers/${enc(driverId)}/vacations`) });
}

/** Who may start, edit, return and cancel: the server checks the same pair. */
export function useCanManageVacations(): boolean {
  const account = useAccount();
  return Boolean(account && (account.permissions.includes('drivers.edit') || account.permissions.includes('dispatch.manage')));
}

function useVacationWrite<T>(send: (input: T) => Promise<DriverVacationView>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: async () => {
      invalidateRoster();
      await client.invalidateQueries();
    },
  });
}

export const useStartVacation = (driverId: string) =>
  useVacationWrite((input: StartVacationInput) => apiPost<DriverVacationView>(`/drivers/${enc(driverId)}/vacations`, input));
export const useUpdateVacation = (driverId: string, id: string) =>
  useVacationWrite((input: UpdateVacationInput) => apiPatch<DriverVacationView>(`/drivers/${enc(driverId)}/vacations/${enc(id)}`, input));
export const useRecordVacationReturn = (driverId: string, id: string) =>
  useVacationWrite((input: RecordVacationReturnInput) => apiPost<DriverVacationView>(`/drivers/${enc(driverId)}/vacations/${enc(id)}/return`, input));
export const useCancelVacation = (driverId: string, id: string) =>
  useVacationWrite((input: CancelVacationInput) => apiPost<DriverVacationView>(`/drivers/${enc(driverId)}/vacations/${enc(id)}/cancel`, input));

/** The vacation in force (away), else null. */
export function currentVacation(list: DriverVacationView[] | undefined): DriverVacationView | null {
  return list?.find((v) => v.state === 'away') ?? null;
}
