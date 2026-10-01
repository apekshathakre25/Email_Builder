import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getSystemHealth } from '../../api/healthApi';
import { keys } from '../../lib/queryKeys';
import { cn } from '../../lib/cn';
import { formatNumber, formatThroughput } from '../../lib/format';

const REFRESH_MS = 10_000;

/**
 * Host and queue telemetry strip.
 *
 * Thresholds are the same as before: under 60% is healthy, under 80% is a warning,
 * above that is a problem. The queue readout is the operationally interesting one —
 * `active/total` is what tells an operator whether workers are actually consuming the
 * jobs their campaign enqueued, which is the difference between "sending slowly" and
 * "not sending".
 */
function toneForPercent(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return 'muted';
  if (value < 60) return 'good';
  if (value < 80) return 'warning';
  return 'danger';
}

const TONE_STYLES = {
  good: 'text-success-600',
  warning: 'text-warning-700',
  danger: 'text-danger-600',
  muted: 'text-muted'
};

export function SystemHealthStrip() {
  // Polling is paused while the tab is hidden: this is ambient information and there is
  // no value in billing the rate-limit bucket for a panel nobody is looking at.
  const [isHidden, setIsHidden] = useState(() => (typeof document === 'undefined' ? false : document.hidden));

  useEffect(() => {
    const handler = () => setIsHidden(document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const { data, isError } = useQuery({
    queryKey: keys.health,
    queryFn: ({ signal }) => getSystemHealth(signal),
    refetchInterval: isHidden ? false : REFRESH_MS,
    staleTime: REFRESH_MS,
    retry: 1
  });

  // Hidden entirely on failure rather than showing a broken strip. It is diagnostics; a
  // red error box at the top of the dashboard would imply something is wrong with the
  // campaign, which it is not.
  if (isError && !data) return null;

  const items = [
    {
      icon: 'fa-microchip',
      label: 'CPU',
      value: data ? `${Math.round(data.cpu?.currentLoad ?? 0)}%` : '—',
      tone: toneForPercent(data?.cpu?.currentLoad),
      title: data?.cpu?.cores ? `${data.cpu.cores} cores` : undefined
    },
    {
      icon: 'fa-memory',
      label: 'RAM',
      value: data ? `${Math.round(data.memory?.percentUsed ?? 0)}%` : '—',
      tone: toneForPercent(data?.memory?.percentUsed),
      title: data ? `${data.memory?.usedGB ?? 0} / ${data.memory?.totalGB ?? 0} GB` : undefined
    },
    {
      icon: 'fa-hard-drive',
      label: 'Disk',
      value: data ? `${Math.round(data.disk?.percentUsed ?? 0)}%` : '—',
      tone: toneForPercent(data?.disk?.percentUsed),
      title: data ? `${data.disk?.usedGB ?? 0} / ${data.disk?.totalGB ?? 0} GB` : undefined
    },
    {
      icon: 'fa-layer-group',
      label: 'Queue',
      value: data?.queue?.available
        ? `${formatNumber(data.queue.active ?? 0)}/${formatNumber(data.queue.total ?? 0)}`
        : 'n/a',
      tone: data?.queue?.available ? (data.queue.failed > 0 ? 'warning' : 'good') : 'muted',
      title: data?.queue?.available
        ? `active ${data.queue.active} · waiting ${data.queue.waiting} · delayed ${data.queue.delayed} · failed ${data.queue.failed}`
        : 'Queue metrics unavailable'
    },
    {
      icon: 'fa-clock-rotate-left',
      label: 'Uptime',
      value: data?.system?.uptime ?? '—',
      tone: 'muted',
      title: data?.system ? `${data.system.platform} · Node ${data.system.nodeVersion}` : undefined
    },
    {
      icon: 'fa-network-wired',
      label: 'Network',
      value: data ? formatThroughput((data.network?.rx_sec ?? 0) + (data.network?.tx_sec ?? 0)) : '—',
      tone: 'muted',
      title: data
        ? `down ${formatThroughput(data.network?.rx_sec ?? 0)} · up ${formatThroughput(data.network?.tx_sec ?? 0)}`
        : undefined
    }
  ];

  return (
    <section
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line bg-surface px-4 py-2.5 shadow-xs"
      aria-label="System health"
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-ink-700">
        <i className="fa-solid fa-heart-pulse text-brand-500" aria-hidden="true" />
        System Health
      </span>

      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5 text-sm" title={item.title}>
          <i className={cn('fa-solid text-ink-400', item.icon)} aria-hidden="true" />
          <span className="text-muted">{item.label}</span>
          <span className={cn('font-mono font-semibold tabular-nums', TONE_STYLES[item.tone])}>{item.value}</span>
        </span>
      ))}
    </section>
  );
}
