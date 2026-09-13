function createMessageIdModal() {
  const modalHTML = `
    <div id="message-id-modal" class="modal" style="display: none;" role="dialog" aria-modal="true"
      aria-labelledby="message-id-modal-title">
      <div class="modal__panel">

        <div class="modal__header">
          <h3 class="modal__title" id="message-id-modal-title">
            <i class="fa-solid fa-envelope-circle-check"></i> Message-ID Placeholders
          </h3>
          <button id="close-modal" class="modal__close" type="button" aria-label="Close">
            <i class="fa-solid fa-times"></i>
          </button>
        </div>

        <div class="modal__body">

          <p class="modal__lead">
            Create dynamic Message-IDs using placeholders wrapped in <code>[[...]]</code>
          </p>

          <div class="modal__grid">

            <div class="ref-card">
              <h4 class="ref-card__title"><i class="fa-solid fa-font"></i> Characters</h4>
              <div class="ref-list">
                <div><code>[[bigchar(X)]]</code> - UPPERCASE</div>
                <div><code>[[smallchar(X)]]</code> - lowercase</div>
                <div><code>[[mixsmallbigchar(X)]]</code> - MixCase</div>
                <div><code>[[num(X)]]</code> - 0123456789</div>
              </div>
            </div>

            <div class="ref-card ref-card--alt">
              <h4 class="ref-card__title"><i class="fa-solid fa-hashtag"></i> Alphanumeric</h4>
              <div class="ref-list">
                <div><code>[[mixsmallalphanum(X)]]</code> - a-z + 0-9</div>
                <div><code>[[mixbigalphanum(X)]]</code> - A-Z + 0-9</div>
                <div><code>[[mixall(X)]]</code> - All mixed</div>
                <div><code>[[hexdigit(X)]]</code> - 0-9, a-f</div>
              </div>
            </div>

            <div class="ref-card ref-card--time">
              <h4 class="ref-card__title"><i class="fa-solid fa-clock"></i> Date &amp; Time</h4>
              <div class="ref-list">
                <div><code>[[timestamp]]</code> - Unix time</div>
                <div><code>&lt;?=time()?&gt;</code> - YYYYMMDDHHMMSS</div>
                <div><code>[[RFC_Date_UTC()]]</code> - RFC UTC</div>
                <div><code>[[RFC_Date_IST()]]</code> - RFC IST</div>
              </div>
            </div>

            <div class="ref-card ref-card--special">
              <h4 class="ref-card__title"><i class="fa-solid fa-wand-magic-sparkles"></i> Special</h4>
              <div class="ref-list">
                <div><code>[[ascii2hex(text)]]</code> - ASCII&rarr;Hex</div>
                <div><code>{{Domain}}</code> - Auto domain</div>
                <div class="text-muted">Domain from "From Email"</div>
              </div>
            </div>

          </div>

          <div class="callout-box">
            <h4 class="callout-box__title"><i class="fa-solid fa-lightbulb"></i> Quick Examples</h4>

            <div class="snippet-group">
              <strong>Simple:</strong>
              <code class="snippet">&lt;[[timestamp]]-[[bigchar(6)]]-[[num(6)]]@{{Domain}}&gt;</code>
            </div>

            <div class="snippet-group">
              <strong>Complex:</strong>
              <code class="snippet">&lt;[[mixsmallalphanum(32)]]@[[smallchar(5)]].{{Domain}}&gt;</code>
            </div>

            <div class="snippet-group">
              <strong>Custom domain:</strong>
              <code class="snippet">&lt;infini8-&lt;?=time()?&gt;@infini8media.com&gt;</code>
            </div>
          </div>

          <div class="callout-box callout-box--warning">
            <strong><i class="fa-solid fa-info-circle"></i> Notes:</strong>
            <ul>
              <li>Each email gets a unique ID</li>
              <li>X = number of characters</li>
              <li>Always use &lt; &gt; brackets</li>
            </ul>
          </div>

        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

function initMessageIdHelp() {

  createMessageIdModal();

  const messageIdHelpBtn = document.getElementById('message-id-help');
  const messageIdModal = document.getElementById('message-id-modal');
  const closeModalBtn = document.getElementById('close-modal');

  if (messageIdHelpBtn && messageIdModal && closeModalBtn) {

    messageIdHelpBtn.addEventListener('click', (e) => {
      e.preventDefault();
      messageIdModal.style.display = 'block';
      document.body.style.overflow = 'hidden';
    });

    const closeModal = () => {
      messageIdModal.style.display = 'none';
      document.body.style.overflow = '';
    };

    closeModalBtn.addEventListener('click', closeModal);

    messageIdModal.addEventListener('click', (e) => {
      if (e.target === messageIdModal) {
        closeModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && messageIdModal.style.display === 'block') {
        closeModal();
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMessageIdHelp);
} else {
  initMessageIdHelp();
}
