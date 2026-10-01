import { api } from '../lib/apiClient';

/**
 * Authentication. Two ways in: an OTP emailed to an authorized address, or Google
 * OAuth. Both end with the same httpOnly `auth_token` cookie, so from this app's
 * point of view the only difference is that Google leaves the page.
 */

/**
 * Probes the session.
 *
 * Always answers 200 with `{authenticated:false}` rather than 401, which is what
 * makes it usable as a probe — `notifyOnUnauthorized:false` is belt and braces in
 * case that ever changes, so checking the session can never itself trigger the
 * app's logout handling.
 *
 * @returns {Promise<{authenticated: boolean, user?: {email: string, name: string}}>}
 */
export function checkAuth(signal) {
  return api.get('/check-auth', { signal, notifyOnUnauthorized: false });
}

/**
 * Requests an OTP for an authorized address.
 *
 * Rate limited to 5 per 15 minutes, keyed on the email rather than the IP, so
 * repeated requests for one account cannot be worked around by changing network.
 */
export function sendOtp(email) {
  return api.post('/send-otp', { email }, { notifyOnUnauthorized: false });
}

/**
 * Exchanges an OTP for the session cookie. 10 attempts per 15 minutes.
 *
 * @returns {Promise<{success: boolean, message: string, user: {email: string, name: string}}>}
 */
export function login({ email, otp }) {
  return api.post('/login', { email, otp }, { notifyOnUnauthorized: false });
}

/**
 * Clears the session cookie.
 *
 * Mounted ahead of the auth middleware on the server, so it succeeds even when the
 * cookie is already invalid — which is exactly when it is most needed.
 */
export function logout() {
  return api.post('/logout', undefined, { notifyOnUnauthorized: false });
}
