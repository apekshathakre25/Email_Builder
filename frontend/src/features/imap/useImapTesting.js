import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import * as imapApi from '../../api/imapApi';
import { keys } from '../../lib/queryKeys';

/** Selection rules carried over from the previous implementation. */
export const MAX_SELECTED_ACCOUNTS = 5;

/** Delay before an automatic check, giving the test emails time to arrive. */
const AUTO_CHECK_DELAY_MS = 10_000;

/**
 * IMAP accounts, credentials, test results, and the two check flows.
 *
 * ── Why passwords pass through the browser ───────────────────────────────────
 *
 * /imap/check-auto-test authenticates to IMAP with credentials supplied in the request
 * body, so the browser has to fetch each account's app password and hand it back. That
 * is the server's design, not a choice made here, but it is worth naming: passwords are
 * held in memory for the duration of a check and cached per account so a multi-account
 * check does not re-fetch them. The cache is a plain ref — it dies with the page and is
 * never written to storage.
 *
 * ── Selection rules ──────────────────────────────────────────────────────────
 *
 * At most five accounts, all on the same domain. Same-domain because inbox placement is
 * a property of the receiving provider: mixing Gmail and Outlook in one check produces a
 * result that cannot be attributed to either.
 */
export function useImapTesting({ onNotice } = {}) {
  const queryClient = useQueryClient();

  const [selectedEmails, setSelectedEmails] = useState([]);
  const [isChecking, setIsChecking] = useState(false);
  const passwordCache = useRef(new Map());
  const autoCheckTimer = useRef(null);

  const notice = useCallback((message) => onNotice?.(message), [onNotice]);

  const credentialsQuery = useQuery({
    queryKey: keys.imap.credentials,
    queryFn: ({ signal }) => imapApi.getImapCredentials(signal),
    staleTime: 60_000
  });

  const accountsQuery = useQuery({
    queryKey: keys.imap.accounts,
    queryFn: ({ signal }) => imapApi.listEmailAccounts(signal),
    staleTime: 30_000
  });

  const resultsQuery = useQuery({
    queryKey: keys.imap.testResults({ limit: 100 }),
    queryFn: ({ signal }) => imapApi.listTestResults({ limit: 100 }, signal),
    staleTime: 10_000
  });

  const credentials = credentialsQuery.data?.credentials ?? null;

  // Memoised so the `?? []` fallback does not mint a new array on every render, which would
  // change the identity of every callback below and defeat their memoisation.
  const accounts = useMemo(() => accountsQuery.data?.accounts ?? [], [accountsQuery.data]);
  const results = useMemo(() => resultsQuery.data?.results ?? [], [resultsQuery.data]);

  const invalidateResults = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['imap', 'test-results'] }),
    [queryClient]
  );

  /* ---- Mutations --------------------------------------------------------- */

  const saveCredentials = useMutation({
    mutationFn: imapApi.saveImapCredentials,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.imap.credentials });
      notice('✅ IMAP server settings saved.');
    },
    onError: (err) => notice(`❌ ${err.message}`)
  });

  const addAccount = useMutation({
    mutationFn: imapApi.addEmailAccount,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: keys.imap.accounts });
      notice(`✅ Account ${variables.email} added.`);
    },
    onError: (err) => notice(`❌ ${err.message}`)
  });

  const deleteAccount = useMutation({
    mutationFn: imapApi.deleteEmailAccount,
    onSuccess: (_data, id) => {
      // Drop the cached password with the account, so a re-added address under a new id
      // cannot pick up the old secret.
      passwordCache.current.delete(id);
      queryClient.invalidateQueries({ queryKey: keys.imap.accounts });
      notice('✅ Account deleted.');
    },
    onError: (err) => notice(`❌ ${err.message}`)
  });

  const deleteResult = useMutation({
    mutationFn: imapApi.deleteTestResult,
    onSuccess: () => invalidateResults(),
    onError: (err) => notice(`❌ ${err.message}`)
  });

  /* ---- Selection -------------------------------------------------------- */

  const toggleSelected = useCallback(
    (email) => {
      setSelectedEmails((current) => {
        if (current.includes(email)) return current.filter((item) => item !== email);

        if (current.length >= MAX_SELECTED_ACCOUNTS) {
          notice(`⚠️ At most ${MAX_SELECTED_ACCOUNTS} accounts can be checked at once.`);
          return current;
        }

        if (current.length > 0) {
          const selectedDomain = current[0].split('@')[1];
          const candidateDomain = email.split('@')[1];
          if (selectedDomain !== candidateDomain) {
            notice(`⚠️ Select accounts from the same domain (@${selectedDomain}).`);
            return current;
          }
        }

        return [...current, email];
      });
    },
    [notice]
  );

  const replaceSelection = useCallback((emails) => setSelectedEmails(emails), []);

  /* ---- Password retrieval ----------------------------------------------- */

  const resolvePassword = useCallback(async (accountId) => {
    if (passwordCache.current.has(accountId)) return passwordCache.current.get(accountId);

    const data = await imapApi.getAccountPassword(accountId);
    if (!data?.password) return null;

    passwordCache.current.set(accountId, data.password);
    return data.password;
  }, []);

  /* ---- The check -------------------------------------------------------- */

  /**
   * Checks the given test ids against every selected account.
   *
   * Sequential rather than parallel. The old manual flow fired all accounts at once,
   * which opens one IMAP connection per account simultaneously — providers throttle or
   * refuse that, and the failure surfaces as an authentication error that looks like a
   * wrong password. Sequential is slower and far more reliable, and the results table
   * refreshes after each account so progress is still visible.
   */
  const runCheck = useCallback(
    async (testIds, { label = 'Check' } = {}) => {
      if (!credentials?.host) {
        notice('⚠️ Configure the IMAP server settings first.');
        return { ok: false };
      }
      if (selectedEmails.length === 0) {
        notice('⚠️ Select at least one account to check.');
        return { ok: false };
      }
      if (!testIds || testIds.length === 0) {
        notice('ℹ️ No pending test emails to check. Send a test first.');
        return { ok: false };
      }

      setIsChecking(true);
      notice(`⏳ ${label}: looking for ${testIds.length} test email(s) in ${selectedEmails.length} mailbox(es)…`);

      let found = 0;
      const errors = [];

      try {
        for (const email of selectedEmails) {
          const account = accounts.find((candidate) => candidate.email === email);
          if (!account) {
            errors.push(`${email}: account not found`);
            continue;
          }

          let password;
          try {
            password = await resolvePassword(account._id);
          } catch (err) {
            errors.push(`${email}: ${err.message}`);
            continue;
          }

          if (!password) {
            errors.push(`${email}: could not retrieve the app password`);
            continue;
          }

          try {
            const data = await imapApi.checkAutoTest({
              host: credentials.host,
              port: credentials.port,
              ssl: credentials.ssl,
              email: account.email,
              password,
              testIds
            });

            found += data?.results?.length ?? 0;
          } catch (err) {
            // Worth translating: the provider's raw AUTHENTICATIONFAILED tells an
            // operator nothing about what to do, and for Gmail and Yahoo the answer is
            // almost always an app-specific password.
            const message = /AUTHENTICATIONFAILED/i.test(err.message)
              ? `${email}: authentication failed — check the app password`
              : `${email}: ${err.message}`;
            errors.push(message);
          }

          // After each account, so the table fills in progressively rather than all at
          // the end.
          await invalidateResults();
        }
      } finally {
        setIsChecking(false);
      }

      if (errors.length > 0) {
        notice(`⚠️ ${label} finished with ${errors.length} error(s): ${errors.join('; ')}`);
      } else if (found > 0) {
        notice(`✅ ${label} complete: found and updated ${found} test email(s).`);
      } else {
        notice(`ℹ️ ${label} complete: none of the test emails were found in Inbox or Spam yet.`);
      }

      return { ok: errors.length === 0, found, errors };
    },
    [accounts, credentials, invalidateResults, notice, resolvePassword, selectedEmails]
  );

  /** Checks whatever is still pending. Drives the manual "Check now" button. */
  const checkPending = useCallback(async () => {
    const pending = results.filter((result) => result.status === 'pending');

    if (pending.length === 0) {
      notice('ℹ️ No pending test emails found. Send test emails first.');
      return { ok: false };
    }

    return runCheck(
      pending.map((result) => result.testId),
      { label: 'Manual check' }
    );
  }, [notice, results, runCheck]);

  /**
   * Schedules the automatic check after a test send.
   *
   * The delay exists because a test email has to traverse the relay and the receiving
   * provider before it can be found; checking immediately reliably reports nothing.
   *
   * @param {string[]} testIds  Ids returned by POST /send-email.
   * @param {string[]} recipients Test recipients, used to select the matching accounts.
   */
  const scheduleAutoCheck = useCallback(
    (testIds, recipients) => {
      if (!testIds?.length) return;

      const matched = (recipients ?? []).filter((recipient) =>
        accounts.some((account) => account.email === recipient)
      );

      const missing = (recipients ?? []).filter((recipient) => !matched.includes(recipient));
      if (missing.length > 0) {
        notice(`⚠️ No IMAP account configured for: ${missing.join(', ')}. Those will not be checked.`);
      }

      if (matched.length === 0) {
        notice('⚠️ None of the test recipients have a configured IMAP account, so nothing can be checked.');
        return;
      }

      replaceSelection(matched.slice(0, MAX_SELECTED_ACCOUNTS));
      invalidateResults();

      notice(
        `✅ ${testIds.length} test email(s) logged. Checking IMAP in ${AUTO_CHECK_DELAY_MS / 1000} seconds…`
      );

      if (autoCheckTimer.current) clearTimeout(autoCheckTimer.current);
      autoCheckTimer.current = setTimeout(() => {
        autoCheckTimer.current = null;
        runCheck(testIds, { label: 'Auto check' });
      }, AUTO_CHECK_DELAY_MS);
    },
    [accounts, invalidateResults, notice, replaceSelection, runCheck]
  );

  const cancelAutoCheck = useCallback(() => {
    if (autoCheckTimer.current) {
      clearTimeout(autoCheckTimer.current);
      autoCheckTimer.current = null;
    }
  }, []);

  /**
   * Deletes every test result.
   *
   * A client-side loop because the API has no bulk delete. Failures are counted rather
   * than aborting: one undeletable row must not leave the rest behind.
   */
  const deleteAllResults = useCallback(async () => {
    const all = await imapApi.listTestResults({ limit: 1000 });
    const rows = all?.results ?? [];

    if (rows.length === 0) {
      notice('ℹ️ There are no test results to delete.');
      return { deleted: 0 };
    }

    let deleted = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await imapApi.deleteTestResult(row.testId);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }

    await invalidateResults();

    notice(
      failed > 0
        ? `⚠️ Deleted ${deleted} test result(s); ${failed} could not be deleted.`
        : `✅ Deleted ${deleted} test result(s).`
    );

    return { deleted, failed };
  }, [invalidateResults, notice]);

  return {
    credentials,
    isLoadingCredentials: credentialsQuery.isLoading,
    saveCredentials,

    accounts,
    isLoadingAccounts: accountsQuery.isLoading,
    addAccount,
    deleteAccount,
    resolvePassword,

    results,
    isLoadingResults: resultsQuery.isLoading,
    refreshResults: () => resultsQuery.refetch(),
    deleteResult,
    deleteAllResults,

    selectedEmails,
    toggleSelected,
    replaceSelection,

    isChecking,
    checkPending,
    runCheck,
    scheduleAutoCheck,
    cancelAutoCheck,

    pendingCount: results.filter((result) => result.status === 'pending').length
  };
}
