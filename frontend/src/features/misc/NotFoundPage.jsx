import { Link } from 'react-router-dom';
import { ROUTES } from '../../lib/config';
import { Button } from '../../components/ui/Button';

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-sunken px-4 text-center">
      <img src="/logo.svg" alt="" className="h-12 w-12 rounded-full border border-line shadow-sm" />
      <p className="font-mono text-xl font-bold text-brand-500">404</p>
      <h1 className="text-xl font-bold text-ink-900">Page not found</h1>
      <p className="max-w-md text-base text-muted">
        The page you are looking for does not exist or has moved.
      </p>
      <Link to={ROUTES.dashboard} className="no-underline">
        <Button variant="primary" icon="fa-house">
          Go to dashboard
        </Button>
      </Link>
    </div>
  );
}
