import { forwardRef } from 'react';
import { cn } from '../../lib/cn';

/**
 * The application button.
 *
 * Variants are the same set the old stylesheet defined (.btn--primary, --secondary,
 * --danger, --success, --info, --accent, --ghost), each hovering to the -600 step of
 * its own colour family, so ported markup keeps its exact meaning: danger is still
 * Stop Sending, accent is still the IMAP link, ghost is still an inline Info button.
 */

const VARIANTS = {
  primary: 'bg-brand-500 text-inverse hover:bg-brand-600 border-transparent',
  secondary: 'bg-surface text-ink-700 hover:bg-ink-50 border-line-strong',
  danger: 'bg-danger-500 text-inverse hover:bg-danger-600 border-transparent',
  success: 'bg-success-500 text-inverse hover:bg-success-600 border-transparent',
  info: 'bg-info-500 text-inverse hover:bg-info-600 border-transparent',
  accent: 'bg-accent-500 text-inverse hover:bg-accent-600 border-transparent',
  warning: 'bg-warning-500 text-ink-900 hover:bg-warning-500/85 border-transparent',
  ghost: 'bg-transparent text-brand-600 hover:bg-brand-50 border-transparent',
  outline: 'bg-transparent text-ink-600 hover:bg-ink-50 border-line-strong'
};

const SIZES = {
  sm: 'text-xs px-2.5 py-1.5 gap-1.5',
  md: 'text-base px-3.5 py-2 gap-2',
  icon: 'text-base w-8 h-8 p-0 justify-center'
};

export const Button = forwardRef(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    loading = false,
    loadingLabel,
    block = false,
    className,
    children,
    disabled,
    // Defaults to 'button' rather than 'submit'. The HTML default caused real
    // trouble in the old dashboard: any button inside the campaign form that
    // forgot type="button" submitted the campaign.
    type = 'button',
    ...rest
  },
  ref
) {
  const isDisabled = Boolean(disabled) || loading;

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-md border font-semibold',
        'transition-colors duration-[120ms] ease-standard',
        'disabled:cursor-not-allowed disabled:opacity-55',
        'active:enabled:scale-[0.98]',
        VARIANTS[variant] ?? VARIANTS.secondary,
        SIZES[size] ?? SIZES.md,
        block && 'w-full',
        className
      )}
      {...rest}
    >
      {loading ? (
        <>
          <i className="fa-solid fa-spinner fa-spin" aria-hidden="true" />
          {loadingLabel ?? children}
        </>
      ) : (
        <>
          {icon ? <i className={cn('fa-solid', icon)} aria-hidden="true" /> : null}
          {children}
        </>
      )}
    </button>
  );
});

/** Horizontal group of actions that wraps on narrow screens. */
export function ButtonRow({ className, children }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}
