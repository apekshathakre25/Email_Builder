import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as authApi from '../api/authApi';
import { onUnauthorized } from '../lib/apiClient';
import { keys } from '../lib/queryKeys';
import { clearPersistedCampaignForm } from '../features/dashboard/campaignFormStorage';

/**
 * Session state.
 *
 * The session itself lives in an httpOnly cookie, which JavaScript cannot read by
 * design. So this does not track a token — it tracks the server's answer to "am I
 * signed in", via /check-auth, and treats that answer as authoritative.
 *
 * The important wiring is the `onUnauthorized` subscription: any request anywhere in
 * the app that comes back 401 flips the whole app to signed-out in one place. Without
 * it, an expired session would surface as a scattering of failed panels and the
 * operator would have no idea why.
 */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();

  const sessionQuery = useQuery({
    queryKey: keys.auth.session,
    queryFn: ({ signal }) => authApi.checkAuth(signal),
    staleTime: 60_000,
    // A session can expire while the tab sits in the background, so re-checking on
    // focus means the operator is told before their next action fails.
    refetchOnWindowFocus: true,
    retry: 1
  });

  /**
   * Drops all cached server state.
   *
   * Not merely cosmetic: the cache holds the previous operator's SMTP hostnames,
   * recipient files, campaign logs and IMAP accounts. Leaving it in place would show
   * one operator another's data for as long as it took each panel to refetch.
   */
  const resetSession = useCallback(() => {
    queryClient.setQueryData(keys.auth.session, { authenticated: false });
    queryClient.removeQueries({ queryKey: keys.files.all });
    queryClient.removeQueries({ queryKey: keys.imap.all });
    queryClient.removeQueries({ queryKey: keys.emailConfig });
    queryClient.removeQueries({ queryKey: keys.health });
  }, [queryClient]);

  // One subscription for the whole app: every 401 from any endpoint lands here.
  useEffect(() => onUnauthorized(resetSession), [resetSession]);

  const loginMutation = useMutation({
    mutationFn: authApi.login,
    onSuccess: (data) => {
      queryClient.setQueryData(keys.auth.session, { authenticated: true, user: data?.user });
    }
  });

  const logoutMutation = useMutation({
    mutationFn: authApi.logout,
    // onSettled rather than onSuccess: if the request fails, the operator still asked
    // to leave, and the cookie may well be gone anyway. Staying signed in after a
    // failed logout is the worse outcome.
    onSettled: () => {
      // The campaign draft is per-tab sessionStorage stamped with the operator's
      // email, so it survives a logout in this tab. Cleared here so the next person
      // to sign in does not inherit the previous operator's SMTP settings.
      clearPersistedCampaignForm();
      resetSession();
    }
  });

  const value = useMemo(
    () => ({
      user: sessionQuery.data?.authenticated ? (sessionQuery.data.user ?? null) : null,
      isAuthenticated: Boolean(sessionQuery.data?.authenticated),
      // Only the very first read is "loading". A background revalidation must not
      // blank the app, which is what gating on isFetching would do.
      isLoading: sessionQuery.isLoading,
      isError: sessionQuery.isError,
      refresh: sessionQuery.refetch,

      login: loginMutation.mutateAsync,
      isLoggingIn: loginMutation.isPending,

      logout: logoutMutation.mutateAsync,
      isLoggingOut: logoutMutation.isPending
    }),
    [
      sessionQuery.data,
      sessionQuery.isLoading,
      sessionQuery.isError,
      sessionQuery.refetch,
      loginMutation.mutateAsync,
      loginMutation.isPending,
      logoutMutation.mutateAsync,
      logoutMutation.isPending
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider.');
  return context;
}
