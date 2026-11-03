import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CompletePmInput,
  CorrectPmInput,
  CreateReadingRequest,
  OdometerReading,
  PmBoard,
  PmPlan,
  PmShop,
  PmStatus,
  PmUnitDetail,
  SchedulePmInput,
  SetPmPlanRequest,
  SetUnitGroupInput,
  VoidPmCompletionInput,
  WorkOrder,
} from '@neway/shared';
import { apiGet, apiPost } from '@/lib/api-client';

/**
 * The Oil change / PM board's data layer.
 *
 * Every number on the board is the server's (docs/pm-module §5): the screen filters and sorts
 * rows it was given and never works a due status out for itself. One cache root, `['pm']`,
 * because a completion moves the board, the row's history, the shop's price list and the
 * truck's own PM line at once.
 */
const BASE = '/fleet/pm';

export const pmKeys = {
  all: ['pm'] as const,
  board: ['pm', 'board'] as const,
  shops: ['pm', 'shops'] as const,
  plans: ['pm', 'plans'] as const,
  unit: (unitId: string) => ['pm', 'unit', unitId] as const,
  readingNear: (unitId: string, at: string) => ['pm', 'reading-near', unitId, at] as const,
  assignees: ['pti', 'assignees'] as const,
};

export interface Assignee {
  id: string;
  name: string;
  roles: string[];
}

export interface NearReading {
  odometerMiles: number;
  readingAt: string;
  source: string;
}

export function usePmBoard() {
  return useQuery({ queryKey: pmKeys.board, queryFn: () => apiGet<PmBoard>(`${BASE}/board`) });
}

export function usePmShops(enabled = true) {
  return useQuery({
    queryKey: pmKeys.shops,
    queryFn: () => apiGet<PmShop[]>(`${BASE}/shops`),
    enabled,
  });
}

/** Every interval plan, group and unit; the truck types are the group ones. */
export function usePmPlans(enabled = true) {
  return useQuery({
    queryKey: pmKeys.plans,
    queryFn: () => apiGet<PmPlan[]>(`${BASE}/plans`),
    enabled,
  });
}

export function useSetPmPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetPmPlanRequest) => apiPost<PmPlan>(`${BASE}/plans`, input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: pmKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['fleet'] }),
      ]),
  });
}

/** A unit's truck type: its PM group, whose interval it then follows. */
export function useSetUnitGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ unitId, ...input }: SetUnitGroupInput & { unitId: string }) =>
      apiPost<{ unitId: string; groupName: string | null }>(
        `${BASE}/units/${encodeURIComponent(unitId)}/group`,
        input,
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: pmKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['fleet'] }),
        queryClient.invalidateQueries({ queryKey: ['trucks'] }),
      ]),
  });
}

export function usePmUnit(unitId: string | null) {
  return useQuery({
    queryKey: pmKeys.unit(unitId ?? ''),
    queryFn: () => apiGet<PmUnitDetail>(`${BASE}/units/${encodeURIComponent(unitId ?? '')}`),
    enabled: Boolean(unitId),
  });
}

/** The ELD's reading nearest the service time, for the "trusted / say why" line. */
export function useReadingNear(unitId: string | null, at: string | null) {
  return useQuery({
    queryKey: pmKeys.readingNear(unitId ?? '', at ?? ''),
    queryFn: () =>
      apiGet<NearReading | null>(
        `${BASE}/units/${encodeURIComponent(unitId ?? '')}/reading-near?at=${encodeURIComponent(at ?? '')}`,
      ),
    enabled: Boolean(unitId && at),
  });
}

export function useAssignees(enabled = true) {
  return useQuery({
    queryKey: pmKeys.assignees,
    queryFn: () => apiGet<Assignee[]>('/fleet/pti/assignees'),
    enabled,
  });
}

function useInvalidate() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: pmKeys.all }),
      client.invalidateQueries({ queryKey: ['fleet'] }),
      client.invalidateQueries({ queryKey: ['work-orders'] }),
    ]);
}

export function useSchedulePm() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: SchedulePmInput) => apiPost<WorkOrder>(`${BASE}/appointments`, input),
    onSuccess: () => void invalidate(),
  });
}

export function useCompletePm() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CompletePmInput) =>
      apiPost<{ workOrder: WorkOrder; status: PmStatus }>(`${BASE}/completions`, input),
    onSuccess: () => void invalidate(),
  });
}

export function useCorrectPm() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...input }: CorrectPmInput & { id: string }) =>
      apiPost<PmStatus>(`${BASE}/completions/${encodeURIComponent(id)}/correct`, input),
    onSuccess: () => void invalidate(),
  });
}

export function useVoidPm() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...input }: VoidPmCompletionInput & { id: string }) =>
      apiPost<PmStatus>(`${BASE}/completions/${encodeURIComponent(id)}/void`, input),
    onSuccess: () => void invalidate(),
  });
}

/** A manual odometer reading (§6.4): the engine's own endpoint, so the same conflict rules apply. */
export function useAddReading() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateReadingRequest) =>
      apiPost<OdometerReading>(`${BASE}/readings`, input),
    onSuccess: () => void invalidate(),
  });
}
