/**
 * Builds a safe preview document for operator-supplied email HTML.
 *
 * ── The threat, and why two layers ───────────────────────────────────────────
 *
 * The message body is arbitrary HTML the operator pastes in, usually exported from a
 * template builder. Rendering it inside the application page would let it restyle or
 * script the app; rendering it in a frame without care would let it run scripts, phone
 * home, or submit forms.
 *
 * So there are two independent layers, and each would be sufficient on its own:
 *
 *   1. The markup is parsed and stripped here — scripts, every on* handler, and every
 *      executable URL scheme.
 *   2. The frame that displays it ships its own restrictive CSP and a sandbox without
 *      allow-scripts.
 *
 * Belt and braces is warranted because the consequence of a gap is an operator console
 * with SMTP credentials in it being scripted by pasted content.
 *
 * ── What is deliberately preserved ───────────────────────────────────────────
 *
 * The original DOCTYPE. Many email templates are XHTML or quirks-mode, and their
 * layout depends on the rendering mode the DOCTYPE selects — normalising it would make
 * the preview lie about what the recipient will see. For the same reason nothing here
 * reformats, re-encodes or tidies the markup: the exact textarea value is what
 * /send-email posts, so the preview must not show something different.
 */

/** Attributes that can carry a URL, and therefore a `javascript:` payload. */
const URL_ATTRIBUTES = ['href', 'src', 'srcset', 'action', 'formaction', 'background', 'poster', 'xlink:href'];

/** Schemes that execute. `data:text/html` is included because it inherits an origin. */
const DANGEROUS_URL = /^\s*(javascript|vbscript|livescript|data:text\/html)/i;

/**
 * Content Security Policy for the preview frame.
 *
 * `default-src 'none'` then re-allows only what an email needs to look right: images,
 * inline styles and fonts. Scripts, objects, nested frames and form submission are all
 * off, so even markup that survived sanitising cannot do anything.
 *
 * Remote http: and https: images are permitted because email templates legitimately
 * reference assets on the sender's CDN, and a preview full of broken images is not a
 * preview.
 */
const FRAME_CSP = [
  "default-src 'none'",
  'img-src https: http: data:',
  "style-src 'unsafe-inline' https: http: data:",
  'font-src https: http: data:',
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'"
].join('; ');

/** Minimal reset, so the frame does not add margins the recipient will not see. */
const FRAME_RESET = 'html,body{margin:0;padding:0;}body{background:#ffffff;}';

/**
 * Sanitises the markup and returns a complete document string for `srcdoc`.
 *
 * @param {string} html Raw operator input.
 * @returns {string}
 */
export function buildPreviewDocument(html) {
  const source = String(html ?? '');

  // DOMParser has no browsing context: nothing in the parsed markup executes, and no
  // subresource is fetched, during parsing itself.
  const parsed = new DOMParser().parseFromString(source, 'text/html');

  for (const script of parsed.querySelectorAll('script')) script.remove();

  // Inline event handlers survive parsing as ordinary attributes and would execute in a
  // context that allowed scripts. Removed regardless, because the frame's script-free
  // policy is the second layer rather than the only one.
  for (const element of parsed.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
    }

    for (const name of URL_ATTRIBUTES) {
      const value = element.getAttribute?.(name);
      if (value && DANGEROUS_URL.test(value)) element.removeAttribute(name);
    }
  }

  const head = parsed.head ?? parsed.createElement('head');
  if (!parsed.head) parsed.documentElement.prepend(head);

  // Prepended in reverse order so they end up first in the document, ahead of anything
  // the template declared. A CSP meta only governs what follows it.
  const policy = parsed.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', FRAME_CSP);
  head.prepend(policy);

  if (!head.querySelector('meta[charset]')) {
    const charset = parsed.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    head.prepend(charset);
  }

  // Gives relative URLs somewhere to resolve to. Without it they resolve against
  // about:srcdoc and fail.
  if (!head.querySelector('base')) {
    const base = parsed.createElement('base');
    base.setAttribute('href', '/');
    head.append(base);
  }

  const reset = parsed.createElement('style');
  reset.textContent = FRAME_RESET;
  head.append(reset);

  // Round-tripping through DOMParser drops the DOCTYPE, so it is put back verbatim.
  const doctype = parsed.doctype
    ? `<!DOCTYPE ${parsed.doctype.name}` +
      (parsed.doctype.publicId ? ` PUBLIC "${parsed.doctype.publicId}"` : '') +
      (parsed.doctype.systemId
        ? `${parsed.doctype.publicId ? '' : ' SYSTEM'} "${parsed.doctype.systemId}"`
        : '') +
      '>'
    : '';

  return `${doctype}${parsed.documentElement.outerHTML}`;
}

/**
 * Wraps plain-text message content for preview.
 *
 * A Plain-type message is not HTML, so it is escaped and shown monospaced with
 * whitespace preserved — what the recipient's client will render.
 */
export function buildPlainTextPreview(text) {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  return buildPreviewDocument(
    `<pre style="white-space:pre-wrap;word-break:break-word;font-family:monospace;padding:16px;margin:0;">${escaped}</pre>`
  );
}

/**
 * Sandbox attribute for the preview frame.
 *
 * `allow-scripts` is absent, and that absence is the point. `allow-same-origin` without
 * it is safe and lets the frame use a same-origin `base`; the popup permissions only
 * matter if the operator clicks a link in their own template.
 */
export const PREVIEW_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
