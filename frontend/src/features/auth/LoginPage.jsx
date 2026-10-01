import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { sendOtp } from '../../api/authApi';
import { GOOGLE_LOGIN_URL, ROUTES } from '../../lib/config';
import { cn } from '../../lib/cn';
import { useAppConfig } from '../../providers/AppConfigProvider';
import { useAuth } from '../../providers/AuthProvider';
import { Button } from '../../components/ui/Button';
import { Select, TextField } from '../../components/ui/Field';

/**
 * Sign-in.
 *
 * Two routes in, both ending at the same cookie:
 *   OTP    — a six-digit code emailed to an authorized address. Entirely in-app.
 *   Google — a full page navigation, because OAuth is a top-level redirect flow.
 *
 * The account dropdown is preserved from the old login page, which listed every
 * authorized address. It comes from /api/app-config now instead of an EJS local. If
 * that request failed the field degrades to a free-text email input, so a config
 * problem does not lock everyone out.
 */

/** Messages for the ?error= values backend/routes/auth.js redirects back with. */
const OAUTH_ERRORS = {
  unauthorized:
    '🚫 Access denied: your email is not authorized to access this system. Please contact your administrator if you believe this is an error.',
  auth_failed: '❌ Authentication failed: an error occurred during login. Please try again.',
  no_email: '⚠️ No email found: could not retrieve your email from Google. Please try again.'
};

export function LoginPage() {
  const appConfig = useAppConfig();
  const { login, isLoggingIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const otpInputRef = useRef(null);

  /**
   * The OAuth failure carried back in ?error=, captured before the parameter is scrubbed.
   *
   * Read in the state initialiser rather than an effect so the message is on screen in the
   * first render — an effect would show the page, then the error, which reads as a second
   * failure. The scrub below is a separate concern: it stops the message reappearing on
   * every reload and outliving a subsequent successful attempt.
   */
  const [alert, setAlert] = useState(() => {
    const code = new URLSearchParams(window.location.search).get('error');
    if (!code) return null;
    return {
      tone: 'error',
      message: OAUTH_ERRORS[code] ?? '⚠️ An error occurred during login. Please try again.'
    };
  });

  const authorizedUsers = appConfig.authorizedUsers ?? [];
  const hasAccountList = authorizedUsers.length > 0;

  // Removes ?error= from the URL. Updating history is an external-system effect and sets no
  // state of its own.
  useEffect(() => {
    if (!searchParams.has('error')) return;

    const next = new URLSearchParams(searchParams);
    next.delete('error');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const otpMutation = useMutation({
    mutationFn: sendOtp,
    onSuccess: () => {
      setAlert({ tone: 'success', message: '✅ OTP sent. Check your email — it is valid for 5 minutes.' });
      otpInputRef.current?.focus();
    },
    onError: (err) => setAlert({ tone: 'error', message: `❌ ${err.message}` })
  });

  const canRequestOtp = useMemo(() => email.trim().length > 0, [email]);

  function handleRequestOtp() {
    if (!canRequestOtp) {
      setAlert({ tone: 'error', message: '⚠️ Please select your account first.' });
      return;
    }
    setAlert(null);
    otpMutation.mutate(email.trim());
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (!email.trim()) {
      setAlert({ tone: 'error', message: '⚠️ Please select your account first.' });
      return;
    }
    if (!otp.trim()) {
      setAlert({ tone: 'error', message: '⚠️ Please enter the OTP sent to your email.' });
      return;
    }

    setAlert(null);

    try {
      await login({ email: email.trim(), otp: otp.trim() });
      navigate(ROUTES.dashboard, { replace: true });
    } catch (err) {
      // The server's message is the useful one here: it counts down remaining
      // attempts and distinguishes an expired code from a wrong one.
      setAlert({ tone: 'error', message: `❌ ${err.message}` });
      setOtp('');
      otpInputRef.current?.focus();
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-sunken px-4 py-10">
      {/* Decorative background wash, replacing the two mouse-parallax blobs on the old
          page. Static on purpose: the parallax tracked every mousemove on a screen
          whose only job is to accept six digits. */}
      <div
        className="pointer-events-none absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-brand-200/40 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-40 -right-24 h-[32rem] w-[32rem] rounded-full bg-accent-500/15 blur-3xl"
        aria-hidden="true"
      />

      <div className="relative w-full max-w-[26rem]">
        <div className="rounded-xl border border-line bg-surface p-6 shadow-lg sm:p-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <img src="/logo.svg" alt="" className="h-14 w-14 rounded-full border border-line shadow-sm" />
            <h1 className="text-xl font-bold tracking-tight text-ink-900">Welcome to Opterite</h1>
            <p className="text-base text-muted">
              Select your account and enter the one-time password, or continue with Google. Only
              authorized personnel can access this system.
            </p>
          </div>

          {alert ? (
            <div
              role="alert"
              className={cn(
                'mt-5 flex items-start gap-2 rounded-md border px-3 py-2.5 text-base',
                alert.tone === 'success'
                  ? 'border-success-500/40 bg-success-50 text-success-600'
                  : 'border-danger-500/40 bg-danger-50 text-danger-600'
              )}
            >
              <i
                className={cn(
                  'fa-solid mt-0.5 shrink-0',
                  alert.tone === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'
                )}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">{alert.message}</span>
              <button
                type="button"
                onClick={() => setAlert(null)}
                aria-label="Dismiss message"
                className="shrink-0 opacity-70 hover:opacity-100"
              >
                <i className="fa-solid fa-xmark" aria-hidden="true" />
              </button>
            </div>
          ) : null}

          <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit}>
            {hasAccountList ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="login-email" className="flex items-center gap-2 text-sm font-semibold text-ink-700">
                  <i className="fa-solid fa-user-circle text-brand-500" aria-hidden="true" />
                  Authorized personnel
                </label>
                <Select
                  id="login-email"
                  value={email}
                  required
                  onChange={(event) => {
                    setEmail(event.target.value);
                    // Matches the old page: choosing an account moves straight to the
                    // field the operator has to fill in next.
                    otpInputRef.current?.focus();
                  }}
                >
                  <option value="" disabled>
                    Choose an account…
                  </option>
                  {authorizedUsers.map((user) => (
                    <option key={user.email} value={user.email}>
                      {user.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : (
              <TextField
                id="login-email"
                label="Email address"
                type="email"
                autoComplete="username"
                placeholder="you@example.com"
                value={email}
                required
                onChange={(event) => setEmail(event.target.value)}
                hint="The account list could not be loaded, so enter your authorized address."
              />
            )}

            <TextField
              ref={otpInputRef}
              id="login-otp"
              label="One-time password"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="Enter 6-digit OTP"
              value={otp}
              required
              // Digits only, so a pasted code with stray spaces or a hyphen still works.
              onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))}
              className="[&_input]:tracking-[0.3em]"
            />

            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                icon="fa-paper-plane"
                onClick={handleRequestOtp}
                loading={otpMutation.isPending}
                loadingLabel="Sending…"
                disabled={!canRequestOtp}
                block
              >
                Send OTP
              </Button>

              <Button
                type="submit"
                variant="primary"
                icon="fa-right-to-bracket"
                loading={isLoggingIn}
                loadingLabel="Verifying…"
                block
              >
                Sign in with OTP
              </Button>
            </div>
          </form>

          {appConfig.auth?.googleEnabled ? (
            <>
              <div className="my-5 flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-line" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">or</span>
                <span className="h-px flex-1 bg-line" />
              </div>

              {/* A real link, not a fetch: OAuth needs a top-level navigation so the
                  browser can follow the redirect chain to Google and back. */}
              <a
                href={GOOGLE_LOGIN_URL}
                className={cn(
                  'flex w-full items-center justify-center gap-2.5 rounded-md border border-line-strong',
                  'bg-surface px-3.5 py-2 text-base font-semibold text-ink-700 no-underline',
                  'transition-colors duration-[120ms] ease-standard hover:bg-ink-50'
                )}
              >
                <GoogleMark />
                Continue with Google
              </a>
            </>
          ) : null}
        </div>

        <p className="mt-5 text-center text-xs text-muted">
          © {new Date().getFullYear()} Opterite. All rights reserved.
        </p>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.34A9 9 0 0 0 9 18Z"
      />
      <path fill="#FBBC05" d="M3.97 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.09l3.01-2.34Z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
