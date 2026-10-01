import { cn } from '../../lib/cn';

/**
 * Status pill.
 *
 * The tone names are the domain's own vocabulary rather than colour names: `inbox`
 * and `spam` are IMAP placements, `uploaded`/`processing`/`completed` are file
 * states, `in_progress`/`stopped` are campaign states. Naming them after the state
 * means the colour mapping lives here instead of being decided at each call site,
 * which is how the old code ended up with four different greens.
 */

const TONES = {
  neutral: 'bg-surface-muted text-ink-600 border-line',
  brand: 'bg-brand-50 text-brand-700 border-brand-200',
  success: 'bg-success-50 text-success-600 border-success-500/30',
  danger: 'bg-danger-50 text-danger-600 border-danger-500/30',
  warning: 'bg-warning-50 text-warning-700 border-warning-500/40',
  info: 'bg-info-50 text-info-600 border-info-500/30',
  accent: 'bg-accent-50 text-accent-600 border-accent-500/30',

  // IMAP placement outcomes.
  inbox: 'bg-success-50 text-success-600 border-success-500/30',
  spam: 'bg-danger-50 text-danger-600 border-danger-500/30',
  pending: 'bg-warning-50 text-warning-700 border-warning-500/40',
  unknown: 'bg-surface-muted text-ink-500 border-line',
  auto: 'bg-accent-50 text-accent-600 border-accent-500/30',

  // Recipient file states.
  uploaded: 'bg-brand-50 text-brand-700 border-brand-200',
  processing: 'bg-warning-50 text-warning-700 border-warning-500/40',
  completed: 'bg-success-50 text-success-600 border-success-500/30',
  failed: 'bg-danger-50 text-danger-600 border-danger-500/30',

  // Campaign states.
  in_progress: 'bg-warning-50 text-warning-700 border-warning-500/40',
  stopped: 'bg-danger-50 text-danger-600 border-danger-500/30'
};

const ICONS = {
  inbox: 'fa-inbox',
  spam: 'fa-triangle-exclamation',
  pending: 'fa-clock',
  unknown: 'fa-question',
  uploaded: 'fa-cloud-arrow-up',
  processing: 'fa-spinner',
  completed: 'fa-circle-check',
  failed: 'fa-circle-xmark',
  in_progress: 'fa-paper-plane',
  stopped: 'fa-circle-stop'
};

export function Badge({ tone = 'neutral', icon, showIcon = true, className, children }) {
  const resolvedIcon = icon ?? (showIcon ? ICONS[tone] : undefined);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'text-xs font-semibold whitespace-nowrap',
        TONES[tone] ?? TONES.neutral,
        className
      )}
    >
      {resolvedIcon ? <i className={cn('fa-solid', resolvedIcon)} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
