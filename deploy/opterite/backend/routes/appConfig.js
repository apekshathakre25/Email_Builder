/**
 * Bootstrap configuration for the React frontend.
 *
 * ── Why this route exists ────────────────────────────────────────────────────
 *
 * These are server-owned values that the SPA needs at runtime:
 *
 *   authorizedUsers   builds the account selector on the login page
 *   maxUploadBytes    preflights the file size before upload
 *   google.enabled    decides whether the Google button is worth showing
 *
 * They are configuration owned by the server, so a copy in the bundle would go
 * stale at the next deploy and, in the case of maxUploadBytes, would disagree
 * with multer.
 *
 * The validation bounds are here for the same reason. public/js/recipents-upload.js
 * kept its own copies of LIMIT_MIN/LIMIT_MAX, INTERVAL_SECONDS_MIN/MAX and
 * LIMIT_TO_SEND_MIN/MAX with a comment admitting they were duplicated and would
 * drift. They are exported by the modules that enforce them, so serving them
 * removes the duplication rather than moving it into React.
 *
 * ── Why it is unauthenticated ────────────────────────────────────────────────
 *
 * The login page needs `authorizedUsers` before anyone is authenticated, which
 * is exactly the position GET / was already in: the rendered login HTML listed
 * every authorized address to any anonymous visitor. This endpoint therefore
 * exposes nothing new — it is the same data over the same trust boundary. It is
 * still worth reviewing as a product decision, since it enumerates operator
 * email addresses; replacing the dropdown with a plain email input would let
 * `authorizedUsers` move behind auth. Until that decision is made, parity is the
 * safer default.
 *
 * Nothing secret is served: no API keys, no SMTP or IMAP credentials, no JWT
 * secret, no Mongo or Redis URL. Only what the browser already had.
 */

const express = require('express');
const router = express.Router();

const env = require('../config/env');
const {
  LIMIT_MIN,
  LIMIT_MAX,
  INTERVAL_SECONDS_MIN,
  INTERVAL_SECONDS_MAX
} = require('../utils/emailRateLimiter');
const { LIMIT_TO_SEND_MIN, LIMIT_TO_SEND_MAX } = require('./sendemails');

// The payload is derived entirely from validated configuration, so it is built
// once at load rather than per request. Changing any of it requires a restart,
// which is already true of every value it contains.
const APP_CONFIG = Object.freeze({
  appName: env.appName,

  // Only email + display name are exposed to the login page.
  authorizedUsers: env.authorizedUsers.map(({ email, name }) => ({ email, name })),

  auth: {
    googleEnabled: env.google.enabled
  },

  uploads: {
    maxUploadBytes: env.maxUploadBytes,
    maxRequestBodyBytes: env.maxRequestBodyBytes,
    // Mirrors ALLOWED_UPLOAD_EXTENSIONS in routes/sendemails.js. Served so the
    // file picker's accept attribute and the server's fileFilter cannot disagree.
    allowedExtensions: ['.csv', '.txt', '.xlsx', '.xls', '.json']
  },

  // Bounds the SPA validates against for a fast local error. The server still
  // re-checks every value, so a drift shows up as a 400 rather than as an
  // accepted bad value — but with these served there is nothing left to drift.
  limits: {
    rateLimit: { min: LIMIT_MIN, max: LIMIT_MAX },
    rateIntervalSeconds: { min: INTERVAL_SECONDS_MIN, max: INTERVAL_SECONDS_MAX },
    limitToSend: { min: LIMIT_TO_SEND_MIN, max: LIMIT_TO_SEND_MAX }
  }
});

router.get('/api/app-config', (req, res) => {
  // Safe to cache briefly in the browser: it cannot change without a restart,
  // and the SPA fetches it on every cold load.
  res.set('Cache-Control', 'public, max-age=60');
  res.json(APP_CONFIG);
});

module.exports = router;
module.exports.APP_CONFIG = APP_CONFIG;
