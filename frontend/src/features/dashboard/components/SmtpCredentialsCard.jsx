import { useState } from 'react';

import { FieldGroup, GroupedInput, InputAddon, InputGroup, TextField } from '../../../components/ui/Field';

/**
 * SMTP connection details.
 *
 * The password field carries the most subtlety on this page. Two things are going on:
 *
 *   - It is never restored from browser storage. The plaintext lives encrypted on the
 *     server, and an empty field is how the form asks /send-email to use that stored
 *     credential. The hint says so, because an empty password box on a send form
 *     otherwise looks like an omission.
 *
 *   - `autoComplete="new-password"` here and `"off"` on the user field stop the
 *     browser's password manager treating the pair as a login form. Without them
 *     Chromium fires a trusted input event on load and injects a generated password,
 *     which was then saved as the operator's SMTP credential and submitted — so sending
 *     failed authentication with a password nobody had typed. The gesture tracking in
 *     useCampaignForm is the second half of that defence.
 */
export function SmtpCredentialsCard({
  form,
  setField,
  hasSavedPassword,
  passwordIntent,
  onPasswordIntent,
  onPasswordChange,
  disabled
}) {
  const [revealed, setRevealed] = useState(false);

  const passwordHint = hasSavedPassword
    ? passwordIntent
      ? 'This will replace the password stored on the server.'
      : 'A saved password is stored securely on the server and will be used when you send. Type here to replace it.'
    : 'Stored encrypted on the server as you type, so it is not kept in this browser.';

  return (
    <FieldGroup title="SMTP Credentials" icon="fa-server">
      <TextField
        id="smtp-host"
        label="SMTP Hostname or IP Address"
        placeholder="Enter SMTP Host"
        autoComplete="off"
        value={form.smtpHost}
        onChange={(event) => setField('smtpHost', event.target.value)}
        disabled={disabled}
      />

      <TextField
        id="smtp-port"
        label="SMTP Port"
        placeholder="Enter SMTP Port"
        inputMode="numeric"
        autoComplete="off"
        value={form.smtpPort}
        onChange={(event) => setField('smtpPort', event.target.value)}
        disabled={disabled}
        hint="465 is treated as implicit TLS; anything else uses STARTTLS."
      />

      <TextField
        id="smtp-user"
        label="SMTP User"
        placeholder="Enter SMTP User"
        autoComplete="off"
        value={form.smtpUser}
        onChange={(event) => setField('smtpUser', event.target.value)}
        disabled={disabled}
      />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="smtp-pass" className="text-sm font-semibold text-ink-700">
          SMTP Password
        </label>

        <InputGroup>
          <GroupedInput
            id="smtp-pass"
            type={revealed ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={hasSavedPassword && !passwordIntent ? 'Saved password will be used' : 'Enter SMTP Password'}
            value={form.smtpPass}
            disabled={disabled}
            aria-describedby="smtp-pass-hint"
            // The three events a human produces and the browser's autofill does not.
            // Until one of them fires, changes to this field are ignored.
            onKeyDown={onPasswordIntent}
            onPaste={onPasswordIntent}
            onPointerDown={onPasswordIntent}
            onChange={(event) => onPasswordChange(event.target.value)}
          />
          <InputAddon
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            title={revealed ? 'Hide password' : 'Show password'}
          >
            <i className={revealed ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'} aria-hidden="true" />
          </InputAddon>
        </InputGroup>

        <span id="smtp-pass-hint" className="text-xs text-muted" role="status" aria-live="polite">
          {passwordHint}
        </span>
      </div>
    </FieldGroup>
  );
}
