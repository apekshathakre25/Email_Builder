/**
 * Session cookie attributes, shared by every place that sets or clears the
 * auth cookie.
 *
 * Kept in one module because clearCookie() only removes a cookie when the
 * attributes it is given match those it was set with. Divergent copies leave a
 * stale cookie behind that the browser will not overwrite, so logout silently
 * fails to log the user out.
 */

const env = require('./env');

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const AUTH_COOKIE_NAME = 'auth_token';

const COOKIE_OPTIONS = {
  httpOnly: true,             // not readable from JavaScript
  secure: env.cookieSecure,   // HTTPS-only in production, off for local HTTP
  sameSite: 'strict',         // not sent on cross-site requests → blocks CSRF
  maxAge: SESSION_MAX_AGE_MS,
  path: '/'
};

/** Same attributes minus maxAge, which clearCookie supplies itself. */
const CLEAR_COOKIE_OPTIONS = {
  httpOnly: COOKIE_OPTIONS.httpOnly,
  secure: COOKIE_OPTIONS.secure,
  sameSite: COOKIE_OPTIONS.sameSite,
  path: COOKIE_OPTIONS.path
};

module.exports = {
  AUTH_COOKIE_NAME,
  COOKIE_OPTIONS,
  CLEAR_COOKIE_OPTIONS,
  SESSION_MAX_AGE_MS
};
