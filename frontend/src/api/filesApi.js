import { api, downloadFile, ApiError } from '../lib/apiClient';
import { API_BASE_URL } from '../lib/config';

/**
 * Recipient files.
 *
 * A file's `sessionId` is the campaign id: it is what goes into the campaign form's
 * File IDs field, what /status is polled with, and what /stop-sending halts. The
 * name is historical but the identity is real, so nothing here renames it.
 */

/**
 * @typedef {Object} UploadedFileRecord
 * @property {string} sessionId
 * @property {string} originalName
 * @property {string} uploadDate
 * @property {number} fileSize
 * @property {string} fileType
 * @property {number} totalEmails
 * @property {number} validEmails
 * @property {number} invalidEmails
 * @property {number} sentEmails
 * @property {number} failedEmails
 * @property {number} pendingEmails
 * @property {'uploaded'|'processing'|'completed'|'failed'} status
 */

/**
 * @returns {Promise<{files: UploadedFileRecord[], pagination: {page: number,
 *   limit: number, totalFiles: number, totalPages: number, hasNext: boolean,
 *   hasPrev: boolean}}>}
 */
export function listFiles({ page = 1, limit = 15, sortBy = 'uploadDate', sortOrder = 'desc' } = {}, signal) {
  return api.get('/files', { query: { page, limit, sortBy, sortOrder }, signal });
}

export function getFilesStats(signal) {
  return api.get('/files-stats', { signal });
}

/**
 * Uploads a recipient file.
 *
 * Parsing is entirely server-side: the file is posted whole and the results are
 * read back from /files. There is no client-side CSV parse, no column mapping and
 * no per-row error list, because the server does not expose per-row detail — only
 * the aggregate valid / invalid counts on the file record.
 *
 * Uses XMLHttpRequest rather than fetch for exactly one reason: fetch cannot report
 * upload progress. These files run to tens of megabytes, and a progress bar is the
 * difference between "working" and "frozen" for the operator.
 *
 * @param {File} file
 * @param {object} [options]
 * @param {(percent: number|null) => void} [options.onProgress] null when the total
 *   size is unknown and a percentage cannot be computed.
 * @param {string} [options.sessionId] Sent as x-session-id. Omit to let the server
 *   mint a uuid, which is the normal path.
 * @returns {Promise<{total: number, sessionId: string, fileInfo: object}>}
 */
export function uploadRecipients(file, { onProgress, sessionId, signal } = {}) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    // Field name must be 'file' — it is what upload.single('file') expects, and a
    // mismatch is rejected by multer as LIMIT_UNEXPECTED_FILE.
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}/recipients`, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    if (sessionId) xhr.setRequestHeader('x-session-id', sessionId);
    // Content-Type is deliberately not set: the browser must add the multipart
    // boundary itself.

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        onProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null);
      });
    }

    const abort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    }

    const cleanup = () => signal?.removeEventListener('abort', abort);

    xhr.addEventListener('load', () => {
      cleanup();

      const contentType = (xhr.getResponseHeader('content-type') || '').toLowerCase();
      let payload = null;
      if (contentType.includes('application/json')) {
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          payload = null;
        }
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload ?? {});
        return;
      }

      // 413 can arrive from the app as JSON or from the reverse proxy as an HTML
      // error page. Never surface the proxy's body: it can name the server
      // software, and there is nothing actionable in it.
      const message =
        xhr.status === 413
          ? 'File is too large for the current upload limit. Please use a smaller file.'
          : payload?.error || payload?.message || `Upload failed with HTTP ${xhr.status}.`;

      reject(new ApiError(message, { status: xhr.status, code: payload?.code ?? null, payload }));
    });

    xhr.addEventListener('error', () => {
      cleanup();
      reject(
        new ApiError(
          'Upload failed: the connection was interrupted. Please try again.',
          { status: 0 }
        )
      );
    });

    xhr.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    });

    xhr.send(formData);
  });
}

/**
 * Deletes one file, its recipient list and its resume position.
 *
 * Campaign logs survive on purpose — they are the history of what was sent — so
 * deleting a file does not erase the record of the sends it produced.
 */
export function deleteFile(sessionId) {
  return api.delete(`/files/${encodeURIComponent(sessionId)}`);
}

/**
 * Deletes every file. Campaign logs are preserved.
 *
 * Declared ahead of the :sessionId route on the server, so the literal path wins.
 */
export function deleteAllFiles() {
  return api.delete('/files/delete-all');
}

/**
 * @param {string} sessionId
 * @param {'original'|'sent'|'failed'|'pending'} artifact
 */
export function downloadFileArtifact(sessionId, artifact, originalName) {
  const fallback =
    artifact === 'original'
      ? originalName || `${sessionId}`
      : `${artifact}-emails-${sessionId}.csv`;

  return downloadFile(`/files/${encodeURIComponent(sessionId)}/${artifact}`, {
    fallbackFilename: fallback
  });
}
