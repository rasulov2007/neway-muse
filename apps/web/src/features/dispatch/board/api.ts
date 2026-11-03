import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  AddRosterRowInput,
  AssignDriverToTeamInput,
  OffBoardDriver,
  BoardCell,
  BoardEdit,
  Claim,
  CommissionPolicy,
  CommissionView,
  CreatePolicyVersionInput,
  DailyBoard,
  PerformanceBoard,
  PerformanceTargets,
  PeriodKind,
  PolicyVersion,
  RosterImportReport,
  RosterRow,
  SalaryAdjustment,
  SalaryReport,
  SalaryRunActionInput,
  TeamOrderView,
  WriteTeamOrderInput,
  UnassignRosterRowInput,
  UpdateRosterRowInput,
  WeeklyBoard,
  WriteAllocationInput,
  WriteBoardCellsInput,
  WriteBoardFillInput,
  WriteClaimInput,
  WriteSalaryAdjustmentInput,
  WriteWeekFlagsInput,
  WriteWeekOverrideInput,
} from '@neway/shared';
import { WEEK_COMMENT_COLUMN, parseAmount, parseMiles } from '@neway/shared';
import { apiGet, apiPost, apiPut } from '@/lib/api-client';
import { invalidateRoster } from '@/demo/roster-api';

/**
 * The dispatch boards' data layer. One cache root, `['dispatch-board']`: a typed cell moves the
 * daily row, the weekly day, the salary report and the history at once.
 */
const BASE = '/dispatch';

export const boardKeys = {
  all: ['dispatch-board'] as const,
  daily: (day: string) => ['dispatch-board', 'daily', day] as const,
  weekly: (week: string) => ['dispatch-board', 'weekly', week] as const,
  history: (driverId: string) => ['dispatch-board', 'history', driverId] as const,
  roster: () => ['dispatch-board', 'roster'] as const,
  policy: () => ['dispatch-board', 'policy'] as const,
  salary: (kind: string, date: string) => ['dispatch-board', 'salary', kind, date] as const,
  allocations: () => ['dispatch-board', 'allocations'] as const,
  claims: () => ['dispatch-board', 'claims'] as const,
  performance: (kind: string, date: string) =>
    ['dispatch-board', 'performance', kind, date] as const,
  performanceTargets: () => ['dispatch-board', 'performance-targets'] as const,
  teamOrder: () => ['dispatch-board', 'team-order'] as const,
};

export function useDailyBoard(day: string): UseQueryResult<DailyBoard> {
  return useQuery({
    queryKey: boardKeys.daily(day),
    queryFn: () => apiGet<DailyBoard>(`${BASE}/board/daily`, { day }),
    refetchInterval: 60_000,
  });
}

export function useWeeklyBoard(week: string): UseQueryResult<WeeklyBoard> {
  return useQuery({
    queryKey: boardKeys.weekly(week),
    queryFn: () => apiGet<WeeklyBoard>(`${BASE}/board/weekly`, { week }),
    refetchInterval: 60_000,
  });
}

/** The scoreboard, with the period's own label and the one it is compared with. */
export type PerformanceResponse = PerformanceBoard & { label: string; previousLabel: string };

export function usePerformance(kind: PeriodKind, date: string): UseQueryResult<PerformanceResponse> {
  return useQuery({
    queryKey: boardKeys.performance(kind, date),
    queryFn: () => apiGet<PerformanceResponse>(`${BASE}/performance`, { kind, date }),
    refetchInterval: 60_000,
  });
}

export function usePerformanceTargets(): UseQueryResult<PerformanceTargets> {
  return useQuery({
    queryKey: boardKeys.performanceTargets(),
    queryFn: () => apiGet<PerformanceTargets>(`${BASE}/performance/targets`),
  });
}

export function useSavePerformanceTargets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (targets: PerformanceTargets) =>
      apiPost<PerformanceTargets>(`${BASE}/performance/targets`, targets),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardKeys.all }),
  });
}

export function useBoardHistory(driverId: string | null): UseQueryResult<BoardEdit[]> {
  return useQuery({
    queryKey: boardKeys.history(driverId ?? ''),
    queryFn: () => apiGet<BoardEdit[]>(`${BASE}/board/history`, { driverId: driverId ?? '' }),
    enabled: Boolean(driverId),
  });
}

export function useInvalidating<TInput, TOut>(fn: (input: TInput) => Promise<TOut>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardKeys.all }),
  });
}

/**
 * Cell writes show at once: the cached daily rows and weekly days take the typed value before
 * the server answers, then the whole board is re-read to pick up totals, order and auto values.
 * A refused write puts the old cache back.
 */
export function useWriteCells() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WriteBoardCellsInput) => apiPut<BoardCell[]>(`${BASE}/board/cells`, input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: boardKeys.all });
      const daily = queryClient.getQueriesData<DailyBoard>({ queryKey: ['dispatch-board', 'daily'] });
      const weekly = queryClient.getQueriesData<WeeklyBoard>({ queryKey: ['dispatch-board', 'weekly'] });
      const stamp = new Date().toISOString();
      const optimistic = (existing: BoardCell | null | undefined, w: WriteBoardCellsInput['cells'][number]): BoardCell | null =>
        w.restore
          ? null
          : {
              driverId: w.driverId,
              day: w.day,
              column: w.column,
              value: w.value === null ? null : w.value.trim().startsWith('=') ? (existing?.value ?? w.value) : w.value.trim(),
              formula: w.value !== null && w.value.trim().startsWith('=') ? w.value.trim() : null,
              setBy: existing?.setBy ?? '',
              setByName: existing?.setByName ?? 'you',
              setAt: stamp,
              version: (existing?.version ?? 0) + 1,
            };
      for (const [key, board] of daily) {
        if (!board) continue;
        const day = board.day;
        const mine = input.cells.filter((c) => c.day === day);
        if (mine.length === 0) continue;
        queryClient.setQueryData<DailyBoard>(key, {
          ...board,
          rows: board.rows.map((row) => {
            const writes = mine.filter((c) => c.driverId === row.driverId);
            if (writes.length === 0) return row;
            const cells = { ...row.cells };
            for (const w of writes) {
              const next = optimistic(cells[w.column], w);
              if (next) cells[w.column] = next;
              else delete cells[w.column];
            }
            return { ...row, cells, status: cells.status?.value ?? row.status };
          }),
        });
      }
      for (const [key, board] of weekly) {
        if (!board) continue;
        queryClient.setQueryData<WeeklyBoard>(key, {
          ...board,
          rows: board.rows.map((row) => {
            const writes = input.cells.filter((c) => c.driverId === row.driverId);
            if (writes.length === 0) return row;
            // The week's Comment is plain text on the Monday: kept as typed, never read as a formula.
            const comment = writes.filter((c) => c.column === WEEK_COMMENT_COLUMN && c.day === board.weekStart).at(-1);
            const weekComment = !comment
              ? row.weekComment
              : comment.restore || comment.value === null || comment.value.trim() === ''
                ? null
                : {
                    ...(optimistic(row.weekComment, comment) as BoardCell),
                    value: comment.value.trim(),
                    formula: null,
                  };
            return {
              ...row,
              weekComment,
              days: row.days.map((d) => {
                const w = writes.filter((c) => c.day === d.day);
                if (w.length === 0) return d;
                const next = { ...d };
                for (const c of w) {
                  if (c.column === 'amount') {
                    next.amountCell = optimistic(d.amountCell, c);
                    // Show the day the way the server will: a status word paints it and zeroes it,
                    // a number is the day's money, a cleared cell falls back to the loads.
                    const parsed = c.restore || c.value === null ? null : parseAmount(c.value);
                    if (c.restore) {
                      next.statusWord = null;
                      next.amount = d.autoAmount;
                    } else if (parsed?.kind === 'status') {
                      next.statusWord = parsed.code;
                      next.amount = 0;
                    } else if (parsed?.kind === 'number') {
                      next.statusWord = null;
                      next.amount = parsed.value;
                    } else if (c.value === null) {
                      next.statusWord = null;
                      next.amount = 0;
                    }
                  } else if (c.column === 'wk_miles') {
                    next.milesCell = optimistic(d.milesCell, c);
                    const m = c.restore || c.value === null ? null : parseMiles(c.value);
                    next.miles = c.restore ? d.autoMiles : (m?.value ?? 0);
                  }
                  else if (c.column === 'wk_load') next.loadCell = optimistic(d.loadCell, c);
                }
                return next;
              }),
            };
          }),
        });
      }
      return { daily, weekly };
    },
    onError: (_error, _input, context) => {
      for (const [key, board] of context?.daily ?? []) queryClient.setQueryData(key, board);
      for (const [key, board] of context?.weekly ?? []) queryClient.setQueryData(key, board);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: boardKeys.all }),
  });
}

export function useWriteFills() {
  return useInvalidating((input: WriteBoardFillInput) => apiPut<{ written: number }>(`${BASE}/board/fills`, input));
}

export function useWriteOverride() {
  return useInvalidating((input: WriteWeekOverrideInput) => apiPut<CommissionView | null>(`${BASE}/board/commission/override`, input));
}

export function useWriteFlags() {
  return useInvalidating((input: WriteWeekFlagsInput) => apiPut<CommissionView | null>(`${BASE}/board/commission/flags`, input));
}

// ------------------------------------------------------------------------------ roster

export function useRoster(enabled = true): UseQueryResult<RosterRow[]> {
  return useQuery({ queryKey: boardKeys.roster(), queryFn: () => apiGet<RosterRow[]>(`${BASE}/roster`), enabled });
}

/** Drivers not on the boards today: driver files without a board row and removed rows (owner, 2026-10-26). */
export function useOffBoardDrivers(enabled: boolean): UseQueryResult<OffBoardDriver[]> {
  return useQuery({ queryKey: [...boardKeys.all, 'off-board'], queryFn: () => apiGet<OffBoardDriver[]>(`${BASE}/roster/off-board`), enabled });
}

/** Assign a driver to a dispatcher: creates, restores or moves his board row (one server path). */
export function useAssignDriverToTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AssignDriverToTeamInput) => apiPost<RosterRow>(`${BASE}/roster/assign`, input),
    onSuccess: () => {
      invalidateRoster();
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: boardKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
      ]);
    },
  });
}

export function useAddRosterRow() {
  return useInvalidating((input: AddRosterRowInput) => apiPost<RosterRow>(`${BASE}/roster`, input));
}

export function useUpdateRosterRow() {
  return useInvalidating(({ id, ...input }: UpdateRosterRowInput & { id: string }) => apiPut<RosterRow>(`${BASE}/roster/${id}`, input));
}

/** Unassign: the driver leaves his dispatcher from the week's Monday and sits in Unassigned drivers. */
export function useUnassignRosterRow() {
  return useInvalidating(({ id, ...input }: UnassignRosterRowInput & { id: string }) => apiPost<RosterRow>(`${BASE}/roster/${id}/unassign`, input));
}

/** Remove from board: the row leaves every board from that week (hidden; Restore brings it back). */
export function useRemoveRosterRowFromBoard() {
  return useInvalidating(({ id, ...input }: UnassignRosterRowInput & { id: string }) => apiPost<RosterRow>(`${BASE}/roster/${id}/remove-from-board`, input));
}

export function useRestoreRosterRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedVersion }: { id: string; expectedVersion: number }) =>
      apiPost<RosterRow>(`${BASE}/roster/${id}/restore`, { expectedVersion }),
    // A row the driver archive took off brings its driver file back too, so the Drivers page's
    // roster is re-read along with the boards.
    onSuccess: () => {
      invalidateRoster();
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: boardKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
      ]);
    },
  });
}

export function useImportRoster() {
  return useInvalidating(({ csv, dryRun }: { csv: string; dryRun: boolean }) =>
    apiPost<RosterImportReport>(`${BASE}/roster/import?dryRun=${dryRun ? 'true' : 'false'}`, { csv }),
  );
}

// ------------------------------------------------------------------------------ team order

/** The board order of the teams and their TEAM n badges (owner, 2026-10-26). */
export function useTeamOrder(enabled = true): UseQueryResult<TeamOrderView> {
  return useQuery({ queryKey: boardKeys.teamOrder(), queryFn: () => apiGet<TeamOrderView>(`${BASE}/board/team-order`), enabled });
}

export function useSaveTeamOrder() {
  return useInvalidating((input: WriteTeamOrderInput) => apiPut<TeamOrderView>(`${BASE}/board/team-order`, input));
}

// ------------------------------------------------------------------------------ policy

export function usePolicy(): UseQueryResult<{ current: PolicyVersion; versions: PolicyVersion[] }> {
  return useQuery({ queryKey: boardKeys.policy(), queryFn: () => apiGet(`${BASE}/policy`) });
}

export function usePolicyPreview() {
  return useMutation({
    mutationFn: (policy: CommissionPolicy) =>
      apiPost<{ problems: string[]; rows: { label: string; unit: string; gross: number; rpm: number | null; result: { status: string; amountCents: number; pct: number; tier: string; formula: string } }[] }>(
        `${BASE}/policy/preview`,
        policy,
      ),
  });
}

export function useCreatePolicyVersion() {
  return useInvalidating((input: CreatePolicyVersionInput) => apiPost<PolicyVersion>(`${BASE}/policy`, input));
}

// ------------------------------------------------------------------------------ salary

export function useSalaryReport(kind: PeriodKind, date: string, enabled = true): UseQueryResult<SalaryReport> {
  return useQuery({
    queryKey: boardKeys.salary(kind, date),
    queryFn: () => apiGet<SalaryReport>(`${BASE}/salary`, { kind, date }),
    enabled,
  });
}

export function useSalaryRunAction() {
  return useInvalidating(({ kind, date, ...input }: SalaryRunActionInput & { kind: PeriodKind; date: string }) =>
    apiPost<SalaryReport>(`${BASE}/salary/run?kind=${kind}&date=${date}`, input),
  );
}

export function useAddAdjustment() {
  return useInvalidating((input: WriteSalaryAdjustmentInput) => apiPost<SalaryAdjustment>(`${BASE}/salary/adjustments`, input));
}

export function useVoidAdjustment() {
  return useInvalidating(({ id, reason }: { id: string; reason: string }) => apiPost<SalaryAdjustment>(`${BASE}/salary/adjustments/${id}/void`, { reason }));
}

export interface AllocationRecord {
  id: string;
  dispatcherId: string;
  effectiveFrom: string;
  shares: { employeeId: string | null; name: string; sharePct: number }[];
  byName: string;
  at: string;
}

export function useAllocations(enabled: boolean): UseQueryResult<AllocationRecord[]> {
  return useQuery({ queryKey: boardKeys.allocations(), queryFn: () => apiGet<AllocationRecord[]>(`${BASE}/salary/allocations`), enabled });
}

export function useWriteAllocation() {
  return useInvalidating((input: WriteAllocationInput) => apiPost<{ ok: true }>(`${BASE}/salary/allocations`, input));
}

export function salaryExportUrl(kind: PeriodKind, date: string, format: 'xlsx' | 'csv'): string {
  return `${BASE}/salary/export.${format}?kind=${kind}&date=${date}`;
}

// ------------------------------------------------------------------------------ claims

export function useClaims(): UseQueryResult<Claim[]> {
  return useQuery({ queryKey: boardKeys.claims(), queryFn: () => apiGet<Claim[]>(`${BASE}/claims`) });
}

export function useWriteClaim() {
  return useInvalidating(({ id, ...input }: WriteClaimInput & { id: string | null }) =>
    id ? apiPut<Claim>(`${BASE}/claims/${id}`, input) : apiPost<Claim>(`${BASE}/claims`, input),
  );
}

export function useVoidClaim() {
  return useInvalidating(({ id, reason, expectedVersion }: { id: string; reason: string; expectedVersion: number }) =>
    apiPost<Claim>(`${BASE}/claims/${id}/void`, { reason, expectedVersion }),
  );
}
