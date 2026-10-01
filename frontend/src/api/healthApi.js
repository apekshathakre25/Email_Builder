import { api } from '../lib/apiClient';
import { API_BASE_URL } from '../lib/config';

/**
 * Host and queue telemetry for the header strip.
 *
 * Cached for 5 seconds server-side and given its own 600/min rate bucket, so
 * polling it cannot interfere with sending.
 *
 * @returns {Promise<{
 *   cpu: {currentLoad: number, cores: number|undefined},
 *   memory: {totalGB: number, usedGB: number, percentUsed: number},
 *   disk: {totalGB: number, usedGB: number, freeGB: number, percentUsed: number},
 *   network: {rx_sec: number, tx_sec: number},
 *   queue: {active: number, waiting: number, delayed: number, failed: number, total: number, available: boolean},
 *   system: {uptime: string, uptimeSeconds: number, nodeVersion: string, platform: string},
 *   timestamp: string}>}
 */
export function getSystemHealth(signal) {
  return api.get('/api/system-health', { signal });
}

/**
 * Keep-alive ping.
 *
 * Unauthenticated and deliberately not routed through the shared client: its only
 * job is to hold the connection warm, and a failure is not worth surfacing anywhere.
 * A rejected promise here would otherwise show up as an unhandled rejection in the
 * console for something entirely inconsequential.
 */
export function ping(signal) {
  return fetch(`${API_BASE_URL}/healthz`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include',
    signal
  }).catch(() => null);
}
