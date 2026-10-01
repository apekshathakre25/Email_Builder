import { downloadFile } from '../lib/apiClient';

/**
 * Campaign log artifacts.
 *
 * Only the download is exposed. The backend also offers paginated log listing, per-campaign
 * detail, aggregate statistics and deletion, but no screen consumes them — and neither did
 * the previous frontend, whose log-management JavaScript was live while the buttons had
 * been removed from the markup, leaving it unreachable. Wrapping endpoints nothing calls
 * would ship untested code that looks supported, so those are deliberately absent until
 * there is a page for them.
 */

/**
 * Per-recipient outcomes for one campaign, as CSV: `email,status,error,time`.
 *
 * This is what makes the "download the log for details" line on a campaign that finished
 * with failures actionable. Without it that message asks the operator to do something the
 * UI cannot do.
 */
export function downloadLog(sessionId) {
  return downloadFile(`/logs/${encodeURIComponent(sessionId)}/download`, {
    fallbackFilename: `emaillog-${sessionId}.csv`
  });
}
