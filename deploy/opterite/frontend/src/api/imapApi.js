import { api } from '../lib/apiClient';

/**
 * Inbox-placement testing over IMAP.
 *
 * The flow, end to end:
 *   1. Save one IMAP server record (host / port / ssl) for the operator.
 *   2. Add the mailbox accounts to check, with app passwords (stored encrypted).
 *   3. Send a test campaign with auto-imap-test on. /send-email returns testIds.
 *   4. Check those testIds against the accounts' Inbox and Spam folders.
 *   5. Read the results back and show where each test email landed.
 *
 * Everything is mounted under /imap.
 */

/** @returns {Promise<{success: boolean, credentials: {host: string, port: number, ssl: boolean}|null}>} */
export function getImapCredentials(signal) {
  return api.get('/imap/credentials', { signal });
}

export function saveImapCredentials({ host, port = 993, ssl = true }) {
  return api.post('/imap/credentials', { host, port, ssl });
}

/**
 * The mailbox accounts available for testing.
 *
 * Passwords are never included in this response — `getAccountPassword` fetches one
 * on demand, which is what the reveal button in the accounts table uses.
 *
 * @returns {Promise<{success: boolean, accounts: Array<{_id: string, email: string, addedAt: string}>}>}
 */
export function listEmailAccounts(signal) {
  return api.get('/imap/email-accounts', { signal });
}

/** Upsert by email: adding an address that already exists replaces its password. */
export function addEmailAccount({ email, password }) {
  return api.post('/imap/email-accounts', { email, password });
}

export function deleteEmailAccount(id) {
  return api.delete(`/imap/email-accounts/${encodeURIComponent(id)}`);
}

/**
 * Decrypts and returns one account's app password.
 *
 * Needed because the check endpoint authenticates to IMAP with credentials supplied
 * in the request body, so the browser has to hold the password for the duration of a
 * check. Worth being aware of: this is the one place a stored secret is sent to the
 * browser, and it is why the reveal button exists at all.
 *
 * @returns {Promise<{success: boolean, password: string}>}
 */
export function getAccountPassword(id, signal) {
  return api.get(`/imap/account-password/${encodeURIComponent(id)}`, { signal });
}

/**
 * @typedef {Object} ImapTestResult
 * @property {string} testId
 * @property {'auto'|'manual'} testType
 * @property {string} testEmail
 * @property {string} ipAddress
 * @property {string} subject
 * @property {string} [fromEmail]
 * @property {string} [messageId]
 * @property {'pending'|'inbox'|'spam'|'not_found'} status
 * @property {string} sentAt
 * @property {string} [checkedAt]
 * @property {{folder?: string, from?: string, date?: string, preview?: string, fullRaw?: string}} [emailDetails]
 */

/** @returns {Promise<{success: boolean, results: ImapTestResult[]}>} */
export function listTestResults({ testType, limit = 100 } = {}, signal) {
  return api.get('/imap/test-results', { query: { testType, limit }, signal });
}

export function deleteTestResult(testId) {
  return api.delete(`/imap/test-results/${encodeURIComponent(testId)}`);
}

/**
 * Checks one mailbox for the given test emails and writes the outcome back onto
 * each ImapTestResult.
 *
 * Every test email is searched for in both Inbox and Spam, which is what makes the
 * result meaningful: "inbox" and "spam" are placements, not just presence.
 *
 * @returns {Promise<{success: boolean, checkedCount: number, results: Array<{
 *   testId: string, status: 'inbox'|'spam', folder: string, subject: string,
 *   from: string, date: string, uid: number, messageId: string, preview: string,
 *   fullRaw: string}>}>}
 */
export function checkAutoTest({ host, port = 993, ssl = true, email, password, testIds }) {
  return api.post('/imap/check-auto-test', { host, port, ssl, email, password, testIds });
}

/*
 * Deliberately not wrapped: /imap/check-inbox, /imap/check-spam,
 * /imap/list-mailboxes and /imap/save-manual-test-results.
 *
 * The first three are raw mailbox listings the previous UI referenced only through dead
 * code — `renderSpamMailsMultiple` and friends pointed at a spam-browsing screen that no
 * longer existed. The fourth is unnecessary because /send-email already records the test
 * rows itself. They are all still available on the backend if a diagnostics screen is ever
 * wanted.
 */
