import { NavLink, Outlet } from 'react-router-dom';

import { ROUTES } from '../../lib/config';
import { cn } from '../../lib/cn';
import { useAuth } from '../../providers/AuthProvider';
import { useConfirm } from '../../providers/ConfirmProvider';
import { useToast } from '../../providers/ToastProvider';
import { Button } from '../ui/Button';

/**
 * Persistent chrome for the authenticated area: brand, navigation, operator identity
 * and logout, with the routed page beneath.
 *
 * The navigation is a genuine improvement rather than a port. The old pages were only
 * partially linked — there was no route from the dashboard to file upload at all, so
 * operators had to type /file-upload by hand — and logout was implemented two
 * different ways (a POST on two pages, a bare GET link on the third). One nav, one
 * logout.
 */

const NAV_ITEMS = [
  { to: ROUTES.dashboard, label: 'Dashboard', icon: 'fa-chart-line' },
  { to: ROUTES.fileManager, label: 'Recipient Files', icon: 'fa-folder-tree' },
  { to: ROUTES.imapAccounts, label: 'IMAP Setup', icon: 'fa-server' }
];

export function AppShell() {
  const { user, logout, isLoggingOut } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();

  async function handleLogout() {
    const ok = await confirm({
      title: 'Confirm logout',
      message: "Are you sure you want to log out? You'll need to sign in again to access the dashboard.",
      confirmLabel: 'Log out',
      cancelLabel: 'Stay signed in',
      tone: 'warning'
    });

    if (!ok) return;

    try {
      await logout();
    } catch (err) {
      // The provider clears local session state regardless (onSettled), so the
      // operator is signed out here either way; this only reports that the server
      // was not reached to invalidate the cookie.
      toast.error(`⚠️ Signed out locally, but the server could not be reached (${err.message}).`);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header
        className={cn(
          'sticky top-0 z-[100] flex flex-wrap items-center gap-x-6 gap-y-3',
          'border-b border-line bg-surface px-4 py-3 shadow-xs md:px-6'
        )}
      >
        <span className="flex items-center gap-2">
          <img src="/logo.svg" alt="" className="h-8 w-8 rounded-full border border-line" />
          <span className="text-lg font-bold tracking-tight text-ink-900">Opterite</span>
        </span>

        <nav className="flex items-center gap-1 rounded-lg border border-line bg-ink-50 p-1" aria-label="Main">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === ROUTES.dashboard}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold no-underline',
                  'transition-colors duration-[120ms] ease-standard',
                  isActive
                    ? 'bg-surface text-brand-700 shadow-xs'
                    : 'text-ink-600 hover:bg-surface hover:text-ink-900'
                )
              }
            >
              <i className={cn('fa-solid', item.icon)} aria-hidden="true" />
              <span className="hidden sm:inline">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <span className="ml-auto flex items-center gap-4">
          <span className="hidden flex-col text-right leading-tight sm:flex">
            <span className="text-sm font-semibold text-ink-800">{user?.name ?? 'User'}</span>
            <span className="text-xs text-muted">{user?.email ?? ''}</span>
          </span>

          <Button
            variant="danger"
            size="sm"
            icon="fa-right-from-bracket"
            onClick={handleLogout}
            loading={isLoggingOut}
            loadingLabel="Logging out…"
          >
            Logout
          </Button>
        </span>
      </header>

      <main className="mx-auto w-full max-w-[1800px] flex-1 px-4 py-5 md:px-6">
        <Outlet />
      </main>
    </div>
  );
}
