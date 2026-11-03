import { z } from 'zod';
import { searchPage, searchText } from '@/features/fleet/search-fields';

/**
 * URL state for every Phase 11 page.
 *
 * One schema across the five because they share the same filter vocabulary — a stage, a department,
 * a date range, a page. Five near-identical schemas would drift apart within a month.
 */
export const hrSearchSchema = z.object({
  q: searchText,
  tab: searchText,
  stage: searchText,
  status: searchText,
  department: searchText,
  source: searchText,
  job: searchText,
  employeeId: searchText,
  policy: searchText,
  cycle: searchText,
  exception: searchText,
  from: searchText,
  to: searchText,
  onDate: searchText,
  includeClosed: searchText,
  includeFinished: searchText,
  unresolvedOnly: searchText,
  view: searchText,
  period: searchText,
  /** Recruiting: the lead open in the drawer, the opening open in the drawer. */
  lead: searchText,
  opening: searchText,
  /** Recruiting: filter by recruiter (employee id) and by campaign. */
  recruiter: searchText,
  /** Recruiting board: 'mine' shows only the signed-in recruiter's own leads (owner, 2026-10-16). */
  leads: z.enum(['mine']).optional().catch(undefined),
  campaign: searchText,
  /** Recruiting lists: the sorted column and its direction. */
  sort: searchText,
  dir: searchText,
  /** Recruiting home (2026-10-08): the candidate filter chip and the follow-up-due view. */
  filter: searchText,
  followUp: searchText,
  page: searchPage,
  pageSize: searchPage,
});

export type HrSearch = z.infer<typeof hrSearchSchema>;
