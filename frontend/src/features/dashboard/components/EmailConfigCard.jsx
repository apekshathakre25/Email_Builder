import { Link } from 'react-router-dom';

import { ROUTES } from '../../../lib/config';
import {
  CheckboxField,
  Field,
  FieldGroup,
  FieldRow,
  Select,
  TextField,
  Textarea
} from '../../../components/ui/Field';
import { Button, ButtonRow } from '../../../components/ui/Button';
import { SearchableSelect } from '../../../components/ui/SearchableSelect';
import { CONTENT_TRANSFER_ENCODING_OPTIONS } from '../contentTransferEncoding';

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
  onPreview,
  onMessageIdHelp,
  onHowToUse,
  onSend,
  onStop,
  isSubmitting,
  isStopping,
  canStop,
  laneBanner,
  onOpenTestResults
}) {
  const fieldError = (field) => (validationError?.field === field ? validationError.error : undefined);

  return (
    <FieldGroup
      title="Email Configuration"
      icon="fa-envelope"
      legendAction={
        <Button
          variant="ghost"
          size="icon"
          icon="fa-chart-bar"
          onClick={onOpenTestResults}
          title="Open Test Results"
          aria-label="Open Test Results"
        />
      }
    >
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
          aria-describedby={isLoadingInboxPatterns || inboxPatternsError ? 'inbox-pattern-status' : undefined}
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
        ) : null}
      </Field>

      <TextField
        id="smtp-from-email"
        label="From Email"
        placeholder="sender@yourdomain.com"
        autoComplete="off"
        value={form.fromEmail}
        onChange={(event) => setField('fromEmail', event.target.value)}
      />

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          id="subject"
          label="Subject"
          className="min-w-0"
          placeholder="Enter Subject"
          autoComplete="off"
          value={form.subject}
          onChange={(event) => setField('subject', event.target.value)}
        />

        <TextField
          id="smtp-from-name"
          label="From Name"
          className="min-w-0"
          placeholder="Enter From Name"
          autoComplete="off"
          value={form.fromName}
          onChange={(event) => setField('fromName', event.target.value)}
        />
      </div>

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
        ) : null}
      </div>

      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <Field className="w-full min-w-0 sm:w-[170px]" label="Bulk or Test" htmlFor="test-bulk">
          <Select
            id="test-bulk"
            className="min-w-0"
            value={form.testBulk}
            onChange={(event) => setField('testBulk', event.target.value)}
          >
            <option value="Bulk">Bulk</option>
            <option value="Test">Test</option>
          </Select>
        </Field>

        <Field className="w-full min-w-0 sm:w-[170px]" label="Message Type" htmlFor="message-type">
          <Select
            id="message-type"
            className="min-w-0"
            value={form.messageType}
            onChange={(event) => setField('messageType', event.target.value)}
          >
            <option value="">Select message type</option>
            <option value="Plain">Plain</option>
            <option value="HTML">HTML</option>
          </Select>
        </Field>

        <Field className="w-full min-w-0 sm:w-[220px]" label="Content Transfer Encoding" htmlFor="content-transfer-encoding">
          <Select
            id="content-transfer-encoding"
            className="min-w-0"
            value={form.contentTransferEncoding}
            onChange={(event) => setField('contentTransferEncoding', event.target.value)}
          >
            {CONTENT_TRANSFER_ENCODING_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex w-full items-center sm:mb-2.5 sm:w-auto">
          <CheckboxField
            id="auto-imap-test"
            label="Auto IMAP Test"
            // The effective value, not the raw field: the box must never show armed while the
            // gate below has made it inert.
            checked={autoImapChecked}
            onChange={(event) => setField('autoImapTest', event.target.checked)}
            disabled={!autoImapAvailable}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="message" className="text-sm font-semibold text-ink-700">
          Message / HTML
        </label>
        <Textarea
          id="message"
          placeholder="Enter the message body"
          value={form.message}
          onChange={(event) => setField('message', event.target.value)}
          rows={4}
          className={form.messageType === 'HTML' ? 'font-mono text-sm' : undefined}
        />
      </div>

      <FieldRow min="220px">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-h-10 min-w-0 items-center gap-1.5">
            <label htmlFor="file-ids" className="min-w-0 text-sm font-semibold text-ink-700">
              File IDs {isTestMode ? '' : '(required for Bulk)'}
            </label>
            <Link
              to={ROUTES.fileManager}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-brand-600 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-200"
              title="Manage recipient files"
              aria-label="Manage recipient files"
            >
              <i className="fa-solid fa-folder" aria-hidden="true" />
            </Link>
          </div>
          <TextField
            id="file-ids"
            className="min-w-0"
            placeholder="e.g. 4f3c2a1b-…, 9d8e7f6a-…"
            autoComplete="off"
            value={form.fileIds}
            onChange={(event) => setField('fileIds', event.target.value)}
            error={fieldError('fileIds')}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-h-10 min-w-0 items-center gap-1.5">
            <label htmlFor="custom-message-id" className="min-w-0 text-sm font-semibold text-ink-700">
              Custom Message-ID (optional)
            </label>
            <Button
              variant="ghost"
              size="icon"
              icon="fa-circle-info"
              onClick={onMessageIdHelp}
              title="Placeholders"
              aria-label="Placeholders"
              className="shrink-0"
            />
          </div>
          <TextField
            id="custom-message-id"
            className="min-w-0 [&_input]:font-mono [&_input]:text-sm"
            placeholder="<[[timestamp]]-[[bigchar(6)]]-[[num(6)]]@{{Domain}}>"
            autoComplete="off"
            value={form.customMessageId}
            onChange={(event) => setField('customMessageId', event.target.value)}
          />
        </div>
      </FieldRow>

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
