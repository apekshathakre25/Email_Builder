import { Modal } from '../../../components/ui/Modal';
import { Callout } from '../../../components/ui/Panel';

/**
 * Reference for the Custom Message-ID placeholder syntax.
 *
 * Content ported from message-id-help.js. These tokens are implemented in
 * backend/utils/messageIdGenerator.js on the server, so this list is documentation of a real
 * grammar rather than a suggestion — a typo'd token is emitted literally into the
 * Message-ID header.
 */

const GROUPS = [
  {
    title: 'Characters',
    icon: 'fa-font',
    tone: 'brand',
    items: [
      ['[[bigchar(X)]]', 'X uppercase letters — ABCDEF'],
      ['[[smallchar(X)]]', 'X lowercase letters — abcdef'],
      ['[[mixsmallbigchar(X)]]', 'X mixed-case letters — aBcDeF']
    ]
  },
  {
    title: 'Alphanumeric',
    icon: 'fa-hashtag',
    tone: 'accent',
    items: [
      ['[[num(X)]]', 'X digits — 123456'],
      ['[[hexdigit(X)]]', 'X hex digits — 1a2b3c'],
      ['[[mixsmallalphanum(X)]]', 'X lowercase letters and digits — a1b2c3'],
      ['[[mixbigalphanum(X)]]', 'X uppercase letters and digits — A1B2C3'],
      ['[[mixall(X)]]', 'X mixed-case letters and digits — aB1cD2']
    ]
  },
  {
    title: 'Date & time',
    icon: 'fa-clock',
    tone: 'info',
    items: [
      ['[[timestamp]]', 'Unix timestamp in seconds'],
      ['<?=time()?>', 'Unix timestamp — PHP-style alias'],
      ['[[RFC_Date_UTC()]]', 'RFC 2822 date in UTC'],
      ['[[RFC_Date_IST()]]', 'RFC 2822 date in IST']
    ]
  },
  {
    title: 'Special',
    icon: 'fa-wand-magic-sparkles',
    tone: 'success',
    items: [
      ['[[ascii2hex(text)]]', 'Hex encoding of the given text'],
      ['{{Domain}}', "The sending domain, taken from the From Email address"]
    ]
  }
];

const TONE_STYLES = {
  brand: 'border-brand-200 bg-brand-50',
  accent: 'border-accent-500/25 bg-accent-50',
  info: 'border-info-500/25 bg-info-50',
  success: 'border-success-500/25 bg-success-50'
};

export function MessageIdHelpModal({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="Message-ID placeholders" titleIcon="fa-circle-info" size="lg">
      <div className="flex flex-col gap-4">
        <p className="text-base text-muted">
          Build a unique Message-ID for every email. Placeholders are replaced at send time;
          anything else in the field is used literally.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title} className={`rounded-lg border p-3 ${TONE_STYLES[group.tone]}`}>
              <h3 className="mb-2 flex items-center gap-2 text-base font-semibold text-ink-800">
                <i className={`fa-solid ${group.icon}`} aria-hidden="true" />
                {group.title}
              </h3>
              <dl className="flex flex-col gap-1.5">
                {group.items.map(([token, description]) => (
                  <div key={token} className="flex flex-col gap-0.5">
                    <dt>
                      <code className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-xs text-ink-800">
                        {token}
                      </code>
                    </dt>
                    <dd className="text-xs text-muted">{description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <Callout tone="brand" icon="fa-lightbulb">
          <p className="mb-1.5 font-semibold text-ink-800">Quick examples</p>
          <ul className="flex list-none flex-col gap-1 p-0">
            <li>
              <code className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-xs">
                &lt;[[timestamp]]-[[bigchar(6)]]-[[num(6)]]@{'{{Domain}}'}&gt;
              </code>
            </li>
            <li>
              <code className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-xs">
                &lt;[[mixall(24)]]@{'{{Domain}}'}&gt;
              </code>
            </li>
          </ul>
        </Callout>

        <Callout tone="warning" icon="fa-triangle-exclamation">
          <p className="font-semibold text-ink-800">Keep it well-formed</p>
          <p className="text-base">
            A Message-ID must be globally unique and wrapped in angle brackets, with a domain
            after the <code className="font-mono text-xs">@</code>. Reusing an ID across emails
            causes clients to thread or discard them, and a malformed header is a common reason
            for spam-foldering. Leave the field empty to let the server generate one.
          </p>
        </Callout>
      </div>
    </Modal>
  );
}
