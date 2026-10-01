import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

/**
 * Transient notifications.
 *
 * The old frontend had two incompatible mechanisms: a plain text line (`#errors`) on
 * the dashboard and a bottom-right toast on the other two pages. Both are kept,
 * because they answer different questions — but only the transient one lives here.
 * Persistent campaign state has its own permanently visible line on the dashboard
 * (see ResultsLine), since "Campaign is running — 412 sent" must not disappear after
 * five seconds.
 *
 * `#errors` was not a live region, so a screen reader was never told when it
 * changed. This container is, which closes that gap without the operator noticing
 * any visual difference.
 */

const ToastContext = createContext(null);

const DEFAULT_DURATION = 5_000;

/** Tone inferred from the emoji the old code used, so ported strings keep their colour. */
function inferTone(message) {
  const text = String(message ?? '');
  if (text.startsWith('✅')) return 'success';
  if (text.startsWith('❌')) return 'error';
  if (text.startsWith('⚠️')) return 'warning';
  if (text.startsWith('⏹️') || text.startsWith('🔒')) return 'error';
  if (text.startsWith('⏳') || text.startsWith('ℹ️')) return 'info';
  return 'info';
}

const TONE_STYLES = {
  success: 'border-success-500/40 bg-success-50 text-success-600',
  error: 'border-danger-500/40 bg-danger-50 text-danger-600',
  warning: 'border-warning-500/50 bg-warning-50 text-warning-700',
  info: 'border-brand-200 bg-brand-50 text-brand-700'
};

const TONE_ICONS = {
  success: 'fa-circle-check',
  error: 'fa-circle-xmark',
  warning: 'fa-triangle-exclamation',
  info: 'fa-circle-info'
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const nextId = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));

    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (message, options = {}) => {
      const text = typeof message === 'string' ? message : String(message ?? '');
      if (!text.trim()) return null;

      const { tone = inferTone(text), duration = DEFAULT_DURATION, title } = options;

      nextId.current += 1;
      const id = nextId.current;

      setToasts((current) => {
        // Cap the stack. A failing poll or a bulk delete loop can produce a burst,
        // and a column of toasts tall enough to cover the page is worse than losing
        // the oldest few.
        const next = [...current, { id, message: text, tone, title }];
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });

      // duration 0 means "stay until dismissed", for anything the operator must
      // actually read.
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration)
        );
      }

      return id;
    },
    [dismiss]
  );

  // Clear every pending timer on unmount so a dismissal cannot fire against an
  // unmounted provider during a hot reload or a logout teardown.
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    []
  );

  const value = useMemo(
    () => ({
      show,
      dismiss,
      success: (message, options) => show(message, { ...options, tone: 'success' }),
      error: (message, options) => show(message, { ...options, tone: 'error' }),
      warning: (message, options) => show(message, { ...options, tone: 'warning' }),
      info: (message, options) => show(message, { ...options, tone: 'info' })
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          className="pointer-events-none fixed bottom-4 right-4 z-[9500] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2"
          role="status"
          aria-live="polite"
          aria-atomic="false"
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={cn(
                'pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-3',
                'shadow-md animate-toast-in',
                TONE_STYLES[toast.tone] ?? TONE_STYLES.info
              )}
            >
              <i className={cn('fa-solid mt-0.5 shrink-0', TONE_ICONS[toast.tone] ?? TONE_ICONS.info)} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                {toast.title ? <p className="font-semibold">{toast.title}</p> : null}
                <p className="break-words text-base">{toast.message}</p>
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
                className="shrink-0 rounded-sm px-1 opacity-70 transition-opacity hover:opacity-100"
              >
                <i className="fa-solid fa-xmark" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider.');
  return context;
}
