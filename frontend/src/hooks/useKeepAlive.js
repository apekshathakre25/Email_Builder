import { useEffect } from 'react';
import { ping } from '../api/healthApi';

const PING_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Pings /healthz while the tab is visible.
 *
 * The backend sets keepAliveTimeout to 130s and this app is left open all day, often
 * idle between campaign batches. A periodic request keeps the connection and any
 * intermediate proxy from tearing it down, so the next action does not pay for a cold
 * reconnect.
 *
 * Paused while the tab is hidden, and fired immediately on becoming visible again:
 * there is no point keeping a connection warm for a tab nobody is looking at, and
 * returning to it is exactly when warmth matters.
 */
export function useKeepAlive() {
  useEffect(() => {
    let timer = null;
    const controller = new AbortController();

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(() => ping(controller.signal), PING_INTERVAL_MS);
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      ping(controller.signal);
      start();
    };

    if (!document.hidden) {
      ping(controller.signal);
      start();
    }

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      controller.abort();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);
}
