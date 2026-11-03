import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DriverTeamList, DriverTeamStanding, DriverTeamView, PairDriversInput, UnpairDriversInput } from '@neway/shared';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet, apiPost } from '@/lib/api-client';

/** Team or Solo (owner, 2026-10-25): every team in force, one driver's standing, Pair and Unpair. */
const enc = encodeURIComponent;

export function useDriverTeams(enabled = true) {
  return useQuery({ queryKey: ['drivers', 'teams'], queryFn: () => apiGet<DriverTeamList>('/drivers/teams'), enabled });
}

export function useDriverTeam(driverId: string) {
  return useQuery({ queryKey: ['drivers', 'teams', driverId], queryFn: () => apiGet<DriverTeamStanding>(`/drivers/${enc(driverId)}/team`) });
}

/** Partner of each driver in a team today, by driver id. */
export function teamsByDriver(list: DriverTeamList | undefined): Map<string, DriverTeamView> {
  return new Map((list?.teams ?? []).map((t) => [t.driverId, t]));
}

/** Who may pair and unpair: the server checks the same pair of permissions. */
export function useCanManageTeams(): boolean {
  const account = useAccount();
  return Boolean(account && (account.permissions.includes('drivers.edit') || account.permissions.includes('dispatch.manage')));
}

function useTeamWrite<T>(send: (input: T) => Promise<DriverTeamStanding>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    // Both drivers changed: refresh every team read (list and both standings).
    onSuccess: () => client.invalidateQueries({ queryKey: ['drivers', 'teams'] }),
  });
}

export const usePairDriver = (driverId: string) =>
  useTeamWrite((input: PairDriversInput) => apiPost<DriverTeamStanding>(`/drivers/${enc(driverId)}/team`, input));
export const useUnpairDriver = (driverId: string, pairId: string) =>
  useTeamWrite((input: UnpairDriversInput) => apiPost<DriverTeamStanding>(`/drivers/${enc(driverId)}/team/${enc(pairId)}/end`, input));
