import { api } from '../lib/apiClient';

/** Returns safe Inbox Pattern metadata. Raw pattern definitions never reach the browser. */
export function getInboxPatterns(signal) {
  return api.get('/api/patterns', { signal });
}
