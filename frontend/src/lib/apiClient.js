import { API_BASE_URL } from './config';

/**
 * The single HTTP boundary between this app and the Express API.
 *
 * Three decisions here are load-bearing, and each exists because of something
 * specific in the backend:
 *
 * 1. `credentials: 'include'` on every request.
 *    Auth is one httpOnly cookie (`auth_token`, backend/config/cookies.js). The browser
 *    will not attach it to a cross-origin request, nor store it from a
 *    cross-origin Set-Cookie, without this — so omitting it makes login appear to
 *    succeed and every subsequent call come back unauthenticated.
 *
 * 2. `Accept: application/json` on every request.
 *    backend/middleware/auth.js answers an expired session with `res.redirect('/')`
 *    unless the path starts with /api, or the request looks like XHR, or Accept
 *    mentions JSON. `fetch` sends `Accept: * / *` by default, follows the 302, and
 *    hands back the login page's HTML with status 200 — a dead session would look
 *    like a successful request returning nonsense. This header is what makes the
 *    backend return `401 {success:false,message,redirect}` instead.
 *
 * 3. Errors become a single ApiError shape.
 *    The API reports failure as `{error}`, `{message}`, `{success:false,error}` or
 *    `{success:false,code,error,message,retryAfterSeconds}` depending on the
 *    route, and some failures are not JSON at all (a proxy's HTML 413, the EJS
 *    404). Normalising once here means no caller has to know which variant a
 *    given endpoint uses.
 */

/** Normalised failure. Every rejection from this module is one of these. */
export class ApiError extends Error {
  constructor(message, { status = 0, code = null, payload = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** Rate limited by one of the buckets in backend/middleware/rateLimit.js. */
  get isRateLimited() {
    return this.status === 429 || this.code === 'RATE_LIMITED';
  }

  /** Session gone. The app should return to the login screen. */
  get isUnauthorized() {
    return this.status === 401 || this.status === 403;
  }

  /**
   * The request never reached the server, or the response was unintelligible.
   *
   * Worth distinguishing because a campaign submission that fails this way may
   * well have been accepted — the old UI was careful never to call such a request
   * a failed campaign, and neither should this one.
   */
  get isNetworkError() {
    return this.status === 0;
  }
}

/**
 * Listeners notified when the API reports the session is gone.
 *
 * A callback registry rather than an import of the auth store, because the auth
 * store consumes this module; importing it back would be circular.
 */
const unauthorizedListeners = new Set();

export function onUnauthorized(listener) {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function notifyUnauthorized() {
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch (err) {
      console.error('[api] unauthorized listener threw', err);
    }
  }
}

function buildUrl(path, query) {
  const base = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

  if (!query) return base;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // Absent is not the same as empty: omitting a key lets the server apply its
    // default, whereas `?sortBy=` would override it with an empty string.
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }

  const queryString = params.toString();
  return queryString ? `${base}?${queryString}` : base;
}

function isJsonResponse(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('application/json');
}

/**
 * Reads a body without assuming it is JSON.
 *
 * The assumption is wrong often enough to matter: a 413 may come from the reverse
 * proxy as an HTML error page, and an unmatched path renders backend/views/404.ejs. Calling
 * .json() on either throws a SyntaxError that surfaces as "Unexpected token '<'",
 * which reads like a bug in this app rather than a rejection from the server.
 */
async function readBody(response) {
  if (response.status === 204 || response.status === 205) return null;

  if (isJsonResponse(response)) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  try {
    const text = await response.text();
    return text ? { _raw: text } : null;
  } catch {
    return null;
  }
}

/**
 * Picks the most useful human-readable message out of a failure body.
 *
 * Never returns raw non-JSON text: a proxy error page can name the server
 * software and version, and there is nothing in it an operator can act on.
 */
function messageFromPayload(payload, response) {
  if (payload && typeof payload === 'object' && !payload._raw) {
    const candidate = payload.error || payload.message || payload.reason;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  if (response.status === 413) {
    return 'File is too large for the current upload limit. Please use a smaller file.';
  }

  if (response.status === 401 || response.status === 403) {
    return 'Your session has expired. Please sign in again.';
  }

  if (response.status === 404) {
    return 'Not found.';
  }

  if (response.status >= 500) {
    return `The server returned HTTP ${response.status}. Please try again.`;
  }

  return `Request failed with HTTP ${response.status}.`;
}

/**
 * Serialises a request body and reports the Content-Type it needs.
 *
 * `FormData` is passed through untouched so the browser can generate the
 * multipart boundary; setting Content-Type by hand there produces a body multer
 * cannot parse. `URLSearchParams` is how the campaign form posts, matching what
 * the old frontend sent to /send-email.
 */
function prepareBody(body) {
  if (body === undefined || body === null) return { body: undefined, contentType: null };

  if (body instanceof FormData) return { body, contentType: null };
  if (body instanceof URLSearchParams) {
    return { body, contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
  }
  if (typeof body === 'string') return { body, contentType: 'text/plain;charset=UTF-8' };

  return { body: JSON.stringify(body), contentType: 'application/json' };
}

/**
 * Performs one request and returns the parsed JSON body.
 *
 * @param {string} path            Path on the API, e.g. '/status'.
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.query] Appended as a query string; empty values dropped.
 * @param {*}      [options.body]  Object (JSON), URLSearchParams, FormData or string.
 * @param {object} [options.headers]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.notifyOnUnauthorized=true] Set false for endpoints
 *   where a 401 is an expected answer rather than a lost session, so probing does
 *   not itself trigger a logout.
 */
export async function request(path, options = {}) {
  const {
    method = 'GET',
    query,
    body,
    headers = {},
    signal,
    notifyOnUnauthorized = true
  } = options;

  const prepared = prepareBody(body);

  const requestHeaders = {
    // See note 2 in the module comment — this is not cosmetic.
    Accept: 'application/json',
    // Belt and braces for the same problem: backend/middleware/auth.js also treats
    // req.xhr as a JSON client, and some proxies strip Accept.
    'X-Requested-With': 'XMLHttpRequest',
    ...(prepared.contentType ? { 'Content-Type': prepared.contentType } : {}),
    ...headers
  };

  let response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      credentials: 'include',
      headers: requestHeaders,
      body: prepared.body,
      signal
    });
  } catch (err) {
    // An abort is the caller's own doing (component unmounted, query cancelled).
    // Re-thrown untouched so React Query and AbortController consumers can
    // recognise it instead of seeing it as a server problem.
    if (err?.name === 'AbortError') throw err;

    throw new ApiError(
      `Could not reach the server (${err?.message || 'network error'}).`,
      { status: 0 }
    );
  }

  const payload = await readBody(response);

  if (!response.ok) {
    if (response.status === 401 && notifyOnUnauthorized) notifyUnauthorized();

    throw new ApiError(messageFromPayload(payload, response), {
      status: response.status,
      code: payload?.code ?? null,
      payload,
      retryAfterSeconds:
        Number(payload?.retryAfterSeconds) ||
        Number(response.headers.get('Retry-After')) ||
        null
    });
  }

  return payload;
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' })
};

/** Pulls the filename out of a Content-Disposition header. */
function filenameFromDisposition(disposition) {
  if (!disposition) return '';

  // RFC 5987 form first — it carries the encoded, authoritative name.
  const encoded = /filename\*=(?:UTF-8'')?([^;\n]*)/i.exec(disposition);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].replace(/['"]/g, ''));
    } catch {
      /* fall through to the plain form */
    }
  }

  const plain = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i.exec(disposition);
  return plain?.[1] ? plain[1].replace(/['"]/g, '').trim() : '';
}

/**
 * Downloads a file and hands it to the browser's save flow.
 *
 * Fetched rather than linked to with an <a href> because these endpoints are
 * authenticated and, in a separate-origin deployment, a plain navigation would not
 * carry the cookie. Going through fetch also means a failure arrives as an
 * ApiError that can be shown in the UI, instead of the browser replacing the app
 * with a JSON error body.
 *
 * Reading the filename from Content-Disposition depends on that header being in
 * the backend's CORS `exposedHeaders` — response headers are otherwise invisible
 * to cross-origin JavaScript, and the fallback name would silently take over.
 */
export async function downloadFile(path, { query, fallbackFilename = 'download' } = {}) {
  let response;
  try {
    response = await fetch(buildUrl(path, query), {
      method: 'GET',
      credentials: 'include',
      // Not Accept: application/json here — these routes answer with text/csv or
      // a binary attachment. The XHR header still steers backend/middleware/auth.js to a
      // 401 rather than a redirect.
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
  } catch (err) {
    throw new ApiError(`Could not reach the server (${err?.message || 'network error'}).`, {
      status: 0
    });
  }

  if (!response.ok) {
    const payload = await readBody(response);
    if (response.status === 401) notifyUnauthorized();
    throw new ApiError(messageFromPayload(payload, response), {
      status: response.status,
      code: payload?.code ?? null,
      payload
    });
  }

  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get('Content-Disposition')) || fallbackFilename;

  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Deferred: revoking synchronously can cancel the download in Safari before
    // it has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return { filename, size: blob.size };
}
