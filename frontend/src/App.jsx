import { Navigate, Route, Routes } from 'react-router-dom';

import { ROUTES } from './lib/config';
import { useAuth } from './providers/AuthProvider';
import { AppShell } from './components/layout/AppShell';
import { FullPageSpinner } from './components/layout/FullPageSpinner';
import { LoginPage } from './features/auth/LoginPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { FileManagerPage } from './features/files/FileManagerPage';
import { ImapAccountsPage } from './features/imap/ImapAccountsPage';
import { NotFoundPage } from './features/misc/NotFoundPage';
import { useKeepAlive } from './hooks/useKeepAlive';

/**
 * Gate for the authenticated area.
 *
 * `isLoading` is only true for the very first /check-auth. Redirecting during it
 * would bounce every cold load through the login screen before landing on the
 * dashboard, so the spinner is what keeps a refresh from looking like a logout.
 */
function RequireAuth({ children }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <FullPageSpinner label="Checking your session…" />;
  if (!isAuthenticated) return <Navigate to={ROUTES.login} replace />;

  return children;
}

/** Keeps an authenticated operator off the login screen. */
function RedirectIfAuthenticated({ children }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <FullPageSpinner label="Checking your session…" />;
  if (isAuthenticated) return <Navigate to={ROUTES.dashboard} replace />;

  return children;
}

export default function App() {
  // Holds the backend connection warm for a tab left open all day. Mounted at the
  // root rather than per page so navigating between pages does not restart the timer.
  useKeepAlive();

  return (
    <Routes>
      <Route
        path={ROUTES.login}
        element={
          <RedirectIfAuthenticated>
            <LoginPage />
          </RedirectIfAuthenticated>
        }
      />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path={ROUTES.dashboard} element={<DashboardPage />} />
        <Route path={ROUTES.fileManager} element={<FileManagerPage />} />
        <Route path={ROUTES.imapAccounts} element={<ImapAccountsPage />} />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
