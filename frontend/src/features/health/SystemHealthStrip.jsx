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
 * The queue readout is the operationally interesting one —
 * `active/total` is what tells an operator whether workers are actually consuming the
 * jobs their campaign enqueued, which is the difference between "sending slowly" and
 * "not sending".
 */
function readPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value));
}

function toneForPercent(percent, warningAt, criticalAt) {
  if (percent == null) return 'muted';
  if (percent >= criticalAt) return 'danger';
  if (percent >= warningAt) return 'warning';
  return 'good';
}

const TONE_STYLES = {
  good: {
    text: 'text-success-600',
    icon: 'bg-success-50 text-success-600',
    bar: 'bg-success-500',
    badge: 'bg-success-50'
  },
  warning: {
    text: 'text-warning-700',
    icon: 'bg-warning-50 text-warning-700',
    bar: 'bg-warning-500',
    badge: 'bg-warning-50'
  },
  danger: {
    text: 'text-danger-600',
    icon: 'bg-danger-50 text-danger-600',
    bar: 'bg-danger-500',
    badge: 'bg-danger-50'
  },
  blue: {
    text: 'text-brand-600',
    icon: 'bg-brand-50 text-brand-600',
    bar: 'bg-brand-500',
    badge: 'bg-brand-50'
  },
  muted: {
    text: 'text-ink-600',
    icon: 'bg-ink-50 text-ink-600',
    bar: 'bg-ink-400',
    badge: 'bg-ink-50'
  }
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

  const cpuPercent = readPercent(data?.cpu?.currentLoad);
  const memoryPercent = readPercent(data?.memory?.percentUsed);
  const diskPercent = readPercent(data?.disk?.percentUsed);
  const items = [
    {
      icon: 'fa-microchip',
      label: 'CPU',
      value: cpuPercent == null ? '—' : `${cpuPercent}%`,
      percent: cpuPercent,
      tone: toneForPercent(cpuPercent, 75, 90),
      title: data?.cpu?.cores ? `${data.cpu.cores} cores` : undefined
    },
    {
      icon: 'fa-memory',
      label: 'RAM',
      value: memoryPercent == null ? '—' : `${memoryPercent}%`,
      percent: memoryPercent,
      tone: toneForPercent(memoryPercent, 80, 95),
      title: data ? `${data.memory?.usedGB ?? 0} / ${data.memory?.totalGB ?? 0} GB` : undefined
    },
    {
      icon: 'fa-hard-drive',
      label: 'Disk',
      value: diskPercent == null ? '—' : `${diskPercent}%`,
      percent: diskPercent,
      tone: toneForPercent(diskPercent, 80, 90),
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
      tone: 'blue',
      title: data?.system ? `${data.system.platform} · Node ${data.system.nodeVersion}` : undefined
    },
    {
      icon: 'fa-network-wired',
      label: 'Network',
      value: data ? formatThroughput((data.network?.rx_sec ?? 0) + (data.network?.tx_sec ?? 0)) : '—',
      tone: 'blue',
      title: data
        ? `down ${formatThroughput(data.network?.rx_sec ?? 0)} · up ${formatThroughput(data.network?.tx_sec ?? 0)}`
        : undefined
    }
  ];
  const healthTones = items.slice(0, 4).map(({ tone }) => tone);
  const healthTone = healthTones.includes('danger')
    ? 'danger'
    : healthTones.includes('warning')
      ? 'warning'
      : healthTones.every((tone) => tone === 'good')
        ? 'good'
        : 'muted';
  const healthLabel = !data
    ? 'Loading'
    : healthTone === 'good'
      ? 'Healthy'
      : healthTone === 'warning'
        ? 'Needs attention'
        : healthTone === 'danger'
          ? 'Critical'
          : 'Partial data';

  return (
    <section
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line bg-surface px-4 py-2.5 shadow-xs"
      aria-label="System health"
    >
      <div className="flex shrink-0 items-center gap-2.5 border-r border-line pr-4">
        <span
          className={cn('flex size-9 shrink-0 items-center justify-center rounded-full text-lg', TONE_STYLES[healthTone].icon)}
          aria-hidden="true"
        >
          <i className="fa-solid fa-heart-pulse" />
        </span>
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-ink-700">System Health</span>
          <span
            className={cn(
              'w-fit rounded-full px-2 py-0.5 text-xs font-semibold',
              TONE_STYLES[healthTone].text,
              TONE_STYLES[healthTone].badge
            )}
          >
            {healthLabel}
          </span>
        </span>
      </div>

      {items.map((item) => (
        <div
          key={item.label}
          className="flex min-w-[118px] items-center gap-2.5 border-r border-line pr-4 last:border-r-0 last:pr-0"
          title={item.title}
        >
          <span
            className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', TONE_STYLES[item.tone].icon)}
            aria-hidden="true"
          >
            <i className={cn('fa-solid', item.icon)} />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm text-ink-700">{item.label}</span>
            <span className={cn('font-mono text-sm font-semibold tabular-nums', TONE_STYLES[item.tone].text)}>
              {item.value}
            </span>
            {item.percent != null ? (
              <span
                className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-100"
                role="meter"
                aria-label={`${item.label} usage`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.max(0, Math.min(100, item.percent))}
                aria-valuetext={`${item.percent}%`}
              >
                <span
                  className={cn('block h-full rounded-full transition-[width] duration-300', TONE_STYLES[item.tone].bar)}
                  style={{ width: `${Math.max(0, Math.min(100, item.percent))}%` }}
                />
              </span>
            ) : null}
          </span>
        </div>
      ))}
    </section>
  );
}
