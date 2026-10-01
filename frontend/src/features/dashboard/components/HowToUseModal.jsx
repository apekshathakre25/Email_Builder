import { Modal } from '../../../components/ui/Modal';
import { Callout } from '../../../components/ui/Panel';

/**
 * The "How to Use" reference, ported from the Info popup on the old dashboard.
 *
 * Kept because it documents behaviour that is genuinely not guessable from the form —
 * particularly what Limit means with and without an Interval, and that stopping a
 * campaign leaves the remaining recipients resumable. Rewritten as structured sections
 * rather than the original wall of nested lists, with the semantics unchanged.
 */

const SECTIONS = [
  {
    title: 'Upload recipients',
    icon: 'fa-file-arrow-up',
    body: (
      <>
        Upload a <code>.csv</code>, <code>.txt</code>, <code>.xlsx</code>, <code>.xls</code> or{' '}
        <code>.json</code> file on the <strong>Recipient Files</strong> page. Only valid addresses
        are counted, and every valid entry is kept — including repeats of the same address, because
        a recipient list is a list of sends rather than a set of people. Copy the file's{' '}
        <strong>File ID</strong> into the campaign form, or use <em>Add to campaign</em>.
      </>
    )
  },
  {
    title: 'Configure SMTP',
    icon: 'fa-server',
    body: (
      <>
        Enter the host, port, user and password for the relay that will send. The password is
        stored encrypted on the server, so after the first time you can leave the field empty and
        the saved credential is used. Port 465 is treated as implicit TLS.
      </>
    )
  },
  {
    title: 'Test or Bulk',
    icon: 'fa-flask',
    body: (
      <>
        <strong>Test</strong> sends to the addresses typed into Test Recipients — use it for
        inbox-placement checks. <strong>Bulk</strong> sends to the uploaded files named in File IDs.
        Switching between the two is allowed at any time, and bulk progress is preserved if you
        pause to send a test.
      </>
    )
  },
  {
    title: 'Limit, Interval and Limit to Send',
    icon: 'fa-gauge-high',
    body: (
      <>
        These three are independent and it is worth being precise about them:
        <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5">
          <li>
            <strong>Limit alone</strong> is a batch size. Set it to 25 and one click sends the next
            25 recipients as fast as the relay allows.
          </li>
          <li>
            <strong>Limit with Interval</strong> turns Limit into a rate. "35 per 5 seconds" sends
            every remaining recipient, paced — one click, not one click per batch.
          </li>
          <li>
            <strong>Limit to Send</strong> caps a single Send Email action regardless of the rate.
            It is how you say "35 per 5 seconds, but only 30,000 this time".
          </li>
        </ul>
      </>
    )
  },
  {
    title: 'Custom headers and Message-ID',
    icon: 'fa-code',
    body: (
      <>
        Headers go one per line as <code>Header-Name: value</code>. The Message-ID field accepts
        placeholders — see the <strong>Info</strong> button beside it for the full list.
      </>
    )
  },
  {
    title: 'Sending and stopping',
    icon: 'fa-paper-plane',
    body: (
      <>
        Only one campaign runs per operator at a time; a second tab waits its turn rather than
        sending alongside the first. <strong>Stop Sending</strong> halts the campaign immediately —
        emails already delivered stay delivered, and the remaining recipients stay pending, so you
        can change Limit and Interval and click Send Email to continue where it left off.
      </>
    )
  },
  {
    title: 'Live status',
    icon: 'fa-chart-line',
    body: (
      <>
        <strong>Total</strong> is the whole recipient list. <strong>Queue</strong> is work handed to
        the workers but not yet settled. <strong>Pending</strong> is recipients never attempted.
        <strong> Sent</strong> and <strong>Failed</strong> are outcomes. A paced campaign also shows
        a panel with the countdown to the next interval.
      </>
    )
  },
  {
    title: 'Inbox placement testing',
    icon: 'fa-inbox',
    body: (
      <>
        Add mailbox accounts and your IMAP server on the <strong>IMAP Setup</strong> page, then send
        a test with <strong>Auto IMAP Test</strong> enabled. Each test email is looked for in both
        Inbox and Spam, and the result appears in the Test Results panel.
      </>
    )
  }
];

export function HowToUseModal({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="How to use Opterite" titleIcon="fa-circle-question" size="lg">
      <div className="flex flex-col gap-4">
        <ol className="flex list-none flex-col gap-4 p-0">
          {SECTIONS.map((section, index) => (
            <li key={section.title} className="flex gap-3">
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="mb-1 flex items-center gap-2 text-base font-semibold text-ink-800">
                  <i className={`fa-solid ${section.icon} text-ink-400`} aria-hidden="true" />
                  {section.title}
                </h3>
                <div className="text-base leading-base text-ink-700 [&_code]:rounded-sm [&_code]:bg-surface-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs">
                  {section.body}
                </div>
              </div>
            </li>
          ))}
        </ol>

        <Callout tone="info" icon="fa-circle-info">
          A rate limit or a network hiccup while submitting is not a failed campaign. Anything
          already queued keeps sending — check the counters before resubmitting.
        </Callout>
      </div>
    </Modal>
  );
}
