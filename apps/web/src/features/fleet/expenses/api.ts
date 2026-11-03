import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  FleetExpenseDashboard,
  FleetExpenseDetail,
  FleetExpenseList,
  FleetExpenseListQueryInput,
  FleetExpenseProblem,
  FleetExpenseRecoveryAction,
  SaveFleetExpenseInput,
} from '@neway/shared';
import { useAccount } from '@/features/auth/auth-context';
import { API_BASE_URL } from '@/lib/api';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api-client';
import { sessionToken } from '@/lib/session';

/**
 * Fleet Expenses over the API: the list, the dashboard, one expense, and the writes on it.
 *
 * Every key sits under `['fleet', ...]` on purpose: `useInvalidateFleet` clears that prefix after
 * any fleet write, and a repair completed on the work order page has to move these figures too.
 * The company is in each key so one sign-in's cache never answers for another.
 */
const BASE = '/fleet/expenses';
const enc = encodeURIComponent;

export interface FleetExpenseOptions {
  today: string;
  defaultFrom: string;
  defaultTo: string;
  trucks: Array<{ id: string; unitNumber: string }>;
  drivers: Array<{ id: string; name: string }>;
  vendors: Array<{ id: string; name: string }>;
  permissions: { canView: boolean; canEdit: boolean; canPost: boolean; canRecover: boolean };
}

export interface DuplicateMatch {
  workOrderId: string;
  roNumber: string;
  amountCents: number;
  date: string;
  vendorName: string | null;
}

export type FileKind = 'receipt' | 'invoice' | 'efs_receipt' | 'other';

export type ExpenseDashboardParams = Pick<
  FleetExpenseListQueryInput,
  'from' | 'to' | 'truckId' | 'category' | 'chargeTo'
>;

export const expenseKeys = {
  all: ['fleet', 'expenses'] as const,
  options: (companyId: string | null) => ['fleet', 'expenses', 'options', companyId] as const,
  list: (companyId: string | null, query: FleetExpenseListQueryInput) =>
    ['fleet', 'expenses', 'list', companyId, query] as const,
  dashboard: (companyId: string | null, params: ExpenseDashboardParams) =>
    ['fleet', 'expenses', 'dashboard', companyId, params] as const,
  detail: (companyId: string | null, id: string) =>
    ['fleet', 'expenses', 'detail', companyId, id] as const,
};

/** Expenses are open to the fleet's cost view and to Accounting; the server decides the rest. */
export function useCanSeeExpenses(): boolean {
  const account = useAccount();
  return (
    account !== null &&
    (account.isOwner ||
      account.permissions.includes('maintenance_costs.view') ||
      account.permissions.includes('accounting.view'))
  );
}

export function useExpenseOptions(): UseQueryResult<FleetExpenseOptions> {
  const account = useAccount();
  const allowed = useCanSeeExpenses();
  return useQuery({
    queryKey: expenseKeys.options(account?.companyId ?? null),
    queryFn: () => apiGet<FleetExpenseOptions>(`${BASE}/options`),
    enabled: allowed,
    staleTime: 60_000,
  });
}

export function useExpenseList(query: FleetExpenseListQueryInput): UseQueryResult<FleetExpenseList> {
  const account = useAccount();
  const allowed = useCanSeeExpenses();
  return useQuery({
    queryKey: expenseKeys.list(account?.companyId ?? null, query),
    queryFn: () => apiGet<FleetExpenseList>(BASE, query as Record<string, unknown>),
    enabled: allowed,
    // A filter or page change keeps the last rows on screen while the next ones load.
    placeholderData: (previous) => previous,
    staleTime: 15_000,
  });
}

export function useExpenseDashboard(params: ExpenseDashboardParams): UseQueryResult<FleetExpenseDashboard> {
  const account = useAccount();
  const allowed = useCanSeeExpenses();
  return useQuery({
    queryKey: expenseKeys.dashboard(account?.companyId ?? null, params),
    queryFn: () => apiGet<FleetExpenseDashboard>(`${BASE}/dashboard`, params as Record<string, unknown>),
    enabled: allowed,
    placeholderData: (previous) => previous,
    staleTime: 15_000,
  });
}

export function useExpenseDetail(id: string | null): UseQueryResult<FleetExpenseDetail> {
  const account = useAccount();
  const allowed = useCanSeeExpenses();
  return useQuery({
    queryKey: expenseKeys.detail(account?.companyId ?? null, id ?? ''),
    queryFn: () => apiGet<FleetExpenseDetail>(`${BASE}/${enc(id ?? '')}`),
    enabled: allowed && Boolean(id),
  });
}

export function checkDuplicate(params: {
  truckId: string;
  category: string;
  amountCents: number;
  expenseDate: string;
  invoiceNumber: string | null;
}): Promise<{ matches: DuplicateMatch[] }> {
  return apiGet<{ matches: DuplicateMatch[] }>(`${BASE}/duplicate-check`, params);
}

/**
 * After any write: the answer becomes the cached detail, and everything under `fleet` refetches
 * (the list, the dashboard, the Costs summary and the truck tab all count this expense).
 */
function useSettle() {
  const queryClient = useQueryClient();
  const account = useAccount();
  return async (detail: FleetExpenseDetail) => {
    queryClient.setQueryData(expenseKeys.detail(account?.companyId ?? null, detail.id), detail);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['fleet'] }),
      queryClient.invalidateQueries({ queryKey: ['accounting'] }),
    ]);
    return detail;
  };
}

export function useSaveExpense() {
  const settle = useSettle();
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: SaveFleetExpenseInput }) =>
      id
        ? apiPatch<FleetExpenseDetail>(`${BASE}/${enc(id)}`, body)
        : apiPost<FleetExpenseDetail>(BASE, body),
    onSuccess: settle,
  });
}

export function useVoidExpense() {
  const settle = useSettle();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiPost<FleetExpenseDetail>(`${BASE}/${enc(id)}/void`, { reason }),
    onSuccess: settle,
  });
}

export function usePostExpense() {
  const settle = useSettle();
  return useMutation({
    mutationFn: (id: string) => apiPost<FleetExpenseDetail>(`${BASE}/${enc(id)}/post`, {}),
    onSuccess: settle,
  });
}

export function useRecoveryAction() {
  const settle = useSettle();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: FleetExpenseRecoveryAction }) =>
      apiPost<FleetExpenseDetail>(`${BASE}/${enc(id)}/recovery`, action),
    onSuccess: settle,
  });
}

export function useAttachFile() {
  const settle = useSettle();
  return useMutation({
    mutationFn: ({ id, fileId, kind }: { id: string; fileId: string; kind: FileKind }) =>
      apiPost<FleetExpenseDetail>(`${BASE}/${enc(id)}/files`, { fileId, kind }),
    onSuccess: settle,
  });
}

export function useRemoveFile() {
  const settle = useSettle();
  return useMutation({
    mutationFn: ({ id, fileRowId, reason }: { id: string; fileRowId: string; reason: string }) =>
      apiPost<FleetExpenseDetail>(`${BASE}/${enc(id)}/files/${enc(fileRowId)}/remove`, { reason }),
    onSuccess: settle,
  });
}

// ------------------------------------------------------------------------------- errors

/**
 * The per-field problems a refused save came back with. The expense endpoints answer 422 with
 * `{ message, problems: [{ field, message }] }`; a schema refusal answers with `errors` instead.
 */
export function problemsOf(error: unknown): FleetExpenseProblem[] {
  if (!(error instanceof ApiError)) return [];
  const body = error.problem as unknown as { problems?: unknown } | null;
  const own = Array.isArray(body?.problems)
    ? body.problems.flatMap((p) =>
        typeof p === 'object' && p !== null && 'field' in p && 'message' in p
          ? [{ field: String((p as { field: unknown }).field), message: String((p as { message: unknown }).message) }]
          : [],
      )
    : [];
  return [...own, ...error.issues.map((i) => ({ field: i.path, message: i.message }))];
}

/** A sentence for the person: the server's own words when it sent any. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409 && duplicatesOf(error).length === 0) {
      return 'Someone else changed this expense while you were editing it. Nothing was saved. Reload it and make your change again.';
    }
    const body = error.problem as unknown as { message?: unknown; detail?: unknown } | null;
    if (typeof body?.detail === 'string' && body.detail) return body.detail;
    if (typeof body?.message === 'string' && body.message) return body.message;
    if (Array.isArray(body?.message)) return body.message.map(String).join(' ');
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong. Nothing was saved.';
}

/** A stale save: someone else saved first. (A 409 that carries `duplicates` is something else.) */
export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && duplicatesOf(error).length === 0;
}

/** The repairs a save looks like, when the server refused it as a possible duplicate (409). */
export function duplicatesOf(error: unknown): DuplicateMatch[] {
  if (!(error instanceof ApiError) || error.status !== 409) return [];
  const body = error.problem as unknown as { duplicates?: unknown } | null;
  return Array.isArray(body?.duplicates) ? (body.duplicates as DuplicateMatch[]) : [];
}

// ------------------------------------------------------------------------------- PDFs

/**
 * Fetches a PDF the API makes, with the session, and opens or saves it. A browser does not put
 * the bearer token on a plain link, so the bytes are fetched here and handed over as a blob.
 * The tab for "open" is created inside the click, before the await, or popup blockers refuse it.
 */
export async function fetchPdf(
  path: string,
  params: Record<string, unknown>,
  mode: 'open' | 'download',
  fileName: string,
): Promise<void> {
  const tab = mode === 'open' ? window.open('', '_blank') : null;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  try {
    const token = sessionToken();
    const response = await fetch(`${API_BASE_URL}${path}${suffix}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      throw new Error(
        response.status === 403
          ? 'Your role cannot export these expenses.'
          : response.status === 401
            ? 'Your session has expired. Sign in again and try once more.'
            : `The PDF could not be prepared (${response.status}).`,
      );
    }
    const url = URL.createObjectURL(await response.blob());
    if (mode === 'open') {
      if (tab) tab.location.href = url;
      else window.open(url, '_blank');
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

export const expensePdfPath = (id: string) => `${BASE}/${enc(id)}/pdf`;
export const EXPENSE_REPORT_PDF_PATH = `${BASE}/report.pdf`;

/** The stored file, for preview and download through the session. */
export const storedFileUrl = (fileId: string) => `${API_BASE_URL}/files/${enc(fileId)}`;
