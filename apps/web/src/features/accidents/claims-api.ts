import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { accidentsV2 as A } from '@neway/shared';
import { apiGet, apiPatch, apiPost, apiPut } from '@/lib/api-client';
import { BASE as ACC_BASE, accKeys } from './api';

/**
 * Claims (Accident & Claims v2, P2) data layer. Claims share the accidents cache root, so a status change on the
 * Claims board refreshes the linked case (Overview, Claims & costs) at once, and the other way round (ACCEPTANCE G4).
 */
export const CLAIMS_BASE = '/safety/claims-v2';

export const claimKeys = {
  list: (q: A.ClaimListQuery) => [...accKeys.all, 'claims', 'list', q] as const,
  summary: [...accKeys.all, 'claims', 'summary'] as const,
  detail: (id: string) => [...accKeys.all, 'claims', 'detail', id] as const,
};

export const useClaims = (q: A.ClaimListQuery): UseQueryResult<A.ClaimListResponse> =>
  useQuery({ queryKey: claimKeys.list(q), queryFn: () => apiGet<A.ClaimListResponse>(CLAIMS_BASE, q as Record<string, unknown>) });
export const useClaimsSummary = (): UseQueryResult<A.ClaimsSummaryResponse> =>
  useQuery({ queryKey: claimKeys.summary, queryFn: () => apiGet<A.ClaimsSummaryResponse>(`${CLAIMS_BASE}/summary`) });
export const useClaim = (id: string | null): UseQueryResult<A.ClaimDetailResponse> =>
  useQuery({ queryKey: claimKeys.detail(id ?? ''), queryFn: () => apiGet<A.ClaimDetailResponse>(`${CLAIMS_BASE}/${id}`), enabled: Boolean(id) });

type Ver = { id: string; version: number };
export const claimsApi = {
  create: (body: A.CreateClaimsInput, idempotencyKey: string) => apiPost<A.CreateClaimsResponse>(CLAIMS_BASE, body, { headers: { 'Idempotency-Key': idempotencyKey } }),
  patch: (id: string, body: A.PatchClaimInput) => apiPatch<Ver>(`${CLAIMS_BASE}/${id}`, body),
  payment: (id: string, body: A.ClaimPaymentInput) => apiPost<Ver & { paymentId: string }>(`${CLAIMS_BASE}/${id}/payments`, body),
  voidPayment: (id: string, paymentId: string, body: A.VoidClaimPaymentInput) => apiPost<Ver>(`${CLAIMS_BASE}/${id}/payments/${paymentId}/void`, body),
  document: (id: string, docId: string, body: A.ClaimDocumentInput) => apiPatch<Ver>(`${CLAIMS_BASE}/${id}/documents/${docId}`, body),
  log: (id: string, body: A.ClaimLogInput) => apiPost<Ver>(`${CLAIMS_BASE}/${id}/log`, body),
  link: (id: string, body: A.LinkAccidentInput) => apiPost<Ver>(`${CLAIMS_BASE}/${id}/link-accident`, body),
  claimDecision: (accidentId: string, body: A.ClaimDecisionInput) => apiPut<Ver>(`${ACC_BASE}/${accidentId}/claim-decision`, body),
};

/** Whole dollars typed in a form → cents; blank = not known (null), never 0. */
export function dollarsToCents(v: string): number | null {
  const t = v.trim().replace(/[$,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
export const centsToDollars = (c: number | null | undefined): string => (c === null || c === undefined ? '' : String(c / 100));
