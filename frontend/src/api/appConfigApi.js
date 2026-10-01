import { api } from '../lib/apiClient';

/**
 * Server-owned configuration the UI needs before it can render anything useful:
 * the authorized-user list for the login dropdown, the upload size limit for the
 * file picker's preflight, and the validation bounds for Limit / Interval /
 * Limit to Send.
 *
 * Fetched rather than bundled because every one of these is an environment
 * variable an operator can change without a frontend deploy. Hardcoding
 * maxUploadBytes in particular would let the browser's preflight disagree with
 * multer, which presents as a file being accepted locally and then rejected.
 *
 * @typedef {Object} AppConfig
 * @property {string} appName
 * @property {Array<{email: string, name: string}>} authorizedUsers
 * @property {{googleEnabled: boolean}} auth
 * @property {{maxUploadBytes: number, maxRequestBodyBytes: number, allowedExtensions: string[]}} uploads
 * @property {{rateLimit: {min: number, max: number}, rateIntervalSeconds: {min: number, max: number}, limitToSend: {min: number, max: number}}} limits
 */

/**
 * Values used when /api/app-config cannot be reached.
 *
 * Present so a failed config fetch degrades the UI rather than blanking it: the
 * login page still renders (with a free-text email field instead of a dropdown)
 * and validation still has bounds to check against. They mirror the server's own
 * defaults, and the server re-validates everything regardless, so the worst case
 * is a locally-permitted value being rejected with a 400.
 */
export const FALLBACK_APP_CONFIG = Object.freeze({
  appName: 'Opterite',
  authorizedUsers: [],
  auth: { googleEnabled: false },
  uploads: {
    maxUploadBytes: 25 * 1024 * 1024,
    maxRequestBodyBytes: 10 * 1024 * 1024,
    allowedExtensions: ['.csv', '.txt', '.xlsx', '.xls', '.json']
  },
  limits: {
    rateLimit: { min: 1, max: 1_000_000 },
    rateIntervalSeconds: { min: 0.1, max: 3600 },
    limitToSend: { min: 1, max: 10_000_000 }
  }
});

/** @returns {Promise<AppConfig>} */
export function getAppConfig(signal) {
  return api.get('/api/app-config', { signal, notifyOnUnauthorized: false });
}
