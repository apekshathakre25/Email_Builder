/**
 * Display formatting.
 *
 * Every function here is defensive about its input because most of it comes from
 * the API, and a missing counter should render as a dash rather than "NaN".
 */

/** Thousands separators. Campaign counters routinely run into seven figures. */
export function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return numeric.toLocaleString();
}

export function formatBytes(bytes) {
  const numeric = Number(bytes);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0 MB';

  const mb = numeric / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(numeric / 1024).toFixed(0)} KB`;
}

/** mm:ss, clamped at zero. Drives the "next interval" countdown. */
export function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(Number(ms) / 1000) || 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

/** Two-line table cell: 'MM/DD/YY' plus 24-hour 'HH:MM'. */
export function formatDateParts(value) {
  if (!value) return { date: '—', time: '' };

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: '—', time: '' };

  return {
    date: date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }),
    time: date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  };
}

export function formatTimeOnly(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Integer percentage, 0–100, safe when the denominator is zero.
 *
 * Progress bars are the main caller and a divide-by-zero there would render as an
 * empty bar with "NaN% Done" beneath it.
 */
export function percentage(part, whole) {
  const numerator = Number(part);
  const denominator = Number(whole);

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((numerator / denominator) * 100)));
}

/**
 * Truncates in the middle of a long value, keeping both ends visible.
 *
 * Better than a trailing ellipsis for emails and IPs, where the distinguishing part
 * is often at the end: 'averylongname@example.com' and 'averylongname@other.org'
 * are identical for the first 20 characters.
 */
export function truncateMiddle(value, maxLength = 28) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;

  const head = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

export function capitalise(value) {
  const text = String(value ?? '').replace(/_/g, ' ');
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Bytes per second, for the network readout. */
export function formatThroughput(bytesPerSecond) {
  const numeric = Number(bytesPerSecond);
  if (!Number.isFinite(numeric) || numeric < 0) return '0 KB/s';

  if (numeric >= 1024 * 1024) return `${(numeric / (1024 * 1024)).toFixed(1)} MB/s`;
  if (numeric >= 1024) return `${(numeric / 1024).toFixed(0)} KB/s`;
  return `${Math.round(numeric)} B/s`;
}
