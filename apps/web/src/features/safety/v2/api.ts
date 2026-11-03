import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  CompanyChecklistRow,
  DriverCharge,
  DriverComplianceView,
  SafetyAccident,
  SafetyAccountingEntry,
  SafetyCaseDetail,
  SafetyCaseType,
  SafetyClaim,
  SafetyDocumentKind,
  SafetyDrugTest,
  SafetyOverview,
  SafetyPerson,
  SafetyPickers,
  SafetyReview,
  SafetyReviewKind,
  SafetyRoadsideInspection,
  SafetyViolation,
  SafetyViolationCase,
  TestingSummary,
  UnitComplianceRow,
} from '@neway/shared';
import { useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api-client';
import { uploadFile } from '@/lib/files';

/**
 * Safety v2's data layer. Every read is a server read and every write a server write; the
 * browser's workspace store is not touched. One cache root, `['safety-v2']`: a write to one case
 * moves others (an accident opens a claim, a review, two tests), so a write refreshes them all.
 */

const BASE = '/safety';
const ROOT = ['safety-v2'] as const;

export const safetyV2Keys = {
  all: ROOT,
  list: (kind: string, extra?: string) => [...ROOT, kind, 'list', extra ?? ''] as const,
  detail: (kind: string, id: string) => [...ROOT, kind, 'detail', id] as const,
};

export interface ReviewDetail extends SafetyCaseDetail<SafetyReview> {
  related: {
    accidents: { id: string; number: string; occurredAt: string; stage: string }[];
    claims: { id: string; number: string; openedOn: string; stage: string }[];
    violations: { id: string; number: string; occurredAt: string; description: string }[];
  };
}

const q = <T,>(key: readonly unknown[], path: string, params?: Record<string, unknown>, enabled = true) => ({
  queryKey: key,
  queryFn: () => apiGet<T>(path, params),
  enabled,
});

export const useSafetyOverview = (): UseQueryResult<SafetyOverview> => useQuery(q<SafetyOverview>([...ROOT, 'overview'], `${BASE}/overview`));
export const useSafetyPickers = (): UseQueryResult<SafetyPickers> =>
  useQuery({ ...q<SafetyPickers>([...ROOT, 'pickers'], `${BASE}/pickers`), staleTime: 60_000 });
export const useSafetyPeople = (): UseQueryResult<SafetyPerson[]> =>
  useQuery({ ...q<SafetyPerson[]>([...ROOT, 'people'], `${BASE}/people`), staleTime: 60_000 });

export const useAccidents = (): UseQueryResult<SafetyAccident[]> => useQuery(q<SafetyAccident[]>(safetyV2Keys.list('accidents'), `${BASE}/accidents`));
export const useAccident = (id: string): UseQueryResult<SafetyCaseDetail<SafetyAccident>> =>
  useQuery(q<SafetyCaseDetail<SafetyAccident>>(safetyV2Keys.detail('accidents', id), `${BASE}/accidents/${id}`, undefined, Boolean(id)));

export const useClaims = (): UseQueryResult<SafetyClaim[]> => useQuery(q<SafetyClaim[]>(safetyV2Keys.list('claims'), `${BASE}/claims`));
export const useClaim = (id: string): UseQueryResult<SafetyCaseDetail<SafetyClaim>> =>
  useQuery(q<SafetyCaseDetail<SafetyClaim>>(safetyV2Keys.detail('claims', id), `${BASE}/claims/${id}`, undefined, Boolean(id)));

export const useDrugTests = (): UseQueryResult<SafetyDrugTest[]> => useQuery(q<SafetyDrugTest[]>(safetyV2Keys.list('tests'), `${BASE}/tests`));
/** One driver's tests, for the driver's Documents tab (results redacted by the server without safety_testing.view). */
export const useDriverDrugTests = (driverId: string, enabled = true): UseQueryResult<SafetyDrugTest[]> =>
  useQuery(q<SafetyDrugTest[]>(safetyV2Keys.list('tests', driverId), `${BASE}/tests`, { driverId }, enabled));
export const useDrugTest = (id: string | null): UseQueryResult<SafetyCaseDetail<SafetyDrugTest>> =>
  useQuery(q<SafetyCaseDetail<SafetyDrugTest>>(safetyV2Keys.detail('tests', id ?? ''), `${BASE}/tests/${id}`, undefined, Boolean(id)));

export const useViolations = (): UseQueryResult<SafetyViolation[]> => useQuery(q<SafetyViolation[]>(safetyV2Keys.list('violations'), `${BASE}/violations`));
/** One row per paper (owner, 2026-10-21): each case holds every violation on it. */
export const useViolationCases = (): UseQueryResult<SafetyViolationCase[]> => useQuery(q<SafetyViolationCase[]>(safetyV2Keys.list('violation-cases'), `${BASE}/violation-cases`));
export const useViolation = (id: string | null): UseQueryResult<SafetyCaseDetail<SafetyViolation>> =>
  useQuery(q<SafetyCaseDetail<SafetyViolation>>(safetyV2Keys.detail('violations', id ?? ''), `${BASE}/violations/${id}`, undefined, Boolean(id)));

export const useRoadsideInspections = (): UseQueryResult<SafetyRoadsideInspection[]> =>
  useQuery(q<SafetyRoadsideInspection[]>(safetyV2Keys.list('roadside'), `${BASE}/roadside`));
export const useRoadsideInspection = (id: string | null): UseQueryResult<SafetyCaseDetail<SafetyRoadsideInspection>> =>
  useQuery(q<SafetyCaseDetail<SafetyRoadsideInspection>>(safetyV2Keys.detail('roadside', id ?? ''), `${BASE}/roadside/${id}`, undefined, Boolean(id)));

export const useSafetyReviews = (kind?: SafetyReviewKind): UseQueryResult<SafetyReview[]> =>
  useQuery(q<SafetyReview[]>(safetyV2Keys.list('reviews', kind), `${BASE}/reviews`, { kind }));
export const useSafetyReview = (id: string | null): UseQueryResult<ReviewDetail> =>
  useQuery(q<ReviewDetail>(safetyV2Keys.detail('reviews', id ?? ''), `${BASE}/reviews/${id}`, undefined, Boolean(id)));

/** Driver charges (Claims v2): all of them, one claim's, or one driver's. */
export const useDriverCharges = (params: { claimId?: string; driverId?: string } = {}, enabled = true): UseQueryResult<DriverCharge[]> =>
  useQuery(q<DriverCharge[]>(safetyV2Keys.list('charges', `${params.claimId ?? ''}|${params.driverId ?? ''}`), `${BASE}/driver-charges`, params, enabled));

export const useAccountingEntries = (): UseQueryResult<SafetyAccountingEntry[]> =>
  useQuery(q<SafetyAccountingEntry[]>(safetyV2Keys.list('accounting'), `${BASE}/accounting-entries`));

export const useComplianceDrivers = (enabled = true): UseQueryResult<DriverComplianceView> =>
  useQuery(q<DriverComplianceView>([...ROOT, 'compliance', 'drivers'], `${BASE}/compliance/drivers`, undefined, enabled));
export const useComplianceVehicles = (enabled = true): UseQueryResult<UnitComplianceRow[]> =>
  useQuery(q<UnitComplianceRow[]>([...ROOT, 'compliance', 'vehicles'], `${BASE}/compliance/vehicles`, undefined, enabled));
export const useComplianceCompany = (enabled = true): UseQueryResult<CompanyChecklistRow[]> =>
  useQuery(q<CompanyChecklistRow[]>([...ROOT, 'compliance', 'company'], `${BASE}/compliance/company`, undefined, enabled));
export const useTestingSummary = (enabled = true): UseQueryResult<TestingSummary> =>
  useQuery(q<TestingSummary>([...ROOT, 'compliance', 'testing'], `${BASE}/compliance/testing`, undefined, enabled));

/** The signed-in account's grant of one permission code. */
export function useCan(code: string): boolean {
  const account = useAccount();
  return account?.permissions.includes(code) ?? false;
}

/**
 * One write against the Safety API: refreshes every Safety read afterwards and says what went
 * wrong in words the server chose (a 409 lists what is missing).
 */
export function useSafetyWrite<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>, success?: string | ((r: TResult) => string)) {
  const client = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ROOT });
      if (success) toast({ tone: 'success', title: typeof success === 'function' ? success(result) : success });
    },
    onError: (error) => {
      toast({ tone: 'danger', title: errorTitle(error), description: errorText(error) });
      void client.invalidateQueries({ queryKey: ROOT });
    },
  });
}

export function errorTitle(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return 'Not saved';
    if (error.status === 403) return 'Not allowed';
    if (error.status === 422) return 'Check the form';
  }
  return 'Something went wrong';
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const missing = (error.problem as { missing?: unknown } | null)?.missing;
    if (Array.isArray(missing) && missing.length > 0) return missing.map(String).join(' · ');
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------- writes

export const safetyApi = {
  post: <T,>(path: string, body: unknown) => apiPost<T>(`${BASE}${path}`, body),
  patch: <T,>(path: string, body: unknown) => apiPatch<T>(`${BASE}${path}`, body),
  /** Uploads the bytes, then links them to the case. */
  async attach(caseType: SafetyCaseType, caseId: string, file: File, kind: SafetyDocumentKind, title?: string) {
    const stored = await uploadFile(file);
    return apiPost(`${BASE}/documents`, { caseType, caseId, fileId: stored.id, kind, title });
  },
  voidDocument: (id: string, reason: string) => apiPost(`${BASE}/documents/${id}/void`, { reason }),
};
