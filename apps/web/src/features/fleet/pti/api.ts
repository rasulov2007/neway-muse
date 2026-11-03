import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  describeScreenshotProblem,
  type CreateDefectRequest,
  type PtiBoard,
  type PtiDefect,
  type PtiDefectState,
  type PtiInspection,
  type PtiUnitHistoryEntry,
  type PtiUnitIssues,
  type ReceiptRequest,
  type ReviewRequest,
  type Screenshot,
  type TransitionDefectRequest,
  type UnitServiceVerdict,
  type UpdateDefectRequest,
  type WorkOrder,
} from '@neway/shared';
import type { CreateWorkOrderSchema } from '@neway/shared';
import type { z } from 'zod';

type CreateWorkOrderRequest = z.input<typeof CreateWorkOrderSchema>;
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';
import { nowIso } from '@/lib/clock';
import { uploadFile } from '@/lib/files';

/**
 * The walk-around's data layer.
 *
 * Every read here is a server read and every write a server write: the rules the brief calls the
 * point of the rebuild (§4.2–§4.4, §3.3) are enforced in `PtiService`, and a screen that computed
 * them itself would be a second opinion. One cache key, `['pti']`, because a defect touches the
 * board, the unit's verdict and the truck header at once; a mutation invalidates the lot rather
 * than guessing which of them it moved.
 */

const BASE = '/fleet/pti';

export const ptiKeys = {
  all: ['pti'] as const,
  board: (week?: string) => ['pti', 'board', week ?? 'current'] as const,
  inspection: (id: string) => ['pti', 'inspection', id] as const,
  defects: (filter: DefectFilter) => ['pti', 'defects', filter] as const,
  defect: (id: string) => ['pti', 'defect', id] as const,
  unitStatus: (unitId: string) => ['pti', 'unit-status', unitId] as const,
  unitIssues: ['pti', 'unit-issues'] as const,
};

export interface DefectFilter {
  unitId?: string;
  state?: PtiDefectState;
  open?: boolean;
}

/** What `GET /fleet/pti/units/:id/status` answers: the verdict and the defects behind it. */
export interface UnitStatusResponse {
  verdict: UnitServiceVerdict;
  defects: PtiDefect[];
}

export interface ReviewResponse {
  inspection: PtiInspection;
  defects: PtiDefect[];
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export function fetchPtiBoard(week?: string): Promise<PtiBoard> {
  return apiGet<PtiBoard>(`${BASE}/board`, { week });
}

export function usePtiBoard(week?: string): UseQueryResult<PtiBoard> {
  return useQuery({ queryKey: ptiKeys.board(week), queryFn: () => fetchPtiBoard(week) });
}

/** The unit's last four weeks, for the form's history card. */
export function usePtiUnitHistory(
  unitId: string | null | undefined,
): UseQueryResult<PtiUnitHistoryEntry[]> {
  return useQuery({
    queryKey: [...ptiKeys.all, 'history', unitId ?? ''],
    queryFn: () =>
      apiGet<PtiUnitHistoryEntry[]>(`${BASE}/units/${unitId}/inspections`, { weeks: 4 }),
    enabled: Boolean(unitId),
  });
}

export function usePtiInspection(id: string | null | undefined): UseQueryResult<PtiInspection> {
  return useQuery({
    queryKey: ptiKeys.inspection(id ?? ''),
    queryFn: () => apiGet<PtiInspection>(`${BASE}/inspections/${id}`),
    enabled: Boolean(id),
  });
}

export function usePtiDefects(filter: DefectFilter = {}): UseQueryResult<PtiDefect[]> {
  return useQuery({
    queryKey: ptiKeys.defects(filter),
    queryFn: () =>
      apiGet<PtiDefect[]>(`${BASE}/defects`, {
        unitId: filter.unitId,
        state: filter.state,
        open: filter.open ? 'true' : undefined,
      }),
  });
}

export function usePtiDefect(id: string | null | undefined): UseQueryResult<PtiDefect> {
  return useQuery({
    queryKey: ptiKeys.defect(id ?? ''),
    queryFn: () => apiGet<PtiDefect>(`${BASE}/defects/${id}`),
    enabled: Boolean(id),
  });
}

/** The unit's single verdict, for the truck header, Truck Health and the dispatch check. */
export function useUnitServiceStatus(
  unitId: string | null | undefined,
): UseQueryResult<UnitStatusResponse> {
  return useQuery({
    queryKey: ptiKeys.unitStatus(unitId ?? ''),
    queryFn: () => fetchUnitServiceStatus(unitId ?? ''),
    enabled: Boolean(unitId),
  });
}

export function fetchUnitServiceStatus(unitId: string): Promise<UnitStatusResponse> {
  return apiGet<UnitStatusResponse>(`${BASE}/units/${unitId}/status`);
}

/**
 * Every unit's PTI issues, keyed by unit id (owner, 2026-10-21): the sign beside a unit's status.
 * One read shared by every row; which defects count is decided on the server. `undefined` until
 * it lands, so nothing is drawn before the answer is known.
 */
export function usePtiUnitIssues(enabled = true): UseQueryResult<Record<string, PtiUnitIssues>> {
  return useQuery({
    queryKey: ptiKeys.unitIssues,
    queryFn: () => apiGet<Record<string, PtiUnitIssues>>(`${BASE}/unit-issues`),
    enabled,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

function useInvalidatingMutation<TInput, TOutput>(run: (input: TInput) => Promise<TOutput>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => client.invalidateQueries({ queryKey: ptiKeys.all }),
  });
}

/** The video arrived: where, when and from whom. */
export function useReceiveInspection() {
  return useInvalidatingMutation(({ id, ...input }: ReceiptRequest & { id: string }) =>
    apiPost<PtiInspection>(`${BASE}/inspections/${id}/receipt`, input),
  );
}

/** The soft lock: "Tom is reviewing this one". */
export function useLockInspection() {
  return useInvalidatingMutation(
    ({ id, version, on }: { id: string; version: number; on: boolean }) =>
      apiPost<PtiInspection>(`${BASE}/inspections/${id}/${on ? 'lock' : 'unlock'}`, { version }),
  );
}

/** The drawer's save. A clean review changes no defect; an issue found creates one per card. */
export function useReviewInspection() {
  return useInvalidatingMutation(({ id, ...input }: ReviewRequest & { id: string }) =>
    apiPost<ReviewResponse>(`${BASE}/inspections/${id}/review`, input),
  );
}

/**
 * Request correction (mobile, 2026-10-27): send a walk-around the driver sent from the app back to
 * them with a reason. The driver is notified and may resubmit; the submission stays in the history.
 */
export function useRequestPtiCorrection() {
  return useInvalidatingMutation(({ id, version, reason }: { id: string; version: number; reason: string }) =>
    apiPost<PtiInspection>(`${BASE}/inspections/${id}/request-correction`, { version, reason }),
  );
}

export function useCreateDefect() {
  return useInvalidatingMutation((input: CreateDefectRequest) =>
    apiPost<PtiDefect>(`${BASE}/defects`, input),
  );
}

export function useUpdateDefect() {
  return useInvalidatingMutation(({ id, ...input }: UpdateDefectRequest & { id: string }) =>
    apiPatch<PtiDefect>(`${BASE}/defects/${id}`, input),
  );
}

/** Moves a defect through its life. `verified` is the only transition that lifts a hold. */
export function useTransitionDefect() {
  return useInvalidatingMutation(({ id, ...input }: TransitionDefectRequest & { id: string }) =>
    apiPost<PtiDefect>(`${BASE}/defects/${id}/transition`, input),
  );
}

/** A work order closed: its defects are proposed for verification, and nothing is released. */
export function notifyWorkOrderClosed(workOrderId: string): Promise<PtiDefect[]> {
  return apiPost<PtiDefect[]>(`${BASE}/work-orders/${workOrderId}/closed`, {});
}

/**
 * Opens a shop work order for a defect, pre-linked (WP6). The server checks the defect is this
 * unit's and open, writes `defectId` on the order and `workOrderId` on the defect, and moves the
 * defect into repair; the generated notes name the defect for a person, but the field is the link.
 */
export function openWorkOrderForDefect(
  defect: Pick<
    PtiDefect,
    'id' | 'unitId' | 'defectNumber' | 'component' | 'componentName' | 'description'
  >,
  options: { vendorName?: string; notes?: string } = {},
): Promise<WorkOrder> {
  const tyres =
    /tyre|tire|wheel/i.test(defect.component) || /tyre|tire|wheel/i.test(defect.componentName);
  const input: CreateWorkOrderRequest = {
    assetType: 'truck',
    unitId: defect.unitId,
    status: 'in_shop',
    workType: tyres ? 'tires' : 'repair',
    notes: [
      `${defect.defectNumber} · ${defect.componentName}: ${defect.description}`,
      options.vendorName ? `Vendor: ${options.vendorName}` : null,
      options.notes ?? null,
    ]
      .filter(Boolean)
      .join('\n'),
    defectId: defect.id,
  };
  return apiPost<WorkOrder>('/fleet/work-orders', input);
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

/**
 * Stores a still from the video and answers with what the defect keeps about it.
 *
 * The file is refused here, before a byte leaves the browser, for the same reasons the server
 * refuses it after: not an image, or too large to be a screenshot. The words are the shared
 * rule's, so the person reads the same sentence whichever side caught it.
 */
export async function uploadScreenshot(file: File, uploadedBy: string): Promise<Screenshot> {
  const problem = describeScreenshotProblem({ contentType: file.type, sizeBytes: file.size });
  if (problem) throw new Error(problem);
  const stored = await uploadFile(file);
  return { fileId: stored.id, fileName: stored.fileName, uploadedAt: nowIso(), uploadedBy };
}
