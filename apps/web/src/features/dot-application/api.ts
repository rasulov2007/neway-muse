import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  API_PREFIX,
  type DotAppHireInput,
  type DotAppIssued,
  type DotAppIssueInput,
  type DotAppRecruiterView,
  type DotAppSafetyDetail,
  type DotAppSignatureView,
  type DotAppSummary,
  type DotAppTemplate,
  type DotAppTemplateOverview,
  type DotAppTemplateRow,
} from '@neway/shared';
import { apiGet, apiPost, apiPut } from '@/lib/api-client';

/**
 * The DOT driver application v2, internal side (owner brief 2026-10-27): Recruiting's step 5 card,
 * Safety → Applications review, and Admin → Document templates. Everything the page shows comes
 * from these routes; nothing is decided in the browser that the server does not decide again.
 */

const enc = encodeURIComponent;
const R = (key: string) => `/hiring/recruiting/candidates/${enc(key)}/dot-application`;
const S = '/safety/dot-applications';
const T = '/admin/application-templates';

// ------------------------------------------------------------------------------- Recruiting (step 5)

export function useDotAppRecruiter(key: string): UseQueryResult<DotAppRecruiterView> {
  return useQuery({
    // Under ['hr'] so every Recruiting write (and the journey's own refresh) refreshes it too.
    queryKey: ['hr', 'recruit', 'dot-app', key],
    queryFn: () => apiGet<DotAppRecruiterView>(R(key)),
    refetchInterval: 30_000,
  });
}

export const dotAppRecruiterApi = {
  issue: (key: string, body: DotAppIssueInput) => apiPost<DotAppIssued>(`${R(key)}/link`, body),
  copied: (key: string) => apiPost<unknown>(`${R(key)}/link/copied`, {}),
  revoke: (key: string) => apiPost<unknown>(`${R(key)}/link/revoke`, {}),
};

// ------------------------------------------------------------------------------- Safety review

export function useSafetyDotApps(): UseQueryResult<DotAppSummary[]> {
  return useQuery({ queryKey: ['dot-app', 'safety'], queryFn: () => apiGet<DotAppSummary[]>(S), refetchInterval: 60_000 });
}

export function useSafetyDotApp(id: string): UseQueryResult<DotAppSafetyDetail> {
  return useQuery({ queryKey: ['dot-app', 'safety', id], queryFn: () => apiGet<DotAppSafetyDetail>(`${S}/${enc(id)}`) });
}

export const dotAppSafetyApi = {
  employerForms: (id: string, version: number, employerForms: Record<string, unknown>) => apiPut<DotAppSafetyDetail>(`${S}/${enc(id)}/employer-forms`, { version, employerForms }),
  onboarding: (id: string, version: number, onboarding: Record<string, unknown>) => apiPut<DotAppSafetyDetail>(`${S}/${enc(id)}/onboarding`, { version, onboarding }),
  sign: (id: string, body: { key: string; docVersion: string; typedName: string; esignConsent: true; image: string; title?: string }) =>
    apiPost<DotAppSignatureView>(`${S}/${enc(id)}/signatures`, body),
  requestChanges: (id: string, sections: string[], message: string) =>
    apiPost<DotAppSafetyDetail & { email: { status: string; error: string | null } }>(`${S}/${enc(id)}/request-changes`, { sections, message }),
  approve: (id: string, note?: string) => apiPost<DotAppSafetyDetail>(`${S}/${enc(id)}/approve`, note ? { note } : {}),
  reject: (id: string, reason: string) => apiPost<DotAppSafetyDetail>(`${S}/${enc(id)}/reject`, { reason }),
  hire: (id: string, body: DotAppHireInput) => apiPost<DotAppSafetyDetail>(`${S}/${enc(id)}/hire`, body),
  note: (id: string, note: string) => apiPost<DotAppSafetyDetail>(`${S}/${enc(id)}/note`, { note }),
  ssn: (id: string) => apiPost<{ ssn: string }>(`${S}/${enc(id)}/ssn`, {}),
  /** ACH bank numbers: restricted code, audited on the server. */
  bank: (id: string) => apiPost<{ routing: string; account: string }>(`${S}/${enc(id)}/bank`, {}),
};

/** Signed document routes: opened only through a five-minute link (lib/files resolveFileFetchUrl). */
export const dotAppUrls = {
  file: (id: string, fileId: string) => `/${API_PREFIX}${S}/${enc(id)}/files/${enc(fileId)}`,
  signature: (id: string, key: string) => `/${API_PREFIX}${S}/${enc(id)}/signatures/${enc(key)}/image`,
  pdf: (id: string) => `/${API_PREFIX}${S}/${enc(id)}/pdf`,
};

/** A Safety write: the detail it returns becomes the cached detail, and the queue refreshes. */
export function useSafetyMutation<A, R>(id: string, fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      if (result && typeof result === 'object' && 'answers' in (result as object) && 'version' in (result as object)) {
        qc.setQueryData(['dot-app', 'safety', id], result);
      } else {
        void qc.invalidateQueries({ queryKey: ['dot-app', 'safety', id] });
      }
      void qc.invalidateQueries({ queryKey: ['dot-app', 'safety'], exact: true });
      void qc.invalidateQueries({ queryKey: ['hr'] });
    },
  });
}

// ------------------------------------------------------------------------------- Document templates

export function useTemplateOverview(): UseQueryResult<DotAppTemplateOverview> {
  return useQuery({ queryKey: ['dot-app', 'templates'], queryFn: () => apiGet<DotAppTemplateOverview>(T) });
}

export function useTemplate(id: string | null): UseQueryResult<DotAppTemplate & { row: DotAppTemplateRow }> {
  return useQuery({
    queryKey: ['dot-app', 'templates', id],
    queryFn: () => apiGet<DotAppTemplate & { row: DotAppTemplateRow }>(`${T}/${enc(id as string)}`),
    enabled: Boolean(id),
  });
}

export const templatesApi = {
  create: (body: { docKey: string; version: string; title: string; content: Record<string, unknown>; sourceFileId?: string; note?: string }) => apiPost<DotAppTemplateRow>(T, body),
  importSet: (setId: string) => apiPost<{ created: number; skipped: number }>(`${T}/import`, { setId }),
  approveDrafts: () => apiPost<{ approved: number }>(`${T}/approve-drafts`, {}),
  approve: (id: string) => apiPost<DotAppTemplateRow>(`${T}/${enc(id)}/approve`, {}),
  retire: (id: string, reason: string) => apiPost<DotAppTemplateRow>(`${T}/${enc(id)}/retire`, { reason }),
};

export function useTemplatesMutation<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dot-app', 'templates'] });
      void qc.invalidateQueries({ queryKey: ['hr'] });
    },
  });
}
