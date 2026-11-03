import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  DotLinkCreated,
  DriverApplicationLinkIssued,
  DriverApplicationSessionView,
  DriverApplicationView,
  HireDriverInput,
  HireDriverResult,
  Lead,
  RecruitAddLeadInput,
  RecruitAnalytics,
  RecruitBoard,
  RecruitCalendarEvent,
  RecruitCandidate,
  RecruitFilter,
  RecruitList,
  RecruitMetrics,
  RecruitNote,
  RecruitNoteInput,
  RecruitRecruiter,
  RecruitScope,
  RenameCandidateInput,
  RenameCandidateResult,
  RotationSettings,
  SendToSafetyInput,
} from '@neway/shared';
import { API_PREFIX } from '@neway/shared';
import { apiGet, apiPatch, apiPost, apiPut } from '@/lib/api-client';

/**
 * Recruiting home and candidate data (owner's redesign, 2026-10-08). Everything lives under the
 * shared ['hr'] cache prefix, so a note, a link or a hire refreshes every list that shows it.
 */

const BASE = '/hiring/recruiting';
const enc = encodeURIComponent;

export interface RecruitListParams {
  scope: RecruitScope;
  recruiter?: string;
  filter: RecruitFilter;
  followUp?: 'due';
  q?: string;
  page: number;
  pageSize: number;
  /** From the dashboard: leads received in this period, one stage, one source. */
  from?: string;
  to?: string;
  stage?: string;
  source?: string;
}

/** Leads arrive from the apply link at any time; the list polls like the old Leads tab did. */
const POLL_MS = 30_000;

export function useRecruitList(params: RecruitListParams): UseQueryResult<RecruitList> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'list', params],
    queryFn: () => apiGet<RecruitList>(`${BASE}/candidates`, params as unknown as Record<string, unknown>),
    placeholderData: (previous) => previous,
    refetchInterval: POLL_MS,
  });
}

/** The pipeline board (owner mockup, 2026-10-15): every active candidate in scope, by column. */
export function useRecruitBoard(params: { scope: RecruitScope; recruiter?: string; q?: string }): UseQueryResult<RecruitBoard> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'board', params],
    queryFn: () => apiGet<RecruitBoard>(`${BASE}/board`, params),
    placeholderData: (previous) => previous,
    refetchInterval: POLL_MS,
  });
}

export function useRecruitMetrics(scope: RecruitScope, recruiter?: string): UseQueryResult<RecruitMetrics> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'metrics', scope, recruiter ?? null],
    queryFn: () => apiGet<RecruitMetrics>(`${BASE}/metrics`, { scope, recruiter }),
    refetchInterval: POLL_MS,
  });
}

export function useRecruiters(enabled = true): UseQueryResult<RecruitRecruiter[]> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'recruiters'],
    queryFn: () => apiGet<RecruitRecruiter[]>(`${BASE}/recruiters`),
    enabled,
    staleTime: 60_000,
  });
}

export function useRecruitCandidate(key: string, options: { enabled?: boolean } = {}): UseQueryResult<RecruitCandidate> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'candidate', key],
    queryFn: () => apiGet<RecruitCandidate>(`${BASE}/candidates/${enc(key)}`),
    enabled: options.enabled ?? true,
  });
}

export function useRecruitNotes(key: string): UseQueryResult<RecruitNote[]> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'notes', key],
    queryFn: () => apiGet<RecruitNote[]>(`${BASE}/candidates/${enc(key)}/notes`),
  });
}

export function useRecruitCalendar(params: { from: string; to: string; scope: RecruitScope; recruiter?: string }): UseQueryResult<RecruitCalendarEvent[]> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'calendar', params],
    queryFn: () => apiGet<RecruitCalendarEvent[]>(`${BASE}/calendar`, params),
    placeholderData: (previous) => previous,
  });
}

export function useRecruitAnalytics(params: { from: string; to: string }): UseQueryResult<RecruitAnalytics> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'analytics', params],
    queryFn: () => apiGet<RecruitAnalytics>(`${BASE}/analytics`, params),
    placeholderData: (previous) => previous,
  });
}

export function useRotationSettings(): UseQueryResult<RotationSettings> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'rotation'],
    queryFn: () => apiGet<RotationSettings>(`${BASE}/rotation`),
  });
}

export function useRotationNext(): UseQueryResult<{ employeeId: string; name: string } | null> {
  return useQuery({
    queryKey: ['hr', 'recruit', 'rotation-next'],
    queryFn: () => apiGet<{ employeeId: string; name: string } | null>(`${BASE}/rotation/next`),
  });
}

export type ApplicationLinkCreated = DotLinkCreated & { key: string; externalUrl: string | null };

export const recruitApi = {
  addLead: (body: RecruitAddLeadInput) => apiPost<{ key: string; lead: Lead }>(`${BASE}/leads`, body),
  addNote: (key: string, body: RecruitNoteInput) => apiPost<RecruitNote>(`${BASE}/candidates/${enc(key)}/notes`, body),
  reopenLead: (leadId: string, note: string) => apiPost<Lead>(`/hiring/leads/${enc(leadId)}/reopen`, { note }),
  markContacted: (leadId: string) => apiPost<Lead>(`/hiring/leads/${enc(leadId)}/contacted`, {}),
  markNoAnswer: (leadId: string) => apiPost<Lead>(`/hiring/leads/${enc(leadId)}/no-answer`, {}),
  followUpDone: (key: string) => apiPost<{ ok: true }>(`${BASE}/candidates/${enc(key)}/follow-up/done`, {}),
  applicationLink: (key: string) => apiPost<ApplicationLinkCreated>(`${BASE}/candidates/${enc(key)}/application-link`, {}),
  markSent: (key: string, channel: string | null) =>
    apiPost<{ at: string }>(`${BASE}/candidates/${enc(key)}/application-link/mark-sent`, { channel }),
  // The personal driver application (/application/#token=…): issue, copy, mark sent, turn off.
  issueApplication: (key: string) => apiPost<DriverApplicationLinkIssued>(`${BASE}/candidates/${enc(key)}/driver-application/session`, {}),
  applicationCopied: (key: string) =>
    apiPost<DriverApplicationSessionView>(`${BASE}/candidates/${enc(key)}/driver-application/session/copied`, {}),
  applicationMarkSent: (key: string, channel: string | null) =>
    apiPost<DriverApplicationSessionView>(`${BASE}/candidates/${enc(key)}/driver-application/session/mark-sent`, { channel }),
  applicationRevoke: (key: string) => apiPost<DriverApplicationView>(`${BASE}/candidates/${enc(key)}/driver-application/session/revoke`, {}),
  revealSsn: (key: string) => apiPost<{ ssn: string }>(`${BASE}/candidates/${enc(key)}/driver-application/ssn`, {}),
  /** A disqualified candidate or dead lead back to the step before, with a note (owner, 2026-10-16). */
  reopen: (key: string, note: string) => apiPost<RecruitCandidate>(`${BASE}/candidates/${enc(key)}/reopen`, { note }),
  sendToSafety: (key: string, body: SendToSafetyInput) =>
    apiPost<RecruitCandidate>(`${BASE}/candidates/${enc(key)}/send-to-safety`, body),
  /** Renames the candidate on the lead, the case and the candidate record together (stale = 409). */
  rename: (key: string, body: RenameCandidateInput) => apiPatch<RenameCandidateResult>(`${BASE}/candidates/${enc(key)}/name`, body),
  reassign: (key: string, employeeId: string | null) =>
    apiPost<RecruitCandidate>(`${BASE}/candidates/${enc(key)}/recruiter`, { employeeId }),
  hire: (caseId: string, body: HireDriverInput) => apiPost<HireDriverResult>(`/hiring/cases/${enc(caseId)}/hire`, body),
  reorder: (userIds: string[]) => apiPut<RotationSettings>(`${BASE}/rotation/order`, { userIds }),
  setExcluded: (userId: string, excluded: boolean, reason: string | null) =>
    apiPost<RotationSettings>(`${BASE}/rotation/members/${enc(userId)}/excluded`, { excluded, reason }),
};

/** A write that refreshes Recruiting once the server has accepted it. */
export function useRecruitMutation<TInput, TResult>(send: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['hr'] });
    },
  });
}

/** Authorized file addresses for the personal application's documents and signatures. */
export const driverApplicationUrls = {
  applicationPdf: (key: string) => `/${API_PREFIX}${BASE}/candidates/${enc(key)}/driver-application/pdf`,
  file: (key: string, fileId: string) => `/${API_PREFIX}${BASE}/candidates/${enc(key)}/driver-application/files/${enc(fileId)}`,
  signature: (key: string, authId: string) =>
    `/${API_PREFIX}${BASE}/candidates/${enc(key)}/driver-application/authorizations/${enc(authId)}/signature`,
  pdf: (key: string, authId: string) => `/${API_PREFIX}${BASE}/candidates/${enc(key)}/driver-application/authorizations/${enc(authId)}/pdf`,
};
