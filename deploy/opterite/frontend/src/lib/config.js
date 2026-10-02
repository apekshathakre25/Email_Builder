/**
 * Runtime configuration derived from the build-time environment.
 */

/**
 * Origin of the Node/Express API, without a trailing slash.
 *
 * An empty string is meaningful rather than a misconfiguration: it makes every
 * request same-origin, which is what a deployment serving this bundle and the API
 * behind one reverse proxy wants. Only a separate-origin deployment needs a value.
 */
export const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '');

/**
 * Where the browser is sent to begin Google OAuth.
 *
 * A full page navigation, not a fetch: OAuth is a top-level redirect flow, so the
 * browser has to leave the app. The backend's /auth/google/callback finishes by
 * redirecting back here, which is why the backend needs FRONTEND_URL set.
 */
export const GOOGLE_LOGIN_URL = `${API_BASE_URL}/auth/google`;

/**
 * Client-side routes. Collected here so no component hardcodes a path string and
 * so the set is visible in one place when adding a page.
 *
 * These are SPA-owned routes. The backend exposes data and auth endpoints only;
 * it does not render or serve interface pages.
 */
export const ROUTES = {
  login: '/login',
  dashboard: '/',
  fileManager: '/file-manager',
  imapAccounts: '/imap-accounts'
};
