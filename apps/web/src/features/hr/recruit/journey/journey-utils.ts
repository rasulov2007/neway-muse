import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { RecruitCandidate, RecruitProgress } from '@neway/shared';
import { ApiError } from '@/lib/api-client';

/** A write that refreshes Recruiting (candidate, journey, list, dashboard) once the server took it. */
export function useJourneyMutation<TInput, TResult>(send: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['hr'] });
    },
  });
}

/** The server's own sentence for a refusal; never a raw response. */
export function errorText(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (error instanceof ApiError) return error.message || fallback;
  return fallback;
}

export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Which of the nine steps a progress value is at (1-based). */
export function stepOf(progress: RecruitProgress): number {
  switch (progress) {
    case 'new':
    case 'no_answer':
    case 'contacted':
    case 'prequalified':
      return 1;
    case 'consent_sent':
      return 2;
    // Consent in: the reports and Send to Safety are on step 3 itself (owner, 2026-10-13).
    case 'consent_received':
      return 3;
    case 'safety_review':
      return 4;
    case 'application_sent':
      return 5;
    case 'application_received':
      return 6;
    case 'onboarding':
      return 7;
    case 'ready_to_hire':
      return 8;
    case 'hired':
      return 9;
    case 'closed':
      return 0;
  }
}

/** Which step is current, which can be opened, and which is shown (?step=N). */
export function useJourneyStep(c: RecruitCandidate) {
  const raw = useSearch({ strict: false }) as { step?: string };
  const navigate = useNavigate();
  const current = stepOf(c.progress);
  const asked = Number(raw.step);
  // Step 2 (Send consent) opens straight from the lead: no link has to exist before choosing how to send it.
  // Ready to hire (8) opens during onboarding too, so the checklist shows what still blocks the hire.
  const furthest = current === 1 ? 2 : current === 7 ? 8 : current;
  const shown = Number.isInteger(asked) && asked >= 1 && asked <= 9 && (asked <= furthest || current === 0) ? asked : current;
  const pick = (n: number) =>
    void navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, tab: undefined, step: n === current ? undefined : String(n) })) as never, replace: true });
  return { current, furthest, shown, pick };
}

