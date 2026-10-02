import { useEffect, useRef, useState } from 'react';

import { cn } from '../../../lib/cn';
import { formatCountdown, formatNumber } from '../../../lib/format';
import { Button } from '../../../components/ui/Button';

const TICK_MS = 250;

/**
 * Floating panel for a paced campaign: the rate it is running at, its progress, and how
 * long until the next interval opens.
 *
 * ── The countdown is anchored to the server, never owned by the browser ──────
 *
 * /status returns `window.resetInMs`, read from the same Redis bucket the workers are
 * actually gated on. The local ticker only fills the ~1.5s gap between polls and is
 * re-anchored on every response. That ordering is what stops the panel counting down
 * against a campaign that is no longer sending — a browser-owned timer would keep
 * ticking happily after a stop, which is the single most misleading thing this panel
 * could do.
 *
 * Shown only for a campaign with a rate configured. `rateLimit === null` from the server
 * means there are no intervals to report, so there is no panel.
 */
export function IntervalPopup({ status, onStop, onClose, isStopping }) {
  const rate = status?.rateLimit;
  const isStopped = Boolean(status?.stopped);

  const [remainingMs, setRemainingMs] = useState(0);
  const anchor = useRef({ at: 0, ms: 0 });

  const resetInMs = status?.window?.resetInMs ?? 0;

  // Re-anchor whenever a poll brings a new reading.
  useEffect(() => {
    anchor.current = { at: Date.now(), ms: Math.max(0, Number(resetInMs) || 0) };
    setRemainingMs(anchor.current.ms);
  }, [resetInMs]);

  useEffect(() => {
    // Nothing to count down on a stopped campaign. Halting the ticker here is what makes
    // the panel honest about the stop.
    if (isStopped) return undefined;

    const timer = setInterval(() => {
      const elapsed = Date.now() - anchor.current.at;
      setRemainingMs(Math.max(0, anchor.current.ms - elapsed));
    }, TICK_MS);

    return () => clearInterval(timer);
  }, [isStopped]);

  if (!rate?.limit || !rate?.intervalSeconds) return null;

  return (
    <aside
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-4 right-4 z-[9000] w-[min(20rem,calc(100vw-2rem))]',
        'rounded-lg border bg-surface p-4 shadow-lg',
        isStopped ? 'border-l-3 border-l-danger-500 border-line' : 'border-line'
      )}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Hide this panel"
        title="Hide this panel — the campaign keeps running"
        className="absolute right-2 top-2 rounded-sm px-1.5 py-0.5 text-muted transition-colors hover:bg-ink-50 hover:text-ink-700"
      >
        <i className="fa-solid fa-xmark" aria-hidden="true" />
      </button>

      <h3 className="mb-3 flex items-center gap-2 pr-6 text-md font-semibold text-ink-800">
        <i className="fa-solid fa-gauge-high text-brand-500" aria-hidden="true" />
        Email Sending
      </h3>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-base">
        <dt className="text-muted">Limit</dt>
        <dd className="text-right font-mono font-semibold tabular-nums text-ink-800">
          {formatNumber(rate.limit)} emails
        </dd>

        <dt className="text-muted">Interval</dt>
        <dd className="text-right font-mono font-semibold tabular-nums text-ink-800">
          {rate.intervalSeconds} second{rate.intervalSeconds === 1 ? '' : 's'}
        </dd>

        <dt className="text-muted">Sent</dt>
        <dd className="text-right font-mono font-semibold tabular-nums text-success-600">
          {formatNumber(status.sent ?? 0)}
        </dd>

        <dt className="text-muted">Pending</dt>
        <dd className="text-right font-mono font-semibold tabular-nums text-warning-700">
          {status.pending === undefined ? '—' : formatNumber(status.pending)}
        </dd>

        <dt className="text-muted">Next interval</dt>
        <dd className="text-right font-mono font-semibold tabular-nums text-ink-800">
          {isStopped ? '—' : formatCountdown(remainingMs)}
        </dd>
      </dl>

      <p className="mt-3 text-xs text-muted">
        {isStopped
          ? 'Sending stopped. Remaining recipients are still pending.'
          : status.window
            ? `Window usage ${formatNumber(status.window.used)}/${formatNumber(status.window.limit)}.`
            : 'Waiting for the next window reading…'}
      </p>

      {/*
        Removed once stopped: there is nothing left to stop. The panel itself stays as a
        record of the final counters — the operator has just done something consequential
        and the numbers are what they want to see.
      */}
      {!isStopped ? (
        <Button
          variant="danger"
          icon="fa-circle-stop"
          onClick={onStop}
          loading={isStopping}
          loadingLabel="Stopping…"
          block
          className="mt-3"
        >
          Stop Sending
        </Button>
      ) : null}
    </aside>
  );
}
