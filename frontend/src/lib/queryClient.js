import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './apiClient';

/**
 * Shared query client.
 *
 * The defaults are tuned for an operator console that is left open all day and
 * watched while a campaign runs, which pushes in two opposite directions: reads
 * should be fresh, but the app must not turn a flaky network into a wall of errors
 * over a campaign that is sending perfectly well.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Short but non-zero. Long enough that mounting two components which read the
      // same endpoint costs one request, short enough that nothing looks stale.
      staleTime: 5_000,
      gcTime: 5 * 60_000,

      // Refetching on focus is right for this app: an operator switching back to the
      // tab wants the current picture, not whatever it showed when they left.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,

      retry(failureCount, error) {
        // A dead session will not fix itself by being asked again, and retrying
        // multiplies the logout notifications.
        if (error instanceof ApiError && error.isUnauthorized) return false;

        // Neither will a rate limit: the whole point of the bucket is to stop the
        // client trying. Endpoints that should retry a 429 do it deliberately, with
        // the server's own Retry-After.
        if (error instanceof ApiError && error.isRateLimited) return false;

        // A 4xx is a bad request; repeating it verbatim gets the same answer.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;

        return failureCount < 2;
      },

      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8_000)
    },

    mutations: {
      // Mutations are operator-initiated and often not idempotent — a retried
      // /send-email would enqueue a second batch. Failures are reported and left
      // for the operator to decide about.
      retry: false
    }
  }
});
