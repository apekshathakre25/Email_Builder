(function () {
  'use strict';

  var INTERVAL_MS = 5 * 60 * 1000;
  var timerId = null;

  function ping() {

    fetch('/healthz', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
      .catch(function () {

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
