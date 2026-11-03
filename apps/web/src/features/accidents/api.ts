import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { accidentsV2 as A } from '@neway/shared';
import { useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { ApiError, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api-client';

/**
 * Accident & Claims v2 data layer (behind `accidents_v2`). Every number comes from the server, which runs the shared
 * rules; the browser runs the same rules only for the report's live check. One cache root: a write anywhere on a case
 * refreshes the board, the case, its tasks and timeline.
 */
export const BASE = '/safety/accidents-v2';
const ROOT = ['accidents-v2'] as const;

export const accKeys = {
  all: ROOT,
  board: (q: A.BoardQuery) => [...ROOT, 'board', q] as const,
  summary: (q: A.RangeQuery) => [...ROOT, 'summary', q] as const,
  register: (q: A.RangeQuery) => [...ROOT, 'register', q] as const,
  detail: (id: string) => [...ROOT, 'case', id] as const,
  events: (id: string) => [...ROOT, 'events', id] as const,
  tasks: (id: string) => [...ROOT, 'tasks', id] as const,
  pickers: [...ROOT, 'pickers'] as const,
};

export const useBoard = (q: A.BoardQuery): UseQueryResult<A.BoardResponse> =>
  useQuery({ queryKey: accKeys.board(q), queryFn: () => apiGet<A.BoardResponse>(BASE, q as Record<string, unknown>) });
export const useBoardSummary = (q: A.RangeQuery): UseQueryResult<A.BoardSummaryResponse> =>
  useQuery({ queryKey: accKeys.summary(q), queryFn: () => apiGet<A.BoardSummaryResponse>(`${BASE}/summary`, q as Record<string, unknown>) });
export const useRegister = (q: A.RangeQuery, enabled: boolean): UseQueryResult<A.RegisterRow[]> =>
  useQuery({ queryKey: accKeys.register(q), queryFn: () => apiGet<A.RegisterRow[]>(`${BASE}/register`, q as Record<string, unknown>), enabled });
export const useCase = (id: string): UseQueryResult<A.CaseDetailResponse> =>
  useQuery({ queryKey: accKeys.detail(id), queryFn: () => apiGet<A.CaseDetailResponse>(`${BASE}/${id}`), enabled: Boolean(id) });
export const useCaseEvents = (id: string): UseQueryResult<A.TimelineEntry[]> =>
  useQuery({ queryKey: accKeys.events(id), queryFn: () => apiGet<A.TimelineEntry[]>(`${BASE}/${id}/events`), enabled: Boolean(id) });
export const useCaseTasks = (id: string): UseQueryResult<A.TaskView[]> =>
  useQuery({ queryKey: accKeys.tasks(id), queryFn: () => apiGet<A.TaskView[]>(`${BASE}/${id}/tasks`, { status: 'all' }), enabled: Boolean(id) });
export const useVendors = (enabled: boolean): UseQueryResult<A.VendorOption[]> =>
  useQuery({ queryKey: [...ROOT, 'vendors'], queryFn: () => apiGet<A.VendorOption[]>(`${BASE}/vendors`), enabled, staleTime: 60_000 });
export const useWorkOrderAccidentLink = (woId: string, enabled: boolean): UseQueryResult<A.WorkOrderAccidentLink> =>
  useQuery({ queryKey: [...ROOT, 'wo-link', woId], queryFn: () => apiGet<A.WorkOrderAccidentLink>(`${BASE}/work-orders/${woId}/accident-link`), enabled });
export const usePickers = (enabled: boolean): UseQueryResult<A.ReportPickers> =>
  useQuery({ queryKey: accKeys.pickers, queryFn: () => apiGet<A.ReportPickers>(`${BASE}/pickers`), enabled, staleTime: 60_000 });

export const accApi = {
  report: (body: A.ReportInput, idempotencyKey: string) => apiPost<A.ReportResponse>(BASE, body, { headers: { 'Idempotency-Key': idempotencyKey } }),
  submit: (id: string, body: A.SubmitDraftInput) => apiPost<A.ReportResponse>(`${BASE}/${id}/submit`, body),
  preview: (body: A.ReportPreviewInput) => apiPost<A.ReportPreviewResponse>(`${BASE}/report-preview`, body),
  assignment: (q: { truckId?: string; driverId?: string }) => apiGet<A.AssignmentLookup>(`${BASE}/assignment`, q),
  patch: (id: string, body: A.PatchAccidentInput) => apiPatch<{ id: string; version: number }>(`${BASE}/${id}`, body),
  post: <T = { id: string; version: number }>(id: string, action: string, body: unknown) => apiPost<T>(`${BASE}/${id}/${action}`, body),
  put: (id: string, path: string, body: unknown) => apiPut<{ id: string; version: number }>(`${BASE}/${id}/${path}`, body),
  unit: (id: string, unitId: string, body: A.UnitPatchInput) => apiPatch<{ id: string; version: number }>(`${BASE}/${id}/units/${unitId}`, body),
  createTask: (body: A.CreateTaskInput) => apiPost<A.TaskView>(`${BASE}/tasks`, body),
  patchTask: (taskId: string, body: A.PatchTaskInput) => apiPatch<A.TaskView>(`${BASE}/tasks/${taskId}`, body),
  taskUpdate: (taskId: string, body: A.TaskUpdateInput) => apiPost<A.TaskView>(`${BASE}/tasks/${taskId}/updates`, body),
  confirm: (taskId: string, body: A.ConfirmRequestInput) => apiPost<A.TaskView>(`${BASE}/tasks/${taskId}/confirm`, body),
  // P3 — equipment, downtime and money (Fleet / Accounting own the records; these are their actions from the case).
  createWorkOrder: (id: string, body: A.CreateCaseWorkOrderInput) => apiPost<{ id: string }>(`${BASE}/${id}/work-orders`, body),
  wo: <T = { id: string; updatedAt: string }>(woId: string, action: 'estimates' | 'approve' | 'start' | 'complete' | 'link-accident', body: unknown) => apiPost<T>(`${BASE}/work-orders/${woId}/${action}`, body),
  verifyDowntime: (id: string, body: A.VerifyDowntimeInput) => apiPost<{ id: string; version: number }>(`${BASE}/downtime/${id}/verify`, body),
  addBill: (id: string, body: A.CaseBillInput) => apiPost<{ id: string; number: string }>(`${BASE}/${id}/ap-bills`, body),
  // P4 — investigation, determinations, corrective actions and evidence.
  investigation: (id: string, action: 'start' | 'submit' | 'approve' | 'send-back' | 'reopen', body: A.InvestigationActionInput) => apiPost<{ id: string; version: number }>(`${BASE}/${id}/investigation/${action}`, body),
  patchInvestigation: (id: string, body: A.PatchInvestigationInput) => apiPatch<{ id: string; version: number }>(`${BASE}/${id}/investigation`, body),
  resolveQuestion: (id: string, qid: string, body: A.ResolveQuestionInput) => apiPost<{ id: string; version: number }>(`${BASE}/${id}/questions/${qid}/resolve`, body),
  factorLevel: (id: string, fid: string, body: A.FactorLevelInput) => apiPatch<{ id: string; version: number }>(`${BASE}/${id}/factors/${fid}`, body),
  reviewItem: (id: string, key: string, body: A.ReviewItemInput) => apiPut<{ id: string; version: number }>(`${BASE}/${id}/review-items/${key}`, body),
  determination: (id: string, kind: 'fault' | 'preventability' | 'cpdp' | 'legal', body: A.DeterminationInput) => apiPut<{ id: string; version: number }>(`${BASE}/${id}/determinations/${kind}`, body),
  patchCorrectiveAction: (actionId: string, body: A.PatchCorrectiveActionInput) => apiPatch<{ id: string; version: number }>(`${BASE}/corrective-actions/${actionId}`, body),
  uploadEvidence: (id: string, body: A.UploadEvidenceInput) => apiPost<{ ids: string[] }>(`${BASE}/${id}/evidence`, body),
  evidenceVersion: (docId: string, body: A.EvidenceVersionInput) => apiPost<{ id: string; version: number }>(`${BASE}/evidence/${docId}/versions`, body),
  removeEvidence: (docId: string, body: A.RemoveEvidenceInput) => apiPost<{ id: string }>(`${BASE}/evidence/${docId}/remove`, body),
  evidenceDownload: (docId: string, version?: number) => apiGet<{ fileId: string; fileName: string; contentType: string; version: number }>(`${BASE}/evidence/${docId}/download`, version ? { version } : {}),
};

// P5 — analytics, profile sections and the sidebar count (numbers from the server's shared rule; never computed here).
export const useAnalytics = (q: A.RangeQuery, enabled = true): UseQueryResult<A.AnalyticsResponse> =>
  useQuery({ queryKey: [...ROOT, 'analytics', q], queryFn: () => apiGet<A.AnalyticsResponse>(`${BASE}/analytics`, q as Record<string, unknown>), enabled });
export const useProfileAccidents = (kind: 'truck' | 'trailer' | 'driver', id: string, enabled = true): UseQueryResult<A.ProfileAccidentsResponse> =>
  useQuery({ queryKey: [...ROOT, 'profile', kind, id], queryFn: () => apiGet<A.ProfileAccidentsResponse>(`${BASE}/profiles/${kind}/${id}`), enabled: enabled && Boolean(id), retry: false });
export const useAccidentCounts = (enabled: boolean): UseQueryResult<A.AccidentCounts> =>
  useQuery({ queryKey: [...ROOT, 'counts'], queryFn: () => apiGet<A.AccidentCounts>(`${BASE}/counts`, undefined, { background: true }), enabled, refetchInterval: 60_000, refetchOnWindowFocus: true, retry: false });

export const useEvidence =(id: string, includeRemoved: boolean): UseQueryResult<A.EvidenceListResponse> =>
  useQuery({ queryKey: [...ROOT, 'evidence', id, includeRemoved], queryFn: () => apiGet<A.EvidenceListResponse>(`${BASE}/${id}/evidence`, { includeRemoved: String(includeRemoved) }), enabled: Boolean(id) });

/** The signed-in account's grant of one permission code. */
export function useCan(code: string): boolean {
  const account = useAccount();
  return account?.permissions.includes(code) ?? false;
}

/** Field errors from a 422 problem, keyed by path. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const list = (error.problem as { errors?: { path: string; message: string }[] } | null)?.errors ?? [];
  const out: Record<string, string> = {};
  for (const e of list) if (!out[e.path]) out[e.path] = e.message;
  return out;
}

export function problemText(error: unknown): string {
  if (error instanceof ApiError) {
    const p = error.problem as { blockers?: { text: string }[] } | null;
    if (p?.blockers?.length) return p.blockers.map((b) => b.text).join(' · ');
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** One write: refreshes every accident read and says what happened (or what went wrong, in the server's words). */
export function useAccWrite<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>, success?: string | ((r: TResult, a: TArgs) => string)) {
  const client = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, args) => {
      await client.invalidateQueries({ queryKey: ROOT });
      if (success) toast({ tone: 'success', title: typeof success === 'function' ? success(result, args) : success });
    },
    onError: (error) => {
      const status = error instanceof ApiError ? error.status : 0;
      toast({
        tone: 'danger',
        title: status === 409 ? 'Not saved — someone changed this case' : status === 403 ? 'Not allowed' : status === 422 ? 'Check the form' : 'Something went wrong',
        description: problemText(error),
      });
      void client.invalidateQueries({ queryKey: ROOT });
    },
  });
}
