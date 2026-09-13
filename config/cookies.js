const env = require('./env');

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const AUTH_COOKIE_NAME = 'auth_token';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: 'strict',
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
