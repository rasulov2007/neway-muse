import { z } from 'zod';
import { searchText } from '@/features/fleet/search-fields';

/**
 * URL state for Reports and Analytics.
 *
 * The filters live in the URL so a report configuration is a link somebody can send, and so a saved
 * view can be reopened by restoring the same search params.
 */
export const insightsSearchSchema = z.object({
  tab: searchText,
  report: searchText,
  preset: searchText,
  q: searchText,
  truck: searchText,
  driver: searchText,
  department: searchText,
  status: searchText,
  from: searchText,
  to: searchText,
});

export type InsightsSearch = z.infer<typeof insightsSearchSchema>;
