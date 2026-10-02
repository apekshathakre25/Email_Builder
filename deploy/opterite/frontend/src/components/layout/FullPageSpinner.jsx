/**
 * Full-viewport loading state, used while the initial session check is in flight.
 */
export function FullPageSpinner({ label = 'Loading…' }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-surface-sunken" role="status">
      <img src="/logo.svg" alt="" className="h-12 w-12 rounded-full border border-line shadow-sm" />
      <p className="flex items-center gap-2 text-base text-muted">
        <i className="fa-solid fa-spinner fa-spin" aria-hidden="true" />
        {label}
      </p>
    </div>
  );
}
