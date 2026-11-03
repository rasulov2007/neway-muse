import { QueryClient } from '@tanstack/react-query';

/**
 * One query cache for the application, created at module scope rather than inside a hook.
 *
 * Boot-time work outside React has to reach it. The saved snapshot is laid over the generated
 * dataset after render has already started, so anything fetched from the pre-snapshot data is
 * wrong the moment it lands and has to be thrown away. Without a handle on the cache from
 * outside, that work could only hope the pages refetched on their own — and with a 30s stale
 * time they did not, which is how a load could show a filed POD and a status that never moved.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});
