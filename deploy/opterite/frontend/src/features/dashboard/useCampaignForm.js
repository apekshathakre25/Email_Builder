import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getEmailConfig, saveSmtpPassword } from '../../api/campaignApi';
import { getInboxPatterns } from '../../api/patternsApi';
import { keys } from '../../lib/queryKeys';
import { useAuth } from '../../providers/AuthProvider';
import {
  consumePendingFileIds,
  EMPTY_CAMPAIGN_FORM,
  readPersistedCampaignForm,
  writePersistedCampaignForm
} from './campaignFormStorage';

const AUTOSAVE_DEBOUNCE_MS = 250;

/**
 * Builds form state from the saved draft plus any File IDs handed over from the file
 * manager.
 *
 * Pulled out of the component so the initial mount and a later change of operator produce
 * state the same way, rather than one path being the real implementation and the other a
 * partial copy of it.
 */
function buildForm(userEmail, pendingFileIds) {
  const next = { ...EMPTY_CAMPAIGN_FORM, ...(readPersistedCampaignForm(userEmail) ?? {}) };

  if (pendingFileIds.length > 0) {
    const existing = String(next.fileIds ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    const merged = [...existing];
    for (const id of pendingFileIds) {
      if (!merged.includes(id)) merged.push(id);
    }

    next.fileIds = merged.join(',');
    // File IDs are only used by a bulk campaign, so arriving with one implies the mode.
    next.testBulk = 'Bulk';
  }

  return next;
}

/**
 * Campaign form state, its per-tab draft, and the server-side SMTP password.
 *
 * Three concerns are deliberately in one hook because they are coupled through one
 * field. The SMTP password is the only part of this form that is *not* a draft: it
 * lives encrypted on the server, keyed to the operator, and the form's job is to
 * either leave it alone or replace it. Splitting that out would mean two hooks racing
 * to decide what an empty password box means.
 *
 * ── The autofill problem this hook exists to solve ───────────────────────────
 *
 * Chromium treats the SMTP user/password pair as a login form and, on page load,
 * fires a trusted focus/input/change sequence on the password field with a generated
 * password. That value was then saved as the operator's SMTP credential and submitted
 * to /send-email — so sending failed authentication with a password nobody had typed,
 * and the saved credential had been silently overwritten.
 *
 * The defence is to distinguish a human from the browser. `passwordIntent` only
 * becomes true after a real gesture on the field (keydown, paste, pointerdown).
 * Without intent, changes are ignored and `discardUngesturedPassword()` blanks the
 * field before submit — which restores the meaning of an empty field ("use the saved
 * credential") rather than losing anything.
 */
export function useCampaignForm() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userEmail = user?.email ?? '';

  /**
   * File IDs queued by the file manager.
   *
   * Read once, into state rather than a ref, because it is consumed during render and
   * reading a ref there is exactly the pattern that makes a component miss an update.
   * The storage slot is cleared by the read, so this is the only copy.
   */
  const [pendingFileIds] = useState(consumePendingFileIds);

  /**
   * Restored synchronously in the initialiser, not in an effect.
   *
   * The mode radio decides which live-status panel renders and whether Test Recipients is
   * enabled, so restoring it a tick later would flash the wrong panel on every reload.
   */
  const [form, setForm] = useState(() => buildForm(userEmail, pendingFileIds));

  const [passwordIntent, setPasswordIntent] = useState(false);
  const passwordIntentRef = useRef(false);

  /**
   * Re-reads the draft when the operator becomes known, or changes.
   *
   * `user` is null on the first render while /check-auth is in flight, so the initialiser
   * above runs with an empty email and finds nothing; this is what actually loads the
   * draft in the normal case.
   *
   * Done during render with a previous-value guard — React's documented way to adjust
   * state in response to a changed input — rather than in an effect. An effect would
   * render once with the wrong mode, then again with the right one, which is the flash
   * this is trying to avoid.
   */
  const [loadedFor, setLoadedFor] = useState(userEmail);

  if (userEmail !== loadedFor) {
    setLoadedFor(userEmail);
    setForm(buildForm(userEmail, pendingFileIds));
  }

  /** Whether a password is already stored server-side for this operator. */
  const emailConfigQuery = useQuery({
    queryKey: keys.emailConfig,
    queryFn: ({ signal }) => getEmailConfig(signal),
    enabled: Boolean(userEmail),
    staleTime: 30_000
  });

  const inboxPatternsQuery = useQuery({
    queryKey: keys.inboxPatterns,
    queryFn: ({ signal }) => getInboxPatterns(signal),
    enabled: Boolean(userEmail),
    staleTime: 60_000
  });

  const inboxPatterns = useMemo(
    () => (Array.isArray(inboxPatternsQuery.data?.patterns) ? inboxPatternsQuery.data.patterns : []),
    [inboxPatternsQuery.data]
  );

  // A draft may be hand-edited or may name a profile removed from the catalog. Keep
  // that raw value only long enough for a successful catalog load to validate it;
  // every UI and submission consumer receives either a current backend-issued ID or
  // Default (the empty string).
  const effectiveInboxPatternId = inboxPatterns.some(
    (pattern) => pattern.id === form.inboxPatternId
  )
    ? form.inboxPatternId
    : '';
  const effectiveForm = useMemo(
    () => ({ ...form, inboxPatternId: effectiveInboxPatternId }),
    [form, effectiveInboxPatternId]
  );

  const hasSavedPassword = Boolean(emailConfigQuery.data?.hasSmtpPass);

  const savePasswordMutation = useMutation({
    mutationFn: (value) => saveSmtpPassword(value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.emailConfig })
  });

  /* ---- Draft autosave ---------------------------------------------------- */

  const draftTimer = useRef(null);

  /**
   * Latest form state, for callbacks that fire outside render — the pagehide flush and the
   * pre-submit flush. Assigned in an effect rather than during render, so nothing reads a
   * ref while rendering.
   */
  const latestForm = useRef(form);

  useEffect(() => {
    latestForm.current = form;
  }, [form]);

  const flushDraft = useCallback(() => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    if (!userEmail) return;
    writePersistedCampaignForm(userEmail, latestForm.current);
  }, [userEmail]);

  useEffect(() => {
    if (!userEmail) return undefined;

    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      writePersistedCampaignForm(userEmail, form);
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [form, userEmail]);

  /**
   * Commits keystrokes still inside the debounce window when the page goes away.
   *
   * `pagehide` rather than `beforeunload`: it fires for the back/forward cache too,
   * which `beforeunload` does not, and it does not suppress the cache.
   */
  useEffect(() => {
    const handlePageHide = () => flushDraft();
    const handleVisibility = () => {
      if (document.hidden) flushDraft();
    };

    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [flushDraft]);

  /* ---- Password autosave ------------------------------------------------- */

  const passwordTimer = useRef(null);
  const pendingPassword = useRef(null);

  const flushPassword = useCallback(
    ({ keepalive = false } = {}) => {
      if (passwordTimer.current) {
        clearTimeout(passwordTimer.current);
        passwordTimer.current = null;
      }

      const value = pendingPassword.current;
      if (value === null) return;
      pendingPassword.current = null;

      if (keepalive) {
        // The page is unloading: a normal fetch would be cancelled in flight.
        saveSmtpPassword(value, { keepalive: true });
        return;
      }

      savePasswordMutation.mutate(value);
    },
    [savePasswordMutation]
  );

  useEffect(() => {
    const handlePageHide = () => flushPassword({ keepalive: true });
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, [flushPassword]);

  /* ---- Public setters ---------------------------------------------------- */

  const setField = useCallback((name, value) => {
    setForm((current) => (current[name] === value ? current : { ...current, [name]: value }));
  }, []);

  /**
   * Records that a human touched the password field.
   *
   * Called from keydown, paste and pointerdown — events the browser's own autofill
   * does not produce. Once set it stays set for the life of the page: having typed
   * once, the operator's later edits are all intentional.
   */
  const registerPasswordIntent = useCallback(() => {
    if (passwordIntentRef.current) return;
    passwordIntentRef.current = true;
    setPasswordIntent(true);
  }, []);

  /**
   * Handles a change to the password field.
   *
   * Ignored entirely without intent, which is what stops an autofilled value being
   * both stored on the server and submitted with the next campaign.
   */
  const setPassword = useCallback(
    (value) => {
      if (!passwordIntentRef.current) return;

      setForm((current) => ({ ...current, smtpPass: value }));

      // Debounced so the server sees one write per pause, not one per keystroke.
      pendingPassword.current = value;
      if (passwordTimer.current) clearTimeout(passwordTimer.current);
      passwordTimer.current = setTimeout(() => {
        passwordTimer.current = null;
        const pending = pendingPassword.current;
        pendingPassword.current = null;
        // '' is meaningful: it clears the stored credential.
        if (pending !== null) savePasswordMutation.mutate(pending);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [savePasswordMutation]
  );

  /**
   * Blanks a password the browser filled in on its own.
   *
   * Called immediately before building the submission. /send-email prefers a
   * submitted password over the stored one, so leaving an autofilled value in place
   * would authenticate with a string the operator never chose.
   */
  const discardUngesturedPassword = useCallback(() => {
    if (passwordIntentRef.current) return false;

    let discarded = false;
    setForm((current) => {
      if (!current.smtpPass) return current;
      discarded = true;
      return { ...current, smtpPass: '' };
    });
    return discarded;
  }, []);

  const resetForm = useCallback(() => {
    setForm({ ...EMPTY_CAMPAIGN_FORM });
    passwordIntentRef.current = false;
    setPasswordIntent(false);
  }, []);

  /**
   * The campaign id for the current form state.
   *
   * Bulk campaigns are identified by their first file id — which is also the
   * recipient file's sessionId — so the same value identifies the file, the campaign,
   * the Redis keys and the lane slot. Test sends have no file, so they get a
   * timestamped id minted at submit time instead, and this is null for them.
   */
  const campaignId = useMemo(() => {
    if (form.testBulk === 'Test') return null;
    const [first] = String(form.fileIds ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    return first ?? null;
  }, [form.testBulk, form.fileIds]);

  return {
    form: effectiveForm,
    setField,
    setForm,
    resetForm,

    inboxPatterns,
    isLoadingInboxPatterns:
      inboxPatternsQuery.isLoading || (inboxPatternsQuery.isFetching && !inboxPatternsQuery.data),
    inboxPatternsError: inboxPatternsQuery.error,
    refetchInboxPatterns: inboxPatternsQuery.refetch,
    hasPendingInboxPatternSelection:
      Boolean(form.inboxPatternId) && !inboxPatternsQuery.data,

    campaignId,
    isTestMode: form.testBulk === 'Test',

    hasSavedPassword,
    isCheckingSavedPassword: emailConfigQuery.isLoading,
    passwordIntent,
    registerPasswordIntent,
    setPassword,
    discardUngesturedPassword,
    flushPassword,

    flushDraft
  };
}
