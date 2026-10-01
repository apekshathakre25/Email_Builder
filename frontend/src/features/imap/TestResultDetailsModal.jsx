import { useState } from 'react';

import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { cn } from '../../lib/cn';
import { capitalise, formatDateTime } from '../../lib/format';

/**
 * Full detail for one inbox-placement test.
 *
 * Two tabs, as before: the parsed fields, and the raw message source. The raw tab is
 * what makes a spam verdict actionable — it is where the receiving provider's
 * Authentication-Results and spam-score headers are, which is the only place that says
 * *why* a message was foldered.
 *
 * The raw source is rendered inside <pre> as text. React escapes it, so unlike the old
 * implementation there is no path by which message content reaches the page as markup.
 */
export function TestResultDetailsModal({ open, onClose, result }) {
  const [tab, setTab] = useState('details');

  if (!result) return null;

  const details = result.emailDetails ?? {};

  const rows = [
    ['Test email', result.testEmail],
    ['Status', null],
    ['Sending IP', result.ipAddress],
    ['Subject', result.subject],
    ['From', details.from ?? result.fromEmail],
    ['Folder', details.folder],
    ['Message-ID', result.messageId],
    ['Sent at', formatDateTime(result.sentAt)],
    ['Checked at', result.checkedAt ? formatDateTime(result.checkedAt) : 'Not checked yet'],
    ['Test type', null],
    ['Test ID', result.testId]
  ];

  return (
    <Modal open={open} onClose={onClose} title="Email test details" titleIcon="fa-envelope-open-text" size="xl">
      <div className="flex flex-col gap-4">
        <div className="flex gap-1 border-b border-line" role="tablist" aria-label="Test detail sections">
          <TabButton active={tab === 'details'} onClick={() => setTab('details')} icon="fa-circle-info" id="tab-details">
            Details
          </TabButton>
          <TabButton active={tab === 'raw'} onClick={() => setTab('raw')} icon="fa-code" id="tab-raw">
            Raw email
          </TabButton>
        </div>

        {tab === 'details' ? (
          <dl
            id="panel-tab-details"
            role="tabpanel"
            aria-labelledby="tab-details"
            className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-[minmax(0,10rem)_1fr]"
          >
            {rows.map(([label, value]) => {
              if (label === 'Status') {
                return (
                  <DetailRow key={label} label={label}>
                    <Badge tone={result.status}>{capitalise(result.status)}</Badge>
                  </DetailRow>
                );
              }

              if (label === 'Test type') {
                return (
                  <DetailRow key={label} label={label}>
                    <Badge tone={result.testType === 'auto' ? 'auto' : 'neutral'} showIcon={false}>
                      {capitalise(result.testType ?? 'manual')}
                    </Badge>
                  </DetailRow>
                );
              }

              if (!value) return null;

              return (
                <DetailRow key={label} label={label}>
                  <span
                    className={cn(
                      'break-all text-base text-ink-800',
                      (label === 'Message-ID' || label === 'Test ID') && 'font-mono text-xs'
                    )}
                  >
                    {value}
                  </span>
                </DetailRow>
              );
            })}

            {details.preview ? (
              <DetailRow label="Preview">
                <p className="whitespace-pre-wrap break-words rounded-md border border-line bg-ink-25 px-3 py-2 text-base text-ink-700">
                  {details.preview}
                </p>
              </DetailRow>
            ) : null}
          </dl>
        ) : (
          <div id="panel-tab-raw" role="tabpanel" aria-labelledby="tab-raw">
            {details.fullRaw ? (
              <pre className="max-h-[55vh] overflow-auto rounded-md bg-ink-900 px-4 py-3 font-mono text-xs leading-relaxed text-ink-100">
                {details.fullRaw}
              </pre>
            ) : (
              <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line-strong bg-ink-25 px-4 py-10 text-center">
                <i className="fa-solid fa-file-circle-question text-2xl text-ink-300" aria-hidden="true" />
                <p className="text-base text-muted">
                  Raw email data is not available. It is captured when a test email is found during
                  a check.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function DetailRow({ label, children }) {
  return (
    <>
      <dt className="text-sm font-semibold text-muted sm:text-right">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function TabButton({ active, onClick, icon, id, children }) {
  return (
    <button
      type="button"
      id={id}
      role="tab"
      aria-selected={active}
      aria-controls={`panel-${id}`}
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 border-b-3 px-4 py-2 text-base font-semibold transition-colors duration-[120ms]',
        active
          ? 'border-b-brand-500 text-brand-700'
          : 'border-b-transparent text-muted hover:text-ink-700'
      )}
    >
      <i className={cn('fa-solid', icon)} aria-hidden="true" />
      {children}
    </button>
  );
}
