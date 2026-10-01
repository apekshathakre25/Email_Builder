import { cn } from '../../lib/cn';
import { formatNumber, percentage } from '../../lib/format';

/**
 * Counter readouts and progress bars.
 */

const STAT_TONES = {
  default: 'text-ink-800',
  brand: 'text-brand-600',
  success: 'text-success-600',
  danger: 'text-danger-600',
  warning: 'text-warning-700',
  info: 'text-info-600',
  muted: 'text-muted'
};

export function StatList({ columns = 2, className, children }) {
  return (
    <div
      className={cn('grid gap-2', className)}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  );
}

/**
 * One labelled counter.
 *
 * `aria-live="polite"` on the value, not the row: during a campaign these update
 * every 1.5s, and announcing the label each time would make a screen reader
 * unusable. Announcing only the number gives the change without the noise.
 */
export function Stat({ icon, label, value, tone = 'default', live = false, surface = 'muted', className }) {
  return (
    <p
      className={cn(
        'flex items-center gap-2 rounded-md px-2.5 py-2 text-base',
        surface === 'muted' && 'bg-ink-25',
        surface === 'brand' && 'bg-brand-50',
        surface === 'success' && 'bg-success-50',
        className
      )}
    >
      {icon ? <i className={cn('fa-solid shrink-0 text-ink-400', icon)} aria-hidden="true" /> : null}
      <span className="min-w-0 flex-1 truncate text-muted">{label}</span>
      <span
        className={cn('shrink-0 font-mono text-md font-semibold tabular-nums', STAT_TONES[tone])}
        aria-live={live ? 'polite' : undefined}
        aria-atomic={live ? 'true' : undefined}
      >
        {typeof value === 'number' ? formatNumber(value) : value}
      </span>
    </p>
  );
}

export function ProgressBar({ value, total, tone = 'brand', showLabel = true, className, label }) {
  const percent = percentage(value, total);

  const TONES = {
    brand: 'bg-brand-500',
    success: 'bg-success-500',
    warning: 'bg-warning-500',
    danger: 'bg-danger-500'
  };

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Progress'}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-[200ms] ease-standard', TONES[tone])}
          style={{ width: `${percent}%` }}
        />
      </div>
      {showLabel ? <span className="text-xs font-medium text-muted">{percent}% done</span> : null}
    </div>
  );
}

export function Spinner({ className, label = 'Loading' }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-muted', className)} role="status">
      <i className="fa-solid fa-spinner fa-spin" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
