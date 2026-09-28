function createLogoutModal() {
  const modalHTML = `
    <div id="logout-modal" class="modal" style="display: none;" role="dialog" aria-modal="true"
      aria-labelledby="logout-modal-title" aria-describedby="logout-modal-message">
      <div class="modal__panel modal__panel--sm">

        <div class="modal__header">
          <h3 class="modal__title" id="logout-modal-title">
            <i class="fa-solid fa-right-from-bracket"></i> Confirm Logout
          </h3>
          <button id="logout-modal-close" class="modal__close" type="button" aria-label="Close">
            <i class="fa-solid fa-times"></i>
          </button>
        </div>

        <div class="modal__body">
          <div class="confirm">
            <span class="confirm__icon" aria-hidden="true">
              <i class="fa-solid fa-triangle-exclamation"></i>
            </span>
            <p class="confirm__message" id="logout-modal-message">
              Are you sure you want to log out? You'll need to sign in again to access the dashboard.
            </p>
          </div>
        </div>

        <div class="modal__footer">
          <button id="logout-cancel" class="btn btn--secondary" type="button">
            <i class="fa-solid fa-xmark"></i> Cancel
          </button>
          <button id="logout-confirm" class="btn btn--danger" type="button">
            <i class="fa-solid fa-right-from-bracket"></i> Logout
          </button>
        </div>

      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

function initLogout() {
  const logoutBtn = document.getElementById('logout-btn');
  if (!logoutBtn) return;

  createLogoutModal();

  const modal = document.getElementById('logout-modal');
  const closeBtn = document.getElementById('logout-modal-close');
  const cancelBtn = document.getElementById('logout-cancel');
  const confirmBtn = document.getElementById('logout-confirm');

  // The element focused before the dialog opened, so focus can be restored on
  // close (screen-reader / keyboard users should not be dumped at the top).
  let lastFocused = null;
  let isSubmitting = false;

  const isOpen = () => modal.style.display === 'block';

  const focusableSelector =
    'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const openModal = () => {
    lastFocused = document.activeElement;
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden';
    // Default focus to the safe action (Cancel) so an accidental Enter does
    // not immediately log the user out.
    cancelBtn.focus();
  };

  const closeModal = () => {
    if (isSubmitting) return;
    modal.style.display = 'none';
    document.body.style.overflow = '';
    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
    }
  };

  const setLoading = (loading) => {
    isSubmitting = loading;
    confirmBtn.disabled = loading;
    cancelBtn.disabled = loading;
    closeBtn.disabled = loading;
    confirmBtn.innerHTML = loading
      ? '<i class="fa-solid fa-spinner fa-spin"></i> Logging out...'
      : '<i class="fa-solid fa-right-from-bracket"></i> Logout';
  };

  const performLogout = async () => {
    if (isSubmitting) return;
    setLoading(true);

    try {
      const response = await fetch('/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });

      const data = await response.json();

      if (data.success) {
        // The campaign draft lives in this tab's sessionStorage, which outlives a
        // logout. form-persistence.js also stamps it with the operator's email and
        // refuses to restore someone else's, but dropping it here means the data is
        // gone rather than merely unread.
        if (window.FormPersistence && typeof window.FormPersistence.clear === 'function') {
          window.FormPersistence.clear();
        }

        window.location.href = '/';
        return;
      }

      // Server responded but refused: surface it and let the user retry.
      setLoading(false);
      alert(data.message || 'Logout failed. Please try again.');
    } catch (error) {
      console.error('Logout error:', error);
      setLoading(false);
      alert('An error occurred during logout. Please try again.');
    }
  };

  // Keep Tab focus inside the dialog while it is open.
  const trapFocus = (e) => {
    if (e.key !== 'Tab') return;

    const focusable = Array.from(modal.querySelectorAll(focusableSelector))
      .filter(el => el.offsetParent !== null && !el.disabled);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  logoutBtn.addEventListener('click', (e) => {
    e.preventDefault();
    openModal();
  });

  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  confirmBtn.addEventListener('click', performLogout);

  // Click on the backdrop (outside the panel) closes the dialog.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;

    if (e.key === 'Escape') {
      closeModal();
    } else {
      trapFocus(e);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLogout);
} else {
  initLogout();
}
