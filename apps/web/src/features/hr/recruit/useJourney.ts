import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  CandidateCostInput,
  CandidateCostView,
  CandidateConsentView,
  CandidateJourney,
  ConsentLinkIssued,
  ConsentSessionView,
  HireCandidateInput,
  LinkDeliveryView,
  SafetyCheckRequestInput,
  SafetyCheckView,
  SendLinkInput,
  SmsConsentInput,
  SmsConsentView,
  OnboardingTaskUpdateInput,
  OnboardingTaskView,
  RecruitDashboard,
  RecruitScope,
  SafetyReportUploadInput,
  SafetyReportView,
  SafetyStatusChangeInput,
  TravelItemInput,
  TravelItemView,
} from '@neway/shared';
import { API_PREFIX } from '@neway/shared';
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';

/**
 * The candidate journey and the Recruiting dashboard (owner brief, 2026-10-11). Everything sits
 * under the ['hr'] cache prefix, so a write refreshes the candidate, the list and the dashboard.
 */

const BASE = '/hiring/recruiting';
const enc = encodeURIComponent;
const J = (key: string) => `${BASE}/candidates/${enc(key)}/journey`;

export function useRecruitDashboard(params: { from: string; to: string; scope: RecruitScope; recruiter?: string }): UseQueryResult<RecruitDashboard> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'dashboard', params],
    queryFn: () => apiGet<RecruitDashboard>(`${BASE}/dashboard`, params as unknown as Record<string, unknown>),
    placeholderData: (previous) => previous,
    refetchInterval: 60_000,
  });
}

export function useCandidateJourney(key: string, options: { enabled?: boolean } = {}): UseQueryResult<CandidateJourney> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'journey', key],
    queryFn: () => apiGet<CandidateJourney>(J(key)),
    enabled: options.enabled ?? true,
    // A driver's consent or application shows within seconds, not on the next page load (owner,
    // 2026-10-12: it seemed to take ten minutes).
    refetchInterval: 15_000,
  });
}

export const journeyApi = {
  consentLink: (key: string) => apiPost<ConsentLinkIssued>(`${J(key)}/consent/link`, {}),
  consentCopied: (key: string) => apiPost<ConsentSessionView>(`${J(key)}/consent/copied`, {}),
  consentMarkSent: (key: string, channel: string | null) => apiPost<ConsentSessionView>(`${J(key)}/consent/mark-sent`, { channel }),
  consentEmail: (key: string, to: string | null) => apiPost<ConsentSessionView>(`${J(key)}/consent/email`, { to }),
  consentRevoke: (key: string, reason: string | null) => apiPost<CandidateConsentView>(`${J(key)}/consent/revoke`, { reason }),
  sendLink: (key: string, body: SendLinkInput) => apiPost<LinkDeliveryView>(`${J(key)}/deliveries`, body),
  smsConsent: (key: string, body: SmsConsentInput) => apiPost<SmsConsentView>(`${J(key)}/sms-consent`, body),
  resendLink: (key: string, id: string) => apiPost<LinkDeliveryView>(`${J(key)}/deliveries/${enc(id)}/resend`, {}),
  refreshLink: (key: string, id: string) => apiPost<LinkDeliveryView>(`${J(key)}/deliveries/${enc(id)}/refresh`, {}),
  safetyCheckRequest: (key: string, body: SafetyCheckRequestInput) => apiPost<SafetyCheckView>(`${J(key)}/safety/checks`, body),
  safetyCheckPending: (key: string, kind: string, body: { orderRef: string | null; note: string | null; version: number }) =>
    apiPost<SafetyCheckView>(`${J(key)}/safety/checks/${enc(kind)}/pending`, body),
  sendToSafety: (key: string, note: string | null) => apiPost<void>(`${J(key)}/safety`, { note }),
  safetyDecision: (key: string, body: SafetyStatusChangeInput) => apiPost<void>(`${J(key)}/safety/decision`, body),
  safetyUpload: (key: string, body: SafetyReportUploadInput) => apiPost<SafetyReportView>(`${J(key)}/safety/reports`, body),
  safetyReview: (key: string, id: string, body: { result: string; note: string | null; version: number }) => apiPatch<SafetyReportView>(`${J(key)}/safety/reports/${enc(id)}`, body),
  safetyFullQuery: (key: string, status: string, version: number) => apiPost<void>(`${J(key)}/safety/full-query`, { status, version }),
  applicationReviewed: (key: string) => apiPost<void>(`${J(key)}/application/reviewed`, {}),
  startOnboarding: (key: string) => apiPost<void>(`${J(key)}/onboarding/start`, {}),
  addTask: (key: string, body: { label: string; required: boolean; dueOn: string | null }) => apiPost<OnboardingTaskView>(`${J(key)}/onboarding/tasks`, body),
  updateTask: (key: string, id: string, body: OnboardingTaskUpdateInput) => apiPatch<OnboardingTaskView>(`${J(key)}/onboarding/tasks/${enc(id)}`, body),
  addTravel: (key: string, body: TravelItemInput) => apiPost<TravelItemView>(`${J(key)}/travel`, body),
  updateTravel: (key: string, id: string, body: Omit<TravelItemInput, 'kind'> & { status: 'booked' | 'rescheduled'; version: number }) => apiPatch<TravelItemView>(`${J(key)}/travel/${enc(id)}`, body),
  cancelTravel: (key: string, id: string, reason: string, version: number) => apiPost<TravelItemView>(`${J(key)}/travel/${enc(id)}/cancel`, { reason, version }),
  addCost: (key: string, body: CandidateCostInput & { clientKey?: string }) => apiPost<CandidateCostView>(`${J(key)}/costs`, body),
  decideCost: (key: string, id: string, body: { decision: 'approved' | 'rejected'; note: string | null; version: number }) => apiPost<CandidateCostView>(`${J(key)}/costs/${enc(id)}/decision`, body),
  costAgreement: (key: string, id: string, note: string, version: number) => apiPost<CandidateCostView>(`${J(key)}/costs/${enc(id)}/agreement`, { note, version }),
  costPayment: (key: string, id: string, paidOn: string, version: number) => apiPost<CandidateCostView>(`${J(key)}/costs/${enc(id)}/payment`, { paidOn, version }),
  costRefund: (key: string, id: string, body: { refundAmount: number; nonrefundableFee: number | null; note: string | null; version: number }) => apiPost<CandidateCostView>(`${J(key)}/costs/${enc(id)}/refund`, body),
  hold: (key: string, hold: boolean, reason: string | null) => apiPost<void>(`${J(key)}/hold`, { hold, reason }),
  withdraw: (key: string, reason: string) => apiPost<void>(`${J(key)}/withdraw`, { reason }),
  hire: (key: string, body: HireCandidateInput) => apiPost<{ driverId: string; driverNumber: string; employeeId: string; employeeNumber: string }>(`${J(key)}/hire`, body),
};

/** Authorized file addresses for the journey's own documents. */
/** The API path a candidate's screening reports live under, for Recruiting (owner, 2026-10-12). */
export const journeySafetyBase = (key: string) => `${J(key)}/safety`;

export const journeyUrls = {
  consentFile: (key: string, fileId: string) => `/${API_PREFIX}${J(key)}/consent/files/${enc(fileId)}`,
  consentSignature: (key: string) => `/${API_PREFIX}${J(key)}/consent/signature`,
  consentPdf: (key: string, documentId: string) => `/${API_PREFIX}${J(key)}/consent/documents/${enc(documentId)}/pdf`,
  safetyReport: (key: string, reportId: string) => `/${API_PREFIX}${J(key)}/safety/reports/${enc(reportId)}/file`,
};
