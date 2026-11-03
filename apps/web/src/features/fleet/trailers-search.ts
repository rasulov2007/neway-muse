import { z } from 'zod';

import { searchPage, searchText } from './search-fields';

/** The Trailers list URL. Every filter lives here so a filtered pool can be sent as a link. */
export const trailersSearchSchema = z.object({
  q: searchText,
  status: searchText,
  type: searchText,
  truck: searchText,
  ids: searchText,
  page: searchPage,
});

export type TrailersSearch = z.infer<typeof trailersSearchSchema>;
