import { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';

/**
 * Modal dialog.
 *
 * Reproduces the behaviour of the old confirm-dialog.js, which was the most
 * carefully built piece of the previous frontend and is worth preserving exactly:
 *
 *   - role="dialog" aria-modal, labelled by the title and described by the body
 *   - Escape, the backdrop and the close button all dismiss
 *   - focus trapped on Tab / Shift+Tab while open
 *   - initial focus on the *safe* control (Cancel), never the destructive one
 *   - page scroll locked while open, and the previously focused element restored
 *     on close, so dismissing a dialog returns the keyboard where it was
 *
 * Rendered through a portal so a dialog opened from deep inside the campaign form is
 * not clipped by an ancestor's overflow, and cannot inherit a stacking context that
 * puts it behind the page.
 */

const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

const SIZES = {
  sm: 'max-w-[440px]',
  md: 'max-w-[620px]',
  lg: 'max-w-[720px]',
  xl: 'max-w-[900px]',
  full: 'max-w-[min(1100px,95vw)]'
};

export function Modal({
  open,
  onClose,
  title,
  titleIcon,
  titleTone = 'default',
  size = 'lg',
  initialFocusRef,
  footer,
  children,
  // Set false for a dialog whose content is being interacted with and where an
  // accidental backdrop click would lose work.
  closeOnBackdrop = true,
  bodyClassName,
  describedBy
}) {
  const panelRef = useRef(null);
  const previouslyFocused = useRef(null);
  const generatedId = useId();
  const titleId = `${generatedId}-title`;
  const bodyId = `${generatedId}-body`;

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
        return;
      }

      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement
      );

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      // Wrap at both ends. Without this, Tab walks out of the dialog into the page
      // behind it, which for a modal is the same as not having one.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;

    // Captured now rather than read in the cleanup. By the time cleanup runs the ref may
    // already have been cleared by unmount, which would make the "is focus still inside the
    // dialog" test below silently answer no and skip restoring focus.
    const panel = panelRef.current;
    const restoreTo = previouslyFocused.current;

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    // Deferred a frame: the portal content is not in the document on the first
    // effect pass, so focusing synchronously would target nothing.
    const focusTimer = requestAnimationFrame(() => {
      const target =
        initialFocusRef?.current ??
        panel?.querySelector('[data-autofocus]') ??
        panel?.querySelector(FOCUSABLE) ??
        panel;

      target?.focus?.();
    });

    return () => {
      cancelAnimationFrame(focusTimer);
      document.body.style.overflow = overflow;

      // Only restore focus if it is still inside the dialog. If something else took it in
      // the meantime — a toast action, a newly opened dialog — yanking it back would be the
      // more surprising behaviour.
      const active = document.activeElement;
      if (!active || active === document.body || panel?.contains(active)) {
        restoreTo?.focus?.();
      }
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  const TITLE_TONES = {
    default: 'text-ink-800',
    danger: 'text-danger-600',
    warning: 'text-warning-700',
    success: 'text-success-600',
    brand: 'text-brand-700'
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-ink-900/55 p-4 animate-overlay-in"
      onMouseDown={(event) => {
        // mousedown on the backdrop itself, not a click that merely ended there:
        // a drag that starts inside the dialog and releases outside it should not
        // dismiss.
        if (closeOnBackdrop && event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={describedBy ?? bodyId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={cn(
          'flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl border border-line',
          'bg-surface shadow-overlay animate-panel-in focus:outline-none',
          SIZES[size] ?? SIZES.lg
        )}
      >
        {title ? (
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
            <h2 id={titleId} className={cn('flex flex-1 items-center gap-2 text-lg font-semibold', TITLE_TONES[titleTone])}>
              {titleIcon ? <i className={cn('fa-solid', titleIcon)} aria-hidden="true" /> : null}
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className={cn(
                'shrink-0 rounded-md px-2 py-1 text-muted transition-colors duration-[120ms]',
                'hover:bg-ink-50 hover:text-ink-700'
              )}
            >
              <i className="fa-solid fa-xmark" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div id={bodyId} className={cn('min-h-0 flex-1 overflow-auto px-5 py-4', bodyClassName)}>
          {children}
        </div>

        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-ink-25 px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
