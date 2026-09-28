/**
 * In-app confirmation dialog.
 *
 * WHY THIS EXISTS
 * ---------------
 * `window.confirm()` was being used for the Stop Sending confirmation. It works,
 * but it renders as a browser chrome dialog captioned "localhost:3000 says",
 * styled by the browser and the OS theme rather than the application — so the most
 * consequential action in the product looked like the least trustworthy part of it.
 * It also blocks the main thread, which means the status poller and the interval
 * countdown freeze for as long as the dialog is open.
 *
 * This is the same shape as the existing logout confirmation (public/js/logout.js)
 * and reuses the `.modal` / `.confirm` classes already in public/css/style.css, so
 * it inherits the application's surfaces, spacing and focus ring instead of
 * introducing a second dialog style.
 *
 * WHY IT IS A MODULE RATHER THAN INLINE
 * -------------------------------------
 * Stop Sending has two entry points — the button beside Send Email and the one in
 * the interval popup — and both must produce exactly the same prompt. A single
 * promise-returning function is the cheapest way to guarantee that, and it follows
 * the `window.HtmlPreview` / `window.FormPersistence` convention this codebase
 * already uses for shared browser-side helpers.
 *
 * USAGE
 *   const ok = await window.ConfirmDialog.confirm({
 *     title: 'Stop sending?',
 *     message: 'Plain text, or an array of paragraphs.',
 *     confirmLabel: 'Stop Sending',
 *     tone: 'danger'
 *   });
 *
 * Resolves true only if the operator actively confirms. Escape, Cancel, the close
 * button and a backdrop click all resolve false, so a dismissal can never be
 * mistaken for consent.
 */
(function () {
  'use strict';

  const MODAL_ID = 'app-confirm-dialog';

  let modal = null;
  let elements = null;

  // Resolver for the dialog currently on screen. Also the "is a dialog open?"
  // flag, which is what makes a second call while one is pending impossible to
  // mishandle.
  let pendingResolve = null;
  let lastFocused = null;

  const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function build() {
    const html = `
      <div id="${MODAL_ID}" class="modal" style="display: none;" role="dialog" aria-modal="true"
        aria-labelledby="${MODAL_ID}-title" aria-describedby="${MODAL_ID}-message">
        <div class="modal__panel modal__panel--sm">

          <div class="modal__header">
            <h3 class="modal__title" id="${MODAL_ID}-title">
              <i class="fa-solid fa-circle-question" data-role="title-icon"></i>
              <span data-role="title-text">Please confirm</span>
            </h3>
            <button class="modal__close" type="button" aria-label="Close" data-role="close">
              <i class="fa-solid fa-times"></i>
            </button>
          </div>

          <div class="modal__body">
            <div class="confirm">
              <span class="confirm__icon" aria-hidden="true" data-role="icon">
                <i class="fa-solid fa-triangle-exclamation"></i>
              </span>
              <div class="confirm__message" id="${MODAL_ID}-message" data-role="message"></div>
            </div>
          </div>

          <div class="modal__footer">
            <button class="btn btn--secondary" type="button" data-role="cancel">
              <i class="fa-solid fa-xmark"></i> <span data-role="cancel-label">Cancel</span>
            </button>
            <button class="btn btn--danger" type="button" data-role="confirm">
              <i class="fa-solid fa-check" data-role="confirm-icon"></i>
              <span data-role="confirm-label">Confirm</span>
            </button>
          </div>

        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', html);

    modal = document.getElementById(MODAL_ID);
    const pick = (role) => modal.querySelector(`[data-role="${role}"]`);

    elements = {
      titleIcon: pick('title-icon'),
      titleText: pick('title-text'),
      icon: pick('icon'),
      message: pick('message'),
      close: pick('close'),
      cancel: pick('cancel'),
      cancelLabel: pick('cancel-label'),
      confirm: pick('confirm'),
      confirmIcon: pick('confirm-icon'),
      confirmLabel: pick('confirm-label')
    };

    elements.close.addEventListener('click', () => settle(false));
    elements.cancel.addEventListener('click', () => settle(false));
    elements.confirm.addEventListener('click', () => settle(true));

    // Backdrop only — a click inside the panel must not dismiss it.
    modal.addEventListener('click', (event) => {
      if (event.target === modal) settle(false);
    });

    document.addEventListener('keydown', onKeydown);
  }

  function ensureBuilt() {
    if (!modal) build();
  }

  function isOpen() {
    return Boolean(modal) && modal.style.display === 'block';
  }

  function onKeydown(event) {
    if (!isOpen()) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      settle(false);
      return;
    }

    if (event.key !== 'Tab') return;

    // Keep Tab inside the dialog. Without this, focus walks out into the form
    // behind the overlay, where the operator can type into fields they cannot see.
    const focusable = Array.from(modal.querySelectorAll(FOCUSABLE))
      .filter((el) => el.offsetParent !== null && !el.disabled);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /** Closes the dialog and resolves the pending promise exactly once. */
  function settle(result) {
    if (!pendingResolve) return;

    const resolve = pendingResolve;
    pendingResolve = null;

    modal.style.display = 'none';
    document.body.style.overflow = '';

    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
    }
    lastFocused = null;

    resolve(result);
  }

  /**
   * Renders the message.
   *
   * Accepts a string or an array of paragraphs, and writes with textContent so a
   * caller cannot inject markup — messages routinely carry server text and
   * recipient counts, and none of it is trusted as HTML.
   */
  function renderMessage(message) {
    elements.message.textContent = '';

    const paragraphs = Array.isArray(message) ? message : [message];

    for (const text of paragraphs) {
      if (text === null || text === undefined || text === '') continue;
      const p = document.createElement('p');
      p.textContent = String(text);
      p.style.margin = '0 0 0.5rem';
      elements.message.appendChild(p);
    }

    const last = elements.message.lastElementChild;
    if (last) last.style.margin = '0';
  }

  const TONES = {
    danger: {
      button: 'btn btn--danger',
      // is-danger overrides the brand colour .modal__title i applies by default, so
      // the header icon reads as a warning rather than as information.
      titleIcon: 'fa-solid fa-triangle-exclamation is-danger',
      confirmIcon: 'fa-solid fa-circle-stop'
    },
    primary: {
      button: 'btn btn--primary',
      titleIcon: 'fa-solid fa-circle-question',
      confirmIcon: 'fa-solid fa-check'
    }
  };

  /**
   * Opens the dialog. Returns a promise for the operator's answer.
   *
   * A second call while one is already open resolves false immediately rather than
   * replacing the visible dialog — two prompts racing for the same decision is
   * worse than declining the later one, and the caller treats false as "do not
   * proceed", which is the safe outcome.
   */
  function confirmDialog(options) {
    const opts = options || {};

    ensureBuilt();

    if (pendingResolve) return Promise.resolve(false);

    const tone = TONES[opts.tone] || TONES.danger;

    elements.titleText.textContent = opts.title || 'Please confirm';
    elements.titleIcon.className = tone.titleIcon;
    elements.confirm.className = tone.button;
    elements.confirmIcon.className = opts.confirmIcon || tone.confirmIcon;
    elements.confirmLabel.textContent = opts.confirmLabel || 'Confirm';
    elements.cancelLabel.textContent = opts.cancelLabel || 'Cancel';
    renderMessage(opts.message || '');

    return new Promise((resolve) => {
      pendingResolve = resolve;

      lastFocused = document.activeElement;
      modal.style.display = 'block';

      // The page behind is locked so the overlay cannot be scrolled past.
      document.body.style.overflow = 'hidden';

      // Focus lands on Cancel, not on the confirm button: for a destructive action
      // an accidental Enter should do nothing.
      elements.cancel.focus();
    });
  }

  window.ConfirmDialog = { confirm: confirmDialog };
})();
