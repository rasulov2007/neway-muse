import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  ActionPlanRecord,
  ApplicantRecord,
  AttendanceEntryRecord,
  AttendanceSummary,
  InterviewRecord,
  JobOpeningRecord,
  OfferRecord,
  OnboardingChecklistRecord,
  OnboardingItemRecord,
  OnboardingTemplate,
  OnboardingSummary,
  PerformanceCycleRecord,
  PerformanceFeedbackRecord,
  PerformanceGoalRecord,
  PerformanceReviewRecord,
  PtoBalance,
  PtoConflict,
  PtoPolicyRecord,
  PtoRequestRecord,
  PtoSummary,
  PtoTransactionRecord,
  RecruitingSummary,
  WorkforcePerformanceSummary,
} from '@neway/shared';
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';

/**
 * The Phase 11 data layer.
 *
 * One file, because these five modules are one lifecycle and share a cache namespace: hiring a
 * candidate creates an employee and an onboarding plan, so a write in recruiting has to invalidate
 * onboarding and the workforce too. Splitting them into five isolated hooks is how a page ends up
 * showing a candidate as hired next to an onboarding list that has not noticed.
 */

export interface Paged<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

const BASE = '/hr';

/** Everything the workforce touches. A hire changes recruiting, onboarding *and* the employee list. */
export function useInvalidateHr(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['hr'] }),
      client.invalidateQueries({ queryKey: ['employees'] }),
    ]);
  };
}

function list<T>(key: unknown[], path: string, params?: Record<string, unknown>) {
  return { queryKey: key, queryFn: () => apiGet<T>(path, params) };
}

// ------------------------------------------------------------------------------------ recruiting

export function useRecruitingSummary(): UseQueryResult<RecruitingSummary> {
  return useQuery(
    list<RecruitingSummary>(['hr', 'recruiting', 'summary'], `${BASE}/recruiting/summary`),
  );
}

export function useJobOpenings(status?: string): UseQueryResult<JobOpeningRecord[]> {
  return useQuery(
    list<JobOpeningRecord[]>(['hr', 'jobs', status ?? 'all'], `${BASE}/recruiting/jobs`, {
      status,
    }),
  );
}

export function useCandidates(
  params: Record<string, unknown>,
): UseQueryResult<Paged<ApplicantRecord>> {
  return useQuery({
    ...list<Paged<ApplicantRecord>>(
      ['hr', 'candidates', params],
      `${BASE}/recruiting/candidates`,
      params,
    ),
    placeholderData: (previous) => previous,
  });
}

export function useCandidate(id: string): UseQueryResult<ApplicantRecord> {
  return useQuery({
    ...list<ApplicantRecord>(
      ['hr', 'candidate', id],
      `${BASE}/recruiting/candidates/${encodeURIComponent(id)}`,
    ),
    enabled: id.length > 0,
  });
}

export function useInterviews(candidateId: string): UseQueryResult<InterviewRecord[]> {
  return useQuery({
    ...list<InterviewRecord[]>(
      ['hr', 'interviews', candidateId],
      `${BASE}/recruiting/candidates/${encodeURIComponent(candidateId)}/interviews`,
    ),
    enabled: candidateId.length > 0,
  });
}

export function useOffers(candidateId: string): UseQueryResult<OfferRecord[]> {
  return useQuery({
    ...list<OfferRecord[]>(
      ['hr', 'offers', candidateId],
      `${BASE}/recruiting/candidates/${encodeURIComponent(candidateId)}/offers`,
    ),
    enabled: candidateId.length > 0,
  });
}

export function useHrMutation<TInput, TResult>(send: (input: TInput) => Promise<TResult>) {
  const invalidate = useInvalidateHr();
  return useMutation({ mutationFn: send, onSuccess: invalidate });
}

export const hrApi = {
  createJob: (body: unknown) => apiPost<JobOpeningRecord>(`${BASE}/recruiting/jobs`, body),
  setJobStatus: (id: string, status: string) =>
    apiPost<JobOpeningRecord>(`${BASE}/recruiting/jobs/${encodeURIComponent(id)}/status`, {
      status,
    }),
  createCandidate: (body: unknown) =>
    apiPost<ApplicantRecord>(`${BASE}/recruiting/candidates`, body),
  updateCandidate: (id: string, body: unknown) =>
    apiPatch<ApplicantRecord>(`${BASE}/recruiting/candidates/${encodeURIComponent(id)}`, body),
  moveStage: (id: string, body: unknown) =>
    apiPost<ApplicantRecord>(`${BASE}/recruiting/candidates/${encodeURIComponent(id)}/stage`, body),
  hire: (id: string, body: unknown) =>
    apiPost<{ employeeId: string; employeeNumber: string; onboardingChecklistId: string | null }>(
      `${BASE}/recruiting/candidates/${encodeURIComponent(id)}/hire`,
      body,
    ),
  scheduleInterview: (id: string, body: unknown) =>
    apiPost<InterviewRecord[]>(
      `${BASE}/recruiting/candidates/${encodeURIComponent(id)}/interviews`,
      body,
    ),
  recordInterviewOutcome: (id: string, body: unknown) =>
    apiPost<InterviewRecord[]>(
      `${BASE}/recruiting/interviews/${encodeURIComponent(id)}/outcome`,
      body,
    ),
  createOffer: (id: string, body: unknown) =>
    apiPost<OfferRecord[]>(`${BASE}/recruiting/candidates/${encodeURIComponent(id)}/offers`, body),
  setOfferStatus: (id: string, status: string) =>
    apiPost<OfferRecord[]>(`${BASE}/recruiting/offers/${encodeURIComponent(id)}/status`, {
      status,
    }),

  createOnboarding: (body: unknown) =>
    apiPost<OnboardingChecklistRecord>(`${BASE}/onboarding`, body),
  addOnboardingItem: (id: string, body: unknown) =>
    apiPost<OnboardingItemRecord[]>(`${BASE}/onboarding/${encodeURIComponent(id)}/items`, body),
  updateOnboardingItem: (itemId: string, body: unknown) =>
    apiPatch<OnboardingItemRecord[]>(
      `${BASE}/onboarding/items/${encodeURIComponent(itemId)}`,
      body,
    ),

  createAttendance: (body: unknown) => apiPost<AttendanceEntryRecord>(`${BASE}/attendance`, body),
  updateAttendance: (id: string, body: unknown) =>
    apiPatch<AttendanceEntryRecord>(`${BASE}/attendance/${encodeURIComponent(id)}`, body),
  approveAttendance: (id: string) =>
    apiPost<AttendanceEntryRecord>(`${BASE}/attendance/${encodeURIComponent(id)}/approve`, {}),
  resolveAttendance: (id: string, note: string) =>
    apiPost<AttendanceEntryRecord>(`${BASE}/attendance/${encodeURIComponent(id)}/resolve`, {
      note,
    }),

  createPtoPolicy: (body: unknown) => apiPost<PtoPolicyRecord[]>(`${BASE}/pto/policies`, body),
  createPtoRequest: (body: unknown) =>
    apiPost<{ request: PtoRequestRecord; conflicts: PtoConflict[] }>(`${BASE}/pto/requests`, body),
  decidePto: (id: string, body: unknown) =>
    apiPost<PtoRequestRecord>(`${BASE}/pto/requests/${encodeURIComponent(id)}/decide`, body),
  adjustPto: (body: unknown) => apiPost<PtoBalance[]>(`${BASE}/pto/balances/adjust`, body),

  createCycle: (body: unknown) =>
    apiPost<PerformanceCycleRecord[]>(`${BASE}/performance/cycles`, body),
  createGoal: (body: unknown) => apiPost<PerformanceGoalRecord>(`${BASE}/performance/goals`, body),
  updateGoal: (id: string, body: unknown) =>
    apiPatch<PerformanceGoalRecord>(`${BASE}/performance/goals/${encodeURIComponent(id)}`, body),
  createReview: (body: unknown) =>
    apiPost<PerformanceReviewRecord>(`${BASE}/performance/reviews`, body),
  updateReview: (id: string, body: unknown) =>
    apiPatch<PerformanceReviewRecord>(
      `${BASE}/performance/reviews/${encodeURIComponent(id)}`,
      body,
    ),
  changeReviewStatus: (id: string, body: unknown) =>
    apiPost<PerformanceReviewRecord>(
      `${BASE}/performance/reviews/${encodeURIComponent(id)}/status`,
      body,
    ),
  addFeedback: (body: unknown) =>
    apiPost<PerformanceFeedbackRecord[]>(`${BASE}/performance/feedback`, body),
  createActionPlan: (body: unknown) =>
    apiPost<ActionPlanRecord[]>(`${BASE}/performance/action-plans`, body),
  updateActionPlan: (id: string, body: unknown) =>
    apiPatch<ActionPlanRecord[]>(
      `${BASE}/performance/action-plans/${encodeURIComponent(id)}`,
      body,
    ),
};

// ------------------------------------------------------------------------------------ onboarding

export function useOnboardingSummary(): UseQueryResult<OnboardingSummary> {
  return useQuery(
    list<OnboardingSummary>(['hr', 'onboarding', 'summary'], `${BASE}/onboarding/summary`),
  );
}

export function useOnboardingList(
  params: Record<string, unknown>,
): UseQueryResult<Paged<OnboardingChecklistRecord>> {
  return useQuery({
    ...list<Paged<OnboardingChecklistRecord>>(
      ['hr', 'onboarding', params],
      `${BASE}/onboarding`,
      params,
    ),
    placeholderData: (previous) => previous,
  });
}

export function useOnboarding(id: string): UseQueryResult<OnboardingChecklistRecord> {
  return useQuery({
    ...list<OnboardingChecklistRecord>(
      ['hr', 'onboarding', 'one', id],
      `${BASE}/onboarding/${encodeURIComponent(id)}`,
    ),
    enabled: id.length > 0,
  });
}

export function useOnboardingTemplates(): UseQueryResult<OnboardingTemplate[]> {
  return useQuery(
    list<OnboardingTemplate[]>(['hr', 'onboarding', 'templates'], `${BASE}/onboarding/templates`),
  );
}

export function useOnboardingItems(id: string): UseQueryResult<OnboardingItemRecord[]> {
  return useQuery({
    ...list<OnboardingItemRecord[]>(
      ['hr', 'onboarding', 'items', id],
      `${BASE}/onboarding/${encodeURIComponent(id)}/items`,
    ),
    enabled: id.length > 0,
  });
}

// ------------------------------------------------------------------------------------ attendance

export function useAttendanceSummary(onDate?: string): UseQueryResult<AttendanceSummary> {
  return useQuery(
    list<AttendanceSummary>(
      ['hr', 'attendance', 'summary', onDate ?? 'today'],
      `${BASE}/attendance/summary`,
      {
        onDate,
      },
    ),
  );
}

export function useAttendance(
  params: Record<string, unknown>,
): UseQueryResult<Paged<AttendanceEntryRecord>> {
  return useQuery({
    ...list<Paged<AttendanceEntryRecord>>(
      ['hr', 'attendance', params],
      `${BASE}/attendance`,
      params,
    ),
    placeholderData: (previous) => previous,
  });
}

// ------------------------------------------------------------------------------------------ pto

export function usePtoSummary(): UseQueryResult<PtoSummary> {
  return useQuery(list<PtoSummary>(['hr', 'pto', 'summary'], `${BASE}/pto/summary`));
}

export function usePtoPolicies(): UseQueryResult<PtoPolicyRecord[]> {
  return useQuery(list<PtoPolicyRecord[]>(['hr', 'pto', 'policies'], `${BASE}/pto/policies`));
}

export function usePtoRequests(
  params: Record<string, unknown>,
): UseQueryResult<Paged<PtoRequestRecord>> {
  return useQuery({
    ...list<Paged<PtoRequestRecord>>(['hr', 'pto', params], `${BASE}/pto/requests`, params),
    placeholderData: (previous) => previous,
  });
}

export function usePtoBalances(employeeId: string): UseQueryResult<PtoBalance[]> {
  return useQuery({
    ...list<PtoBalance[]>(
      ['hr', 'pto', 'balances', employeeId],
      `${BASE}/pto/balances/${encodeURIComponent(employeeId)}`,
    ),
    enabled: employeeId.length > 0,
  });
}

export function usePtoTransactions(employeeId: string): UseQueryResult<PtoTransactionRecord[]> {
  return useQuery({
    ...list<PtoTransactionRecord[]>(
      ['hr', 'pto', 'transactions', employeeId],
      `${BASE}/pto/transactions/${encodeURIComponent(employeeId)}`,
    ),
    enabled: employeeId.length > 0,
  });
}

// ----------------------------------------------------------------------------------- performance

export function usePerformanceSummary(): UseQueryResult<WorkforcePerformanceSummary> {
  return useQuery(
    list<WorkforcePerformanceSummary>(
      ['hr', 'performance', 'summary'],
      `${BASE}/performance/summary`,
    ),
  );
}

export function usePerformanceCycles(): UseQueryResult<PerformanceCycleRecord[]> {
  return useQuery(list<PerformanceCycleRecord[]>(['hr', 'cycles'], `${BASE}/performance/cycles`));
}

export function useGoals(
  params: Record<string, unknown>,
): UseQueryResult<Paged<PerformanceGoalRecord>> {
  return useQuery({
    ...list<Paged<PerformanceGoalRecord>>(
      ['hr', 'goals', params],
      `${BASE}/performance/goals`,
      params,
    ),
    placeholderData: (previous) => previous,
  });
}

export function useReviews(
  params: Record<string, unknown>,
): UseQueryResult<Paged<PerformanceReviewRecord>> {
  return useQuery({
    ...list<Paged<PerformanceReviewRecord>>(
      ['hr', 'reviews', params],
      `${BASE}/performance/reviews`,
      params,
    ),
    placeholderData: (previous) => previous,
  });
}

export function useFeedback(employeeId: string): UseQueryResult<PerformanceFeedbackRecord[]> {
  return useQuery({
    ...list<PerformanceFeedbackRecord[]>(
      ['hr', 'feedback', employeeId],
      `${BASE}/performance/feedback/${encodeURIComponent(employeeId)}`,
    ),
    enabled: employeeId.length > 0,
  });
}

export function useActionPlans(employeeId?: string): UseQueryResult<ActionPlanRecord[]> {
  return useQuery(
    list<ActionPlanRecord[]>(
      ['hr', 'action-plans', employeeId ?? 'all'],
      `${BASE}/performance/action-plans`,
      {
        employeeId,
      },
    ),
  );
}
