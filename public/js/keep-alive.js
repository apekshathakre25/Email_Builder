/**
 * Keeps the Render instance warm while a tab is open.
 *
 * Render idles the service out after a period with no inbound requests, so the
 * next visitor pays a cold start. Polling /healthz on an interval avoids that
 * for as long as somebody has the app open.
 */
(function () {
  'use strict';

  var INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  var timerId = null;

  function ping() {
    // cache: 'no-store' matters as much as the server's Cache-Control header —
    // a response served from cache never reaches the instance and wouldn't
    // reset its idle timer.
    fetch('/healthz', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .catch(function () {
        // A failed ping is not worth surfacing to the user. The next tick
        // retries, and a genuinely down server is visible elsewhere in the UI.
      });
  }

  function start() {
    if (timerId !== null) return;
    timerId = setInterval(ping, INTERVAL_MS);
  }

  function stop() {
    if (timerId === null) return;
    clearInterval(timerId);
    timerId = null;
  }

  // Browsers throttle timers in background tabs, so an interval alone drifts or
  // stalls when the tab is hidden. Pausing while hidden and pinging immediately
  // on return keeps the behaviour predictable instead of relying on that timer
  // still firing.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stop();
    } else {
      ping();
      start();
    }
  });

  if (!document.hidden) {
    ping();
    start();
  }
})();
