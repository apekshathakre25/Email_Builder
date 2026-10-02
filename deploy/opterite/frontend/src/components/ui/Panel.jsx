import { cn } from '../../lib/cn';

/**
 * Card with a header strip.
 *
 * The `test` and `bulk` variants keep the colour coding the old dashboard relied on
 * to tell its two live-status boxes apart at a glance — green for test sends, brand
 * blue for bulk — via a 3px left border, as before.
 */

const ACCENTS = {
  default: '',
  test: 'border-l-3 border-l-success-500',
  bulk: 'border-l-3 border-l-brand-500',
  info: 'border-l-3 border-l-info-500',
  danger: 'border-l-3 border-l-danger-500',
  warning: 'border-l-3 border-l-warning-500'
};

const TITLE_TONES = {
  default: 'text-ink-800',
  test: 'text-success-600',
  bulk: 'text-brand-700',
  info: 'text-info-600',
  danger: 'text-danger-600',
  warning: 'text-warning-700'
};

export function Panel({ variant = 'default', className, children }) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xs',
        ACCENTS[variant] ?? '',
        className
      )}
    >
      {children}
    </section>
  );
}

export function PanelHeader({ className, children }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-b border-line bg-ink-25 px-4 py-3',
        className
      )}
    >
      {children}
    </div>
  );
}

export function PanelTitle({ icon, variant = 'default', className, children, as: Tag = 'h2' }) {
  return (
    <Tag className={cn('flex items-center gap-2 text-md font-semibold', TITLE_TONES[variant], className)}>
      {icon ? <i className={cn('fa-solid', icon)} aria-hidden="true" /> : null}
      {children}
    </Tag>
  );
}

/** Pushes whatever follows it to the right of the header. */
export function PanelSpacer() {
  return <span className="ml-auto" />;
}

export function PanelBody({ className, children }) {
  return <div className={cn('flex min-w-0 flex-col gap-3 p-4', className)}>{children}</div>;
}

export function PanelFooter({ className, children }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 border-t border-line bg-ink-25 px-4 py-3', className)}>
      {children}
    </div>
  );
}

/** Toolbar strip of actions, matching `.toolbar`. */
export function Toolbar({ className, children }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

/**
 * Inline notice. `.callout` in the old stylesheet.
 */
export function Callout({ tone = 'info', icon, className, children }) {
  const TONES = {
    info: 'border-info-500/35 bg-info-50 text-ink-700',
    brand: 'border-brand-200 bg-brand-50 text-ink-700',
    success: 'border-success-500/35 bg-success-50 text-ink-700',
    warning: 'border-warning-500/45 bg-warning-50 text-ink-700',
    danger: 'border-danger-500/35 bg-danger-50 text-ink-700'
  };

  return (
    <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2.5 text-base', TONES[tone], className)}>
      {icon ? <i className={cn('fa-solid', icon, 'mt-0.5 shrink-0')} aria-hidden="true" /> : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
