/**
 * HTML email preview renderer.
 *
 * The Message/HTML textarea holds a complete email document: DOCTYPE, <html>
 * with MSO/XML namespaces, <head> with <meta> and <style>, Outlook conditional
 * comments, table-based layouts and remote <img> sources. Dropping that into
 * `element.innerHTML` cannot work: the fragment parser throws away the
 * doctype/html/head/body wrappers, the email's <style> rules escape into the
 * application's own page, and the application's stylesheet bleeds back into the
 * email layout.
 *
 * So the preview is rendered inside a sandboxed iframe instead. This module
 * only builds the document for that frame. It never mutates the source string,
 * so the HTML that /send-email posts is byte-for-byte what the user pasted.
 */
(function (global) {
  'use strict';

  /**
   * Policy for the preview document itself.
   *
   * A srcdoc frame inherits the embedding page's CSP, so this is intersected
   * with the application policy in app.js rather than replacing it. Its job is
   * to be strictly tighter than the app policy: remote images and inline CSS
   * are the only capabilities an email preview needs, and scripts are removed
   * outright.
   */
  var FRAME_CSP = [
    "default-src 'none'",
    'img-src https: http: data:',
    "style-src 'unsafe-inline' https: http: data:",
    'font-src https: http: data:',
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'"
  ].join('; ');

  /**
   * Only resets the UA's default body margin so the email sits flush in the
   * frame. Injected before the email's own <head> content so that anything the
   * template declares wins on equal specificity.
   */
  var FRAME_RESET_CSS = 'html,body{margin:0;padding:0;}body{background:#ffffff;}';

  var URL_ATTRIBUTES = [
    'href',
    'src',
    'srcset',
    'action',
    'formaction',
    'background',
    'poster',
    'xlink:href'
  ];

  /** Schemes that can execute code if the frame is ever granted scripting. */
  var EXECUTABLE_SCHEME = /^\s*(?:javascript|vbscript|livescript|data:text\/html)/i;

  function looksLikeFullDocument(source) {
    return /<html[\s>]/i.test(source) || /<!doctype\s/i.test(source);
  }

  /**
   * Removes the ways pasted markup could run code.
   *
   * The frame is sandboxed without `allow-scripts` and its CSP says
   * `script-src 'none'`, so this is the third layer rather than the only one.
   * It is deliberately surgical: <script> elements, event-handler attributes and
   * executable URL schemes. Everything an email actually needs, including
   * conditional comments, <style>, <table>/<td>/<th>, inline `style`, `bgcolor`,
   * `background` and image sources, is left exactly as authored.
   */
  function removeScriptableContent(doc) {
    var scripts = doc.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i += 1) {
      scripts[i].parentNode.removeChild(scripts[i]);
    }

    var elements = doc.querySelectorAll('*');
    for (var e = 0; e < elements.length; e += 1) {
      var element = elements[e];
      var attributes = element.attributes;

      // Iterate backwards: removeAttributeNode mutates this live collection.
      for (var a = attributes.length - 1; a >= 0; a -= 1) {
        var attribute = attributes[a];
        var name = attribute.name.toLowerCase();

        if (name.indexOf('on') === 0) {
          element.removeAttribute(attribute.name);
          continue;
        }

        if (URL_ATTRIBUTES.indexOf(name) !== -1 && EXECUTABLE_SCHEME.test(attribute.value)) {
          element.removeAttribute(attribute.name);
        }
      }
    }
  }

  /**
   * Prepends the preview's own head nodes without disturbing the email's.
   *
   * `<base>` matters for templates that use relative image paths: a srcdoc frame
   * resolves them against the embedding page's URL (/interface), so a bare
   * `images/logo.png` would resolve to /images/logo.png only by accident of the
   * current path. Pinning the base to the site root matches how express.static
   * serves /public, and is skipped when the template supplies its own <base>.
   */
  function injectPreviewHead(doc) {
    var head = doc.head;
    if (!head) {
      head = doc.createElement('head');
      doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
    }

    var prelude = doc.createDocumentFragment();

    var csp = doc.createElement('meta');
    csp.setAttribute('http-equiv', 'Content-Security-Policy');
    csp.setAttribute('content', FRAME_CSP);
    prelude.appendChild(csp);

    if (!head.querySelector('meta[charset]')) {
      var charset = doc.createElement('meta');
      charset.setAttribute('charset', 'utf-8');
      prelude.appendChild(charset);
    }

    if (!head.querySelector('base')) {
      var base = doc.createElement('base');
      base.setAttribute('href', '/');
      prelude.appendChild(base);
    }

    var reset = doc.createElement('style');
    reset.textContent = FRAME_RESET_CSS;
    prelude.appendChild(reset);

    head.insertBefore(prelude, head.firstChild);
  }

  /**
   * Reproduces the original DOCTYPE rather than forcing HTML5, because the
   * XHTML 1.0 Transitional doctype most email templates carry decides whether
   * the frame renders in standards or quirks mode.
   */
  function serializeDoctype(doctype) {
    if (!doctype) return '<!DOCTYPE html>';

    var out = '<!DOCTYPE ' + doctype.name;
    if (doctype.publicId) {
      out += ' PUBLIC "' + doctype.publicId + '"';
      if (doctype.systemId) out += ' "' + doctype.systemId + '"';
    } else if (doctype.systemId) {
      out += ' SYSTEM "' + doctype.systemId + '"';
    }
    return out + '>';
  }

  /**
   * Builds the document for the preview frame from raw editor content.
   *
   * @param {string} rawHtml Exact textarea value. Not modified.
   * @returns {string} Document suitable for iframe.srcdoc.
   */
  function buildPreviewDocument(rawHtml) {
    var source = typeof rawHtml === 'string' ? rawHtml : '';

    // A fragment (no <html>) still needs a document shell so the head nodes
    // below have somewhere to live.
    var input = looksLikeFullDocument(source)
      ? source
      : '<!DOCTYPE html><html><head></head><body>' + source + '</body></html>';

    // DOMParser has no browsing context: nothing loads and nothing executes
    // while we work on the tree. It also keeps comments, so the MSO
    // conditionals survive intact.
    var doc = new DOMParser().parseFromString(input, 'text/html');
    if (!doc || !doc.documentElement) return input;

    removeScriptableContent(doc);
    injectPreviewHead(doc);

    return serializeDoctype(doc.doctype) + '\n' + doc.documentElement.outerHTML;
  }

  /**
   * Creates the frame that renders a preview document.
   *
   * The sandbox deliberately omits `allow-scripts`. That, not the markup
   * filtering above, is what actually guarantees no inline script, event
   * handler or `javascript:` URL from the pasted email can execute.
   *
   * `allow-same-origin` is present because without it the frame gets an opaque
   * origin, and helmet serves this application's own assets with
   * `Cross-Origin-Resource-Policy: same-origin`. An opaque origin is same-origin
   * with nothing, so any image the template loads from this host would be
   * rejected before it left the browser. Granting it is safe here precisely
   * because `allow-scripts` is absent: with no scripting there is no way to act
   * on same-origin privileges, and it is the `allow-scripts` +
   * `allow-same-origin` pair that would defeat the sandbox.
   */
  function createPreviewFrame(previewDocument, options) {
    var settings = options || {};

    var frame = document.createElement('iframe');
    frame.title = settings.title || 'Email HTML preview';
    frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.display = 'block';
    frame.style.width = '100%';
    frame.style.height = settings.height || '70vh';
    frame.style.border = '0';
    frame.style.background = '#ffffff';
    frame.srcdoc = previewDocument;

    return frame;
  }

  /**
   * Renders raw editor HTML into `container` as an isolated preview.
   *
   * @param {HTMLElement} container Element to render into. Emptied first.
   * @param {string} rawHtml Exact textarea value. Not modified.
   */
  function renderPreview(container, rawHtml, options) {
    if (!container) return null;

    container.textContent = '';
    var frame = createPreviewFrame(buildPreviewDocument(rawHtml), options);
    container.appendChild(frame);
    return frame;
  }

  global.HtmlPreview = {
    buildPreviewDocument: buildPreviewDocument,
    createPreviewFrame: createPreviewFrame,
    renderPreview: renderPreview
  };
})(window);
