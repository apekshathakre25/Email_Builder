import { Link } from 'react-router-dom';

import { ROUTES } from '../../../lib/config';
import {
  Choice,
  ChoiceSet,
  CheckboxField,
  Field,
  FieldGroup,
  FieldRow,
  TextField,
  Textarea
} from '../../../components/ui/Field';
import { Button, ButtonRow } from '../../../components/ui/Button';
import { SearchableSelect } from '../../../components/ui/SearchableSelect';

/**
 * Message content, sender identity, recipients and rate.
 *
 * Every field name here maps to a kebab-case key POST /send-email destructures; the
 * mapping lives in SEND_FIELD_NAMES rather than in this markup, so the form is free to
 * use readable state keys.
 */
export function EmailConfigCard({
  form,
  setField,
  limits,
  validationError,
  isTestMode,
  rateInputsLocked,
  inboxPatterns,
  isLoadingInboxPatterns,
  inboxPatternsError,
  onRetryInboxPatterns,
  autoImapAvailable,
  autoImapChecked,
  autoImapBlockedReason,
  onPreview,
  onMessageIdHelp,
  onHowToUse,
  onSend,
  onStop,
  isSubmitting,
  isStopping,
  canStop,
  laneBanner
}) {
  const fieldError = (field) => (validationError?.field === field ? validationError.error : undefined);

  return (
    <FieldGroup title="Email Configuration" icon="fa-envelope">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="custom-headers" className="text-sm font-semibold text-ink-700">
          Custom Headers (optional)
        </label>
        <Textarea
          id="custom-headers"
          placeholder={'X-Campaign-ID: summer2026\nList-Unsubscribe: <mailto:unsubscribe@example.com>'}
          value={form.customHeaders}
          onChange={(event) => setField('customHeaders', event.target.value)}
          rows={3}
          className="font-mono text-sm"
        />
        <span className="text-xs text-muted">
          One header per line, as <code className="font-mono">Header-Name: value</code>.
        </span>
      </div>

      <Field label="Inbox Pattern" htmlFor="inbox-pattern">
        <SearchableSelect
          id="inbox-pattern"
          value={form.inboxPatternId}
          options={[
            {
              id: '',
              name: 'Default (existing behavior)',
              description: 'Use the existing email generation behavior.'
            },
            ...inboxPatterns
          ]}
          onChange={(value) => setField('inboxPatternId', value)}
          disabled={isLoadingInboxPatterns || Boolean(inboxPatternsError)}
          placeholder={isLoadingInboxPatterns ? 'Loading patterns…' : 'Search Inbox Patterns'}
          aria-describedby="inbox-pattern-status"
        />
        {isLoadingInboxPatterns ? (
          <span id="inbox-pattern-status" className="flex items-center gap-1.5 text-xs text-muted" role="status">
            <i className="fa-solid fa-spinner fa-spin" aria-hidden="true" />
            Loading Inbox Patterns…
          </span>
        ) : inboxPatternsError ? (
          <span id="inbox-pattern-status" className="flex flex-wrap items-center gap-2 text-xs text-danger-600" role="alert">
            Could not load Inbox Patterns. Sending uses Default.
            <Button variant="ghost" size="sm" onClick={onRetryInboxPatterns}>
              Retry
            </Button>
          </span>
        ) : (
          <span id="inbox-pattern-status" className="text-xs text-muted">
            Default keeps the existing email generation behavior.
          </span>
        )}
      </Field>

      <FieldRow min="220px">
        <TextField
          id="smtp-from-email"
          label="From Email"
          placeholder="sender@yourdomain.com"
          autoComplete="off"
          value={form.fromEmail}
          onChange={(event) => setField('fromEmail', event.target.value)}
          hint="Also supplies {{Domain}} in the Message-ID."
        />

        <TextField
          id="smtp-from-name"
          label="From Name"
          placeholder="Enter From Name"
          autoComplete="off"
          value={form.fromName}
          onChange={(event) => setField('fromName', event.target.value)}
        />
      </FieldRow>

      <TextField
        id="subject"
        label="Subject"
        placeholder="Enter Subject"
        autoComplete="off"
        value={form.subject}
        onChange={(event) => setField('subject', event.target.value)}
      />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="test-recp" className="text-sm font-semibold text-ink-700">
          Test Recipients {isTestMode ? '' : '(Test mode only)'}
        </label>
        <Textarea
          id="test-recp"
          placeholder="one@example.com, two@example.com"
          value={form.testRecipients}
          onChange={(event) => setField('testRecipients', event.target.value)}
          // Disabled in Bulk mode, matching the old form. Harmless for submission: the
          // payload is built from state rather than from a FormData snapshot, so a
          // disabled control does not silently drop its value.
          disabled={!isTestMode}
          rows={2}
          aria-invalid={fieldError('testRecipients') ? true : undefined}
        />
        {fieldError('testRecipients') ? (
          <span className="text-xs text-danger-600" role="alert">
            {fieldError('testRecipients')}
          </span>
        ) : (
          <span className="text-xs text-muted">Separate addresses with commas, semicolons or new lines.</span>
        )}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <ChoiceSet legend="Bulk or test">
          <Choice
            id="mode-bulk"
            name="test-bulk"
            value="Bulk"
            checked={form.testBulk === 'Bulk'}
            onChange={() => setField('testBulk', 'Bulk')}
            label="Bulk"
          />
          <Choice
            id="mode-test"
            name="test-bulk"
            value="Test"
            checked={form.testBulk === 'Test'}
            onChange={() => setField('testBulk', 'Test')}
            label="Test"
          />
        </ChoiceSet>

        <CheckboxField
          id="auto-imap-test"
          label="Auto IMAP Test"
          icon="fa-robot"
          // The effective value, not the raw field: the box must never show armed while the
          // gate below has made it inert.
          checked={autoImapChecked}
          onChange={(event) => setField('autoImapTest', event.target.checked)}
          disabled={!autoImapAvailable}
          hint={autoImapBlockedReason}
        />
      </div>

      <ChoiceSet legend="Message Type">
        <Choice
          id="type-plain"
          name="plain-html"
          value="Plain"
          checked={form.messageType === 'Plain'}
          onChange={() => setField('messageType', 'Plain')}
          label="Plain"
        />
        <Choice
          id="type-html"
          name="plain-html"
          value="HTML"
          checked={form.messageType === 'HTML'}
          onChange={() => setField('messageType', 'HTML')}
          label="HTML"
        />
      </ChoiceSet>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="message" className="text-sm font-semibold text-ink-700">
          Message / HTML
        </label>
        <Textarea
          id="message"
          placeholder="Enter the message body"
          value={form.message}
          onChange={(event) => setField('message', event.target.value)}
          rows={8}
          className={form.messageType === 'HTML' ? 'font-mono text-sm' : undefined}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="file-ids" className="text-sm font-semibold text-ink-700">
          File IDs {isTestMode ? '' : '(required for Bulk)'}
        </label>
        <TextField
          id="file-ids"
          placeholder="e.g. 4f3c2a1b-…, 9d8e7f6a-…"
          autoComplete="off"
          value={form.fileIds}
          onChange={(event) => setField('fileIds', event.target.value)}
          error={fieldError('fileIds')}
          hint={
            <>
              Comma-separated. The first id identifies the campaign.{' '}
              <Link to={ROUTES.fileManager} className="font-semibold">
                Manage recipient files
              </Link>
            </>
          }
        />
      </div>

      <TextField
        id="custom-message-id"
        label="Custom Message-ID (optional)"
        placeholder="<[[timestamp]]-[[bigchar(6)]]-[[num(6)]]@{{Domain}}>"
        autoComplete="off"
        value={form.customMessageId}
        onChange={(event) => setField('customMessageId', event.target.value)}
        className="[&_input]:font-mono [&_input]:text-sm"
        labelAction={
          <Button variant="ghost" size="sm" icon="fa-circle-info" onClick={onMessageIdHelp}>
            Placeholders
          </Button>
        }
      />

      <FieldRow min="150px">
        <TextField
          id="limit"
          label="Limit"
          type="number"
          inputMode="numeric"
          min={limits.rateLimit.min}
          max={limits.rateLimit.max}
          step={1}
          placeholder="e.g. 35"
          value={form.limit}
          onChange={(event) => setField('limit', event.target.value)}
          error={fieldError('limit')}
          hint="Emails per interval, or batch size when no interval is set."
          // readOnly, emphatically not disabled. The old form built its payload from a
          // FormData snapshot, where a disabled input is omitted entirely — so locking
          // these with `disabled` posted an empty `interval-seconds`, and an absent
          // interval is precisely how the server is told "no rate limit". That would have
          // silently converted the next batch of a paced campaign into an unpaced one
          // sending every remaining recipient as fast as SMTP allowed. This payload is
          // built from state so it is no longer load-bearing, but readOnly remains the
          // honest expression of "visible, submitted, not editable".
          readOnly={rateInputsLocked}
          aria-readonly={rateInputsLocked}
          title={
            rateInputsLocked
              ? 'Stop sending to change the rate. The running campaign already has this rate applied.'
              : undefined
          }
        />

        <TextField
          id="limit-to-send"
          label="Limit to Send"
          type="number"
          inputMode="numeric"
          min={limits.limitToSend.min}
          max={limits.limitToSend.max}
          step={1}
          placeholder="e.g. 30000"
          value={form.limitToSend}
          onChange={(event) => setField('limitToSend', event.target.value)}
          error={fieldError('limitToSend')}
          hint="Cap for this Send Email action. Empty means no cap."
        />

        <TextField
          id="interval-seconds"
          label="Interval (seconds)"
          type="number"
          inputMode="decimal"
          min={limits.rateIntervalSeconds.min}
          max={limits.rateIntervalSeconds.max}
          step="any"
          placeholder="e.g. 5"
          value={form.intervalSeconds}
          onChange={(event) => setField('intervalSeconds', event.target.value)}
          hint="Time window for the limit. Empty means unpaced."
          readOnly={rateInputsLocked}
          aria-readonly={rateInputsLocked}
          title={
            rateInputsLocked
              ? 'Stop sending to change the rate. The running campaign already has this rate applied.'
              : undefined
          }
        />
      </FieldRow>

      {laneBanner}

      <ButtonRow className="pt-1">
        <Button
          variant="primary"
          icon="fa-paper-plane"
          onClick={onSend}
          loading={isSubmitting}
          loadingLabel="Submitting…"
        >
          Send Email
        </Button>

        {/* One of two entry points to the same stop operation; the other is in the
            interval panel. Both post /stop-sending. Hidden until there is a campaign to
            stop, because that is the whole window in which stopping means anything. */}
        {canStop ? (
          <Button
            variant="danger"
            icon="fa-circle-stop"
            onClick={onStop}
            loading={isStopping}
            loadingLabel="Stopping…"
          >
            Stop Sending
          </Button>
        ) : null}

        <Button variant="secondary" icon="fa-eye" onClick={onPreview}>
          Preview message
        </Button>

        <Button variant="secondary" icon="fa-circle-question" onClick={onHowToUse}>
          How to use
        </Button>
      </ButtonRow>
    </FieldGroup>
  );
}
