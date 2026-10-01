import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { cn } from '../lib/cn';

/**
 * Promise-based confirmation, replacing window.confirm.
 *
 * The old code was explicit about why the native dialog had to go, and the reasoning
 * still holds: it wrapped the most consequential action in the product in browser
 * chrome ("localhost:3000 says"), and because it blocks the main thread it also
 * froze the status poller and the interval countdown for as long as it was open — so
 * the numbers behind it were stale the moment it was answered. Nothing in React
 * blocks, so the campaign keeps updating behind this dialog.
 *
 * Every dismissal path resolves false: Escape, the backdrop, the close button and
 * Cancel. Only the confirm button resolves true.
 */

const ConfirmContext = createContext(null);

const TONE_CONFIG = {
  danger: { icon: 'fa-triangle-exclamation', titleTone: 'danger', confirmVariant: 'danger', confirmIcon: 'fa-circle-stop' },
  warning: { icon: 'fa-triangle-exclamation', titleTone: 'warning', confirmVariant: 'warning', confirmIcon: 'fa-check' },
  primary: { icon: 'fa-circle-question', titleTone: 'brand', confirmVariant: 'primary', confirmIcon: 'fa-check' },
  info: { icon: 'fa-circle-info', titleTone: 'default', confirmVariant: 'primary', confirmIcon: 'fa-check' }
};

export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolverRef = useRef(null);
  const cancelRef = useRef(null);

  const settle = useCallback((result) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setDialog(null);
    resolve?.(result);
  }, []);

  const confirm = useCallback((options = {}) => {
    // A second request while one is open resolves false rather than queueing or
    // replacing. Replacing would let a click land on a dialog the operator never
    // read, which for a destructive action is exactly the failure to avoid.
    if (resolverRef.current) return Promise.resolve(false);

    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setDialog({
        title: options.title ?? 'Are you sure?',
        message: options.message ?? '',
        confirmLabel: options.confirmLabel ?? 'Confirm',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        tone: options.tone ?? 'primary'
      });
    });
  }, []);

  const value = useMemo(() => ({ confirm }), [confirm]);

  const tone = TONE_CONFIG[dialog?.tone] ?? TONE_CONFIG.primary;
  const paragraphs = Array.isArray(dialog?.message)
    ? dialog.message
    : dialog?.message
      ? [dialog.message]
      : [];

  return (
    <ConfirmContext.Provider value={value}>
      {children}

      <Modal
        open={Boolean(dialog)}
        onClose={() => settle(false)}
        title={dialog?.title}
        titleIcon={tone.icon}
        titleTone={tone.titleTone}
        size="sm"
        // Initial focus on Cancel, never on the destructive action. A confirmation
        // that lands focus on "Stop Sending" can be completed by a stray Enter
        // keypress, which defeats the point of asking.
        initialFocusRef={cancelRef}
        footer={
          <>
            <Button ref={cancelRef} variant="outline" onClick={() => settle(false)}>
              {dialog?.cancelLabel}
            </Button>
            <Button variant={tone.confirmVariant} icon={tone.confirmIcon} onClick={() => settle(true)}>
              {dialog?.confirmLabel}
            </Button>
          </>
        }
      >
        <div className={cn('flex flex-col gap-3 text-base text-ink-700')}>
          {paragraphs.map((paragraph, index) => (
            // Index keys are safe here: the list is static for the life of the dialog.
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error('useConfirm must be used inside a ConfirmProvider.');
  return context.confirm;
}
