import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { uploadRecipients } from '../../api/filesApi';
import { keys } from '../../lib/queryKeys';
import { formatBytes } from '../../lib/format';

/** Shown for both the local preflight and any server or proxy 413. */
const TOO_LARGE_MESSAGE = 'File is too large for the current upload limit. Please use a smaller file.';

/**
 * Uploading a recipient file, with a local size preflight and a progress reading.
 *
 * ── Why the preflight ────────────────────────────────────────────────────────
 *
 * multer rejects at `size >= fileSize`, so the comparison here uses `>=` too. Using `>`
 * would let a file of exactly the limit pass locally and then be refused by the server,
 * which is the most confusing possible outcome — the operator is told the limit is 25MB
 * and a 25MB file is rejected. The real limit comes from /api/app-config, so it cannot
 * drift from the server's.
 *
 * The preflight is a courtesy, not a control: refusing locally saves uploading tens of
 * megabytes to be rejected. The server still enforces the real limit.
 */
export function useFileUpload({ maxUploadBytes, allowedExtensions, onNotice }) {
  const queryClient = useQueryClient();

  const [progress, setProgress] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [currentFileName, setCurrentFileName] = useState('');
  const abortRef = useRef(null);

  // Abort an in-flight upload if the page navigates away, so the XHR does not outlive the
  // component and resolve into a dead setState.
  useEffect(() => () => abortRef.current?.abort(), []);

  const notice = useCallback((message) => onNotice?.(message), [onNotice]);

  /** Local checks. Returns an error message, or '' when the file is acceptable. */
  const validate = useCallback(
    (file) => {
      if (!file) return 'Choose a file first.';

      // A directory dropped onto the page arrives as a zero-size entry with no type.
      if (file.size === 0 && !file.type) return 'Folders are not supported — drop a single file.';

      const extension = `.${String(file.name).split('.').pop()?.toLowerCase() ?? ''}`;
      if (allowedExtensions?.length && !allowedExtensions.includes(extension)) {
        return `Unsupported file type "${extension}". Allowed: ${allowedExtensions.join(', ')}.`;
      }

      if (maxUploadBytes > 0 && file.size >= maxUploadBytes) {
        return `${TOO_LARGE_MESSAGE} (limit ${formatBytes(maxUploadBytes)}, selected ${formatBytes(file.size)})`;
      }

      return '';
    },
    [allowedExtensions, maxUploadBytes]
  );

  const upload = useCallback(
    async (file) => {
      const error = validate(file);
      if (error) {
        notice(`⚠️ ${error}`);
        return { ok: false, error };
      }

      const controller = new AbortController();
      abortRef.current = controller;

      setIsUploading(true);
      setProgress(0);
      setCurrentFileName(file.name);

      try {
        const data = await uploadRecipients(file, {
          onProgress: setProgress,
          signal: controller.signal
        });

        // The parsed totals live on the UploadedFile document rather than in this
        // response — fileInfo.totalEmails is always 0, because the server empties its
        // working array before building the reply. So the list is refetched instead of
        // being updated from the response.
        await queryClient.invalidateQueries({ queryKey: keys.files.all });

        notice(
          `✅ Uploaded ${file.name} — ${(data?.total ?? 0).toLocaleString()} valid recipient${
            data?.total === 1 ? '' : 's'
          }. File ID: ${data?.sessionId ?? 'unknown'}`
        );

        return { ok: true, data };
      } catch (err) {
        if (err?.name === 'AbortError') return { ok: false, aborted: true };

        notice(`❌ ${err.message}`);
        return { ok: false, error: err.message };
      } finally {
        abortRef.current = null;
        setIsUploading(false);
        setProgress(null);
        setCurrentFileName('');
      }
    },
    [notice, queryClient, validate]
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return { upload, cancel, isUploading, progress, currentFileName, validate };
}

/**
 * Window-level drag-and-drop.
 *
 * Counted rather than toggled: dragging over a child element fires dragleave on the
 * parent, so a naive boolean flickers the overlay off and on as the pointer moves across
 * the page. The counter only reaches zero when the pointer has genuinely left the window.
 */
export function useDropZone({ onDrop, disabled }) {
  const [isDragging, setIsDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    if (disabled) return undefined;

    const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const handleEnter = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setIsDragging(true);
    };

    const handleOver = (event) => {
      if (!hasFiles(event)) return;
      // Required: without preventDefault the browser navigates to the dropped file.
      event.preventDefault();
    };

    const handleLeave = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setIsDragging(false);
    };

    const handleDrop = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setIsDragging(false);

      const [file] = Array.from(event.dataTransfer?.files ?? []);
      if (file) onDrop(file);
    };

    window.addEventListener('dragenter', handleEnter);
    window.addEventListener('dragover', handleOver);
    window.addEventListener('dragleave', handleLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleEnter);
      window.removeEventListener('dragover', handleOver);
      window.removeEventListener('dragleave', handleLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [disabled, onDrop]);

  return isDragging;
}
