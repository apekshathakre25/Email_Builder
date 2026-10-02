const env = require('./env');

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const AUTH_COOKIE_NAME = 'auth_token';

// sameSite is configuration rather than a literal because the frontend now runs
// on its own origin. 'strict' remains the default and is still correct whenever
// the SPA and this API share a registrable domain; only a genuinely cross-site
// SPA needs 'none'. See parseCookieSameSite in config/env.js.
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: env.cookieSameSite,
  maxAge: SESSION_MAX_AGE_MS,
  path: '/'
};

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
