import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  API_PREFIX,
  type BookTicketInput,
  type Campaign,
  type CampaignSpendEntry,
  type CreateCampaignSpendInput,
  type CostEntry,
  type CostQuery,
  type CostSummary,
  type CreateCampaignInput,
  type CreateCostEntryInput,
  type CreateDriverOfferInput,
  type DropHiringCaseInput,
  type FollowUpInput,
  type HiringActivityEntry,
  type LatestFollowUp,
  type LeadNote,
  type LeadRotation,
  type MyLeads,
  type ComplianceDocument,
  type HiringDocumentUploadInput,
  type CdlReadResult,
  type ReadCdlRequest,
  type HiringCalendarEvent,
  type DotApplication,
  type DotLinkCreated,
  type DotLinkStagedFile,
  type DotLinkStatus,
  type HireDriverInput,
  type HireDriverResult,
  type HiringAnalytics,
  type HiringCase,
  type HiringState,
  type ApplyLink,
  type CreateApplyLinkInput,
  type Lead,
  type LeadApplication,
  type UpdateApplyLinkInput,
  type LeadSummary,
  type OfferRecord,
  type Orientation,
  type Prequalification,
  type PrequalificationRules,
  type RecordOrientationInput,
  type SaveDotApplicationInput,
  type TravelTicket,
} from '@neway/shared';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api-client';

/**
 * The driver hiring funnel's data layer: leads at the front, cases through the middle.
 *
 * Shares the `['hr']` cache prefix with recruiting because converting a lead creates a candidate,
 * and a Leads tab that still shows "prequalified" beside a Pipeline tab that already shows the
 * case is the kind of disagreement one invalidation prefix exists to prevent.
 */

const BASE = '/hiring';

export interface Paged<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

function query<T>(key: unknown[], path: string, params?: Record<string, unknown>) {
  return { queryKey: key, queryFn: () => apiGet<T>(path, params) };
}

/** New leads arrive from the apply link at any time: lists and the alert poll for them. */
const LEAD_POLL_MS = 30_000;

export function useLeads(params: Record<string, unknown>): UseQueryResult<Paged<Lead>> {
  return useQuery({
    ...query<Paged<Lead>>(['hr', 'leads', params], `${BASE}/leads`, params),
    placeholderData: (previous) => previous,
    refetchInterval: LEAD_POLL_MS,
    refetchOnWindowFocus: true,
  });
}

/**
 * Leads still New: nobody has reached them (owner, 2026-10-06). The red alert on Recruiting and
 * the sidebar badge both read this, over all leads, and only "Mark contacted" (or a later status)
 * takes a lead out of it — opening or viewing it does not.
 */
export function useUncontactedLeads(enabled = true): UseQueryResult<LeadSummary> {
  return useQuery({
    ...query<LeadSummary>(['hr', 'leads', 'summary', {}], `${BASE}/leads/summary`),
    enabled,
    refetchInterval: LEAD_POLL_MS,
    refetchOnWindowFocus: true,
  });
}

export function useLead(id: string | null): UseQueryResult<Lead> {
  return useQuery({
    ...query<Lead>(['hr', 'lead', id], `${BASE}/leads/${encodeURIComponent(id ?? '')}`),
    enabled: id !== null,
  });
}

/** The count tiles over the leads added in the period (all leads when no period is given). */
export function useLeadSummary(period?: { from?: string; to?: string }): UseQueryResult<LeadSummary> {
  return useQuery({
    ...query<LeadSummary>(['hr', 'leads', 'summary', period ?? {}], `${BASE}/leads/summary`, period),
    placeholderData: (previous) => previous,
  });
}

/** The online applications behind a lead, newest first. Empty for a lead added by hand. */
export function useLeadApplications(id: string | null): UseQueryResult<LeadApplication[]> {
  return useQuery({
    ...query<LeadApplication[]>(
      ['hr', 'lead', id, 'applications'],
      `${BASE}/leads/${encodeURIComponent(id ?? '')}/applications`,
    ),
    enabled: id !== null,
  });
}

/** The company's public application links. */
export function useApplyLinks(enabled = true): UseQueryResult<ApplyLink[]> {
  return useQuery({ ...query<ApplyLink[]>(['hr', 'apply-links'], `${BASE}/apply-links`), enabled });
}

/** The rules in force, so the form can show what an answer is judged against. */
export function usePrequalificationRules(): UseQueryResult<PrequalificationRules> {
  return useQuery(query<PrequalificationRules>(['hr', 'leads', 'rules'], `${BASE}/leads/rules`));
}

export function useHiringCases(state?: HiringState): UseQueryResult<HiringCase[]> {
  return useQuery(
    query<HiringCase[]>(['hr', 'hiring', 'cases', state ?? 'all'], `${BASE}/cases`, { state }),
  );
}

export function useHiringSummary(): UseQueryResult<Record<HiringState, number>> {
  return useQuery(
    query<Record<HiringState, number>>(['hr', 'hiring', 'summary'], `${BASE}/cases/summary`),
  );
}

/** The driver funnel case behind a candidate, or null for an office-role candidate. */
export function useHiringCaseForApplicant(applicantId: string): UseQueryResult<HiringCase | null> {
  return useQuery({
    queryKey: ['hr', 'hiring', 'by-applicant', applicantId],
    queryFn: async () => {
      const cases = await apiGet<HiringCase[]>(`${BASE}/cases`, { applicantId });
      return cases[0] ?? null;
    },
    enabled: applicantId.length > 0,
  });
}

/**
 * `null` until the recruiter starts recording it. `poll` while a link sent to the driver is live,
 * so what the driver saves on the phone shows up here without a reload.
 */
export function useDotApplication(
  caseId: string | null,
  options: { poll?: boolean } = {},
): UseQueryResult<DotApplication | null> {
  return useQuery({
    refetchInterval: options.poll ? 20_000 : false,
    refetchOnWindowFocus: options.poll ? true : false,
    queryKey: ['hr', 'hiring', 'dot-application', caseId],
    queryFn: async () => {
      const result = await apiGet<{ application: DotApplication | null }>(
        `${BASE}/cases/${encodeURIComponent(caseId ?? '')}/dot-application`,
      );
      return result.application;
    },
    enabled: caseId !== null,
  });
}

/** The latest DOT application link sent to the driver (never its token), polled while it is live. */
export function useDotLink(caseId: string): UseQueryResult<DotLinkStatus | null> {
  return useQuery({
    queryKey: ['hr', 'hiring', 'dot-link', caseId],
    queryFn: async () =>
      (await apiGet<{ link: DotLinkStatus | null }>(`${BASE}/cases/${encodeURIComponent(caseId)}/dot-application/link`)).link,
    refetchInterval: (query) => {
      const link = query.state.data;
      return link && link.state === 'live' && !link.cdlUploadedAt ? 20_000 : false;
    },
    refetchOnWindowFocus: true,
  });
}

export interface CasePipeline {
  offer: OfferRecord | null;
  ticket: TravelTicket | null;
  orientation: Orientation | null;
}

/** The back of the funnel for one case: the offer, the ticket and the orientation record. */
export function useCasePipeline(caseId: string | null): UseQueryResult<CasePipeline> {
  return useQuery({
    ...query<CasePipeline>(
      ['hr', 'hiring', 'pipeline', caseId],
      `${BASE}/cases/${encodeURIComponent(caseId ?? '')}/pipeline`,
    ),
    enabled: caseId !== null,
  });
}

/** Computed on read by the API from the funnel's own records; nothing here is stored. */
export function useHiringAnalytics(params: {
  from?: string;
  to?: string;
}): UseQueryResult<HiringAnalytics> {
  return useQuery({
    ...query<HiringAnalytics>(['hr', 'hiring', 'analytics', params], `${BASE}/analytics`, params),
    placeholderData: (previous) => previous,
  });
}

/** Travel, orientation and hires between two business dates: the hiring week view. */
export function useHiringCalendar(from: string, to: string): UseQueryResult<HiringCalendarEvent[]> {
  return useQuery({
    ...query<HiringCalendarEvent[]>(['hr', 'hiring', 'calendar', from, to], `${BASE}/calendar`, { from, to }),
    enabled: from.length === 10 && to.length === 10,
  });
}

/** The candidate's papers in their driver file, with Safety's answer on each. */
export function useCaseDocuments(caseId: string | null): UseQueryResult<{ driverId: string | null; documents: ComplianceDocument[] }> {
  return useQuery({
    ...query<{ driverId: string | null; documents: ComplianceDocument[] }>(['hr', 'hiring', 'documents', caseId], `${BASE}/cases/${encodeURIComponent(caseId ?? '')}/documents`),
    enabled: caseId !== null,
  });
}

/** Where one of the case's own documents opens, through the hiring route (no compliance access needed). */
/** The CDL files the driver sent through the link (filed, or waiting for Accept). */
export function useDotLinkFiles(caseId: string, enabled = true): UseQueryResult<DotLinkStagedFile[]> {
  return useQuery({
    queryKey: ['hr', 'hiring', 'dot-link-files', caseId],
    queryFn: () => apiGet<DotLinkStagedFile[]>(`${BASE}/cases/${encodeURIComponent(caseId)}/dot-application/link/files`),
    enabled,
  });
}

/** Where a staged driver file can be previewed (through the authenticated viewer, not an anchor). */
export function dotLinkFileUrl(caseId: string, fileId: string): string {
  return `/${API_PREFIX}${BASE}/cases/${encodeURIComponent(caseId)}/dot-application/link/files/${encodeURIComponent(fileId)}`;
}

export function caseDocumentFileUrl(caseId: string, documentId: string): string {
  return `/${API_PREFIX}${BASE}/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(documentId)}/file`;
}

/** The newest recorded follow-up per case and lead, for the pipeline cards. */
export function useLatestFollowUps(): UseQueryResult<LatestFollowUp[]> {
  return useQuery(query<LatestFollowUp[]>(['hr', 'hiring', 'follow-ups'], `${BASE}/follow-ups/latest`));
}

/**
 * The signed-in recruiter's leads (owner, 2026-10-07); a manager may name another recruiter.
 * Polls like the other lead lists, because online applications arrive already assigned.
 */
export function useMyLeads(recruiterEmployeeId?: string): UseQueryResult<MyLeads> {
  const params = recruiterEmployeeId ? { recruiterEmployeeId } : undefined;
  return useQuery({
    ...query<MyLeads>(['hr', 'leads', 'mine', recruiterEmployeeId ?? null], `${BASE}/my-leads`, params),
    placeholderData: (previous) => previous,
    refetchInterval: LEAD_POLL_MS,
    refetchOnWindowFocus: true,
  });
}

/** Notes and follow-ups on one lead, newest first. */
export function useLeadNotes(leadId: string | null): UseQueryResult<LeadNote[]> {
  return useQuery({
    ...query<LeadNote[]>(['hr', 'lead', leadId, 'notes'], `${BASE}/leads/${encodeURIComponent(leadId ?? '')}/notes`),
    enabled: leadId !== null,
  });
}

/** Who takes the next online application, and the turn order. */
export function useLeadRotation(): UseQueryResult<LeadRotation> {
  return useQuery({
    ...query<LeadRotation>(['hr', 'leads', 'rotation'], `${BASE}/lead-rotation`),
    refetchInterval: LEAD_POLL_MS,
  });
}

/** Stage moves, follow-ups and record changes for one case, newest first. */
export function useCaseActivity(caseId: string | null): UseQueryResult<HiringActivityEntry[]> {
  return useQuery({
    ...query<HiringActivityEntry[]>(['hr', 'hiring', 'activity', caseId], `${BASE}/cases/${encodeURIComponent(caseId ?? '')}/activity`),
    enabled: caseId !== null,
  });
}

export function useCampaigns(): UseQueryResult<Campaign[]> {
  return useQuery(query<Campaign[]>(['hr', 'campaigns'], `${BASE}/campaigns`));
}

/** A campaign's dated spend entries, voided ones included. */
export function useCampaignSpend(campaignId: string | null): UseQueryResult<CampaignSpendEntry[]> {
  return useQuery({
    ...query<CampaignSpendEntry[]>(
      ['hr', 'campaigns', 'spend', campaignId],
      `${BASE}/campaigns/${encodeURIComponent(campaignId ?? '')}/spend`,
    ),
    enabled: campaignId !== null,
  });
}

export function useCosts(params: CostQuery): UseQueryResult<CostEntry[]> {
  return useQuery(query<CostEntry[]>(['hr', 'costs', params], `${BASE}/costs`, params));
}

/** Everything charged to a case, including what its lead cost before conversion. */
export function useCaseCosts(
  caseId: string | null,
): UseQueryResult<{ entries: CostEntry[]; summary: CostSummary }> {
  return useQuery({
    ...query<{ entries: CostEntry[]; summary: CostSummary }>(
      ['hr', 'costs', 'case', caseId],
      `${BASE}/cases/${encodeURIComponent(caseId ?? '')}/costs`,
    ),
    enabled: caseId !== null,
  });
}

/** Where a stored qualification-file document can be opened. Only meaningful when `hasFile`. */
export function complianceDocumentFileUrl(documentId: string): string {
  return `/${API_PREFIX}/compliance/documents/${encodeURIComponent(documentId)}/file`;
}

export const hiringApi = {
  createLead: (body: unknown) => apiPost<Lead>(`${BASE}/leads`, body),
  updateLead: (id: string, body: unknown) =>
    apiPatch<Lead>(`${BASE}/leads/${encodeURIComponent(id)}`, body),
  markContacted: (id: string) =>
    apiPost<Lead>(`${BASE}/leads/${encodeURIComponent(id)}/contacted`, {}),
  prequalify: (id: string, body: Prequalification) =>
    apiPost<Lead>(`${BASE}/leads/${encodeURIComponent(id)}/prequalify`, body),
  disqualify: (id: string, reason: string) =>
    apiPost<Lead>(`${BASE}/leads/${encodeURIComponent(id)}/disqualify`, { reason }),
  convert: (id: string) => apiPost<Lead>(`${BASE}/leads/${encodeURIComponent(id)}/convert`, {}),
  saveDotApplication: (caseId: string, body: SaveDotApplicationInput) =>
    apiPut<DotApplication>(`${BASE}/cases/${encodeURIComponent(caseId)}/dot-application`, body),
  acceptDotApplication: (caseId: string) =>
    apiPost<DotApplication>(`${BASE}/cases/${encodeURIComponent(caseId)}/dot-application/accept`, {}),
  returnDotApplication: (caseId: string, note: string) =>
    apiPost<DotApplication>(`${BASE}/cases/${encodeURIComponent(caseId)}/dot-application/return`, { note }),
  createDotLink: (caseId: string) =>
    apiPost<DotLinkCreated>(`${BASE}/cases/${encodeURIComponent(caseId)}/dot-application/link`, {}),
  revokeDotLink: (caseId: string) =>
    apiDelete<{ link: DotLinkStatus | null }>(`${BASE}/cases/${encodeURIComponent(caseId)}/dot-application/link`),
  submitDotApplication: (caseId: string) =>
    apiPost<DotApplication>(
      `${BASE}/cases/${encodeURIComponent(caseId)}/dot-application/submit`,
      {},
    ),
  createOffer: (caseId: string, body: CreateDriverOfferInput) =>
    apiPost<OfferRecord>(`${BASE}/cases/${encodeURIComponent(caseId)}/offer`, body),
  setOfferStatus: (caseId: string, status: string) =>
    apiPost<OfferRecord>(`${BASE}/cases/${encodeURIComponent(caseId)}/offer/status`, { status }),
  bookTicket: (caseId: string, body: BookTicketInput) =>
    apiPost<TravelTicket>(`${BASE}/cases/${encodeURIComponent(caseId)}/ticket`, body),
  recordOrientation: (caseId: string, body: RecordOrientationInput) =>
    apiPut<Orientation>(`${BASE}/cases/${encodeURIComponent(caseId)}/orientation`, body),
  dropCase: (caseId: string, body: DropHiringCaseInput) =>
    apiPost<HiringCase>(`${BASE}/cases/${encodeURIComponent(caseId)}/drop`, body),
  uploadDocument: (caseId: string, body: HiringDocumentUploadInput) =>
    apiPost<ComplianceDocument>(`${BASE}/cases/${encodeURIComponent(caseId)}/documents`, body),
  /** Meta Muse reads a licence before upload; a proposal only, nothing is saved. */
  readCdl: (caseId: string, body: ReadCdlRequest) =>
    apiPost<CdlReadResult>(`${BASE}/cases/${encodeURIComponent(caseId)}/documents/read-cdl`, body),
  assignRecruiter: (caseId: string, employeeId: string | null) =>
    apiPost<HiringCase>(`${BASE}/cases/${encodeURIComponent(caseId)}/recruiter`, { employeeId }),
  recordCaseFollowUp: (caseId: string, body: FollowUpInput) =>
    apiPost<LatestFollowUp>(`${BASE}/cases/${encodeURIComponent(caseId)}/follow-ups`, body),
  addLeadNote: (leadId: string, note: string) =>
    apiPost<LeadNote>(`${BASE}/leads/${encodeURIComponent(leadId)}/notes`, { note }),
  recordLeadFollowUp: (leadId: string, body: FollowUpInput) =>
    apiPost<LatestFollowUp>(`${BASE}/leads/${encodeURIComponent(leadId)}/follow-ups`, body),
  hire: (caseId: string, body: HireDriverInput) =>
    apiPost<HireDriverResult>(`${BASE}/cases/${encodeURIComponent(caseId)}/hire`, body),
  createCampaign: (body: CreateCampaignInput) => apiPost<Campaign>(`${BASE}/campaigns`, body),
  updateCampaign: (id: string, body: Partial<CreateCampaignInput>) =>
    apiPatch<Campaign>(`${BASE}/campaigns/${encodeURIComponent(id)}`, body),
  addCampaignSpend: (campaignId: string, body: CreateCampaignSpendInput) =>
    apiPost<CampaignSpendEntry>(`${BASE}/campaigns/${encodeURIComponent(campaignId)}/spend`, body),
  updateCampaignSpend: (
    id: string,
    body: { version: number; spentOn?: string; amount?: number; note?: string | null },
  ) => apiPatch<CampaignSpendEntry>(`${BASE}/campaign-spend/${encodeURIComponent(id)}`, body),
  voidCampaignSpend: (id: string, body: { version: number; reason: string }) =>
    apiPost<CampaignSpendEntry>(`${BASE}/campaign-spend/${encodeURIComponent(id)}/void`, body),
  /** Posts a cost to Accounting, or puts its expense right. Needs `accounting.edit`. */
  postCostToAccounting: (id: string) =>
    apiPost<CostEntry>(`${BASE}/costs/${encodeURIComponent(id)}/accounting`, {}),
  createCost: (body: CreateCostEntryInput) => apiPost<CostEntry>(`${BASE}/costs`, body),
  voidCost: (id: string, reason: string) =>
    apiPost<CostEntry>(`${BASE}/costs/${encodeURIComponent(id)}/void`, { reason }),
  createApplyLink: (body: CreateApplyLinkInput) => apiPost<ApplyLink>(`${BASE}/apply-links`, body),
  updateApplyLink: (id: string, body: UpdateApplyLinkInput) =>
    apiPatch<ApplyLink>(`${BASE}/apply-links/${encodeURIComponent(id)}`, body),
};

/** Every write to the funnel refreshes the whole HR cache: a conversion touches three lists. */
export function useHiringMutation<TInput, TResult>(send: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['hr'] });
    },
  });
}

/** An Accounting expense as the candidate cost form needs it (read-only here). */
export interface LinkableExpense {
  id: string;
  expenseNumber: string;
  onDate: string;
  description: string;
  amount: number;
  status?: string;
  /** `recruiting` when a candidate cost posted it: that expense already belongs to a cost. */
  source?: string;
  driverName: string | null;
  receiptFileId: string | null;
}

/**
 * Expenses already booked in Accounting, so a candidate cost can point at one instead of being
 * typed a second time. Only fetched for people who can see Accounting.
 */
export function useAccountingExpenses(enabled: boolean): UseQueryResult<LinkableExpense[]> {
  return useQuery({
    queryKey: ['hr', 'accounting-expenses'],
    queryFn: () => apiGet<LinkableExpense[]>('/accounting/expenses'),
    enabled,
    staleTime: 60_000,
  });
}
