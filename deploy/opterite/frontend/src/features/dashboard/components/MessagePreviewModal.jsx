import { useMemo } from 'react';

import { Modal } from '../../../components/ui/Modal';
import { buildPlainTextPreview, buildPreviewDocument, PREVIEW_SANDBOX } from '../htmlPreview';

/**
 * Shows the message body as the recipient will see it.
 *
 * Rendered into a sandboxed iframe via `srcdoc` rather than injected into the page, so
 * email HTML and application CSS cannot affect each other in either direction. The frame
 * scrolls internally, which is what lets a wide desktop email layout scroll horizontally
 * instead of being squeezed to the modal width.
 *
 * The message is read unmodified. /send-email posts the exact textarea value, so a
 * preview that normalised or re-encoded anything would be showing a different email from
 * the one that goes out.
 */
export function MessagePreviewModal({ open, onClose, message, messageType, inboxPatternName }) {
  const isHtml = messageType === 'HTML';

  const document = useMemo(() => {
    if (!open) return '';
    return isHtml ? buildPreviewDocument(message) : buildPlainTextPreview(message);
  }, [open, isHtml, message]);

  const isEmpty = !String(message ?? '').trim();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Message preview"
      titleIcon="fa-eye"
      size="xl"
      bodyClassName="p-0"
    >
      <div className="flex flex-col gap-3 p-4">
        <p className="flex items-center gap-2 text-xs text-muted">
          <i className="fa-solid fa-shield-halved" aria-hidden="true" />
          Rendered in a sandboxed frame with scripts disabled.{' '}
          {isHtml ? 'Showing as HTML.' : 'Showing as plain text.'}
          {!messageType ? ' No message type is selected yet — defaulting to plain text.' : ''}
        </p>

        <p className="flex items-center gap-2 text-xs text-muted">
          <i className="fa-solid fa-layer-group" aria-hidden="true" />
          Inbox Pattern: <strong className="font-semibold text-ink-700">{inboxPatternName}</strong>
        </p>

        {isEmpty ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line-strong bg-ink-25 px-4 py-12 text-center">
            <i className="fa-solid fa-envelope-open text-2xl text-ink-300" aria-hidden="true" />
            <p className="text-base text-muted">The message body is empty.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-line bg-white shadow-xs">
            <iframe
              title="Email message preview"
              srcDoc={document}
              // No allow-scripts. That omission is the security boundary, alongside the
              // frame's own CSP injected by buildPreviewDocument().
              sandbox={PREVIEW_SANDBOX}
              referrerPolicy="no-referrer"
              className="block h-[70vh] w-full border-0 bg-white"
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
