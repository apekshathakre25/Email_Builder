import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FALLBACK_APP_CONFIG, getAppConfig } from '../api/appConfigApi';
import { keys } from '../lib/queryKeys';

/**
 * Server-owned configuration, fetched once and shared.
 *
 * Deliberately never suspends or blocks rendering. If /api/app-config is
 * unreachable the app still works with FALLBACK_APP_CONFIG — the login page shows a
 * free-text email field instead of the account dropdown, and validation falls back
 * to the server's documented bounds. Blocking the whole UI on a config read would
 * turn a cosmetic degradation into an outage.
 */

const AppConfigContext = createContext(FALLBACK_APP_CONFIG);

export function AppConfigProvider({ children }) {
  const { data } = useQuery({
    queryKey: keys.appConfig,
    queryFn: ({ signal }) => getAppConfig(signal),
    // Cannot change without a server restart, so there is no reason to revalidate it
    // during a session.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1
  });

  return <AppConfigContext.Provider value={data ?? FALLBACK_APP_CONFIG}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig() {
  return useContext(AppConfigContext);
}
