const express = require('express');
const si = require('systeminformation');
const router = express.Router();

let emailQueue = null;
try {
  emailQueue = require('../workprocess/queue');
} catch (err) {
  console.error('⚠️  System health: email queue unavailable:', err.message);
}

const CACHE_TTL_MS = 5000;
let cache = { at: 0, payload: null };

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function toPercent(used, total) {
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return Number(((Number(used) || 0) / t) * 100);
}

async function readQueueStats() {
  if (!emailQueue) {
    return { active: 0, waiting: 0, delayed: 0, failed: 0, total: 0, available: false };
  }

  try {
    const counts = await emailQueue.getJobCounts();
    const active = counts.active || 0;
    const waiting = counts.waiting || 0;
    const delayed = counts.delayed || 0;
    const paused = counts.paused || 0;

    return {
      active,
      waiting,
      delayed,
      failed: counts.failed || 0,
      total: active + waiting + delayed + paused,
      available: true
    };
  } catch (err) {
    console.error('⚠️  System health: queue stats failed:', err.message);
    return { active: 0, waiting: 0, delayed: 0, failed: 0, total: 0, available: false };
  }
}

async function readDiskStats() {
  try {
    const drives = await si.fsSize();
    const usable = (drives || []).filter(d => Number(d.size) > 0);

    if (usable.length === 0) {
      return { totalGB: 0, usedGB: 0, freeGB: 0, percentUsed: 0 };
    }

    const size = usable.reduce((sum, d) => sum + Number(d.size || 0), 0);
    const used = usable.reduce((sum, d) => sum + Number(d.used || 0), 0);
    const bytesPerGB = 1024 ** 3;

    return {
      totalGB: Number((size / bytesPerGB).toFixed(2)),
      usedGB: Number((used / bytesPerGB).toFixed(2)),
      freeGB: Number(((size - used) / bytesPerGB).toFixed(2)),
      percentUsed: Number(toPercent(used, size).toFixed(2))
    };
  } catch (err) {
    console.error('⚠️  System health: disk stats failed:', err.message);
    return { totalGB: 0, usedGB: 0, freeGB: 0, percentUsed: 0 };
  }
}

async function readNetworkStats() {
  try {
    const stats = await si.networkStats();
    const rx = (stats || []).reduce((sum, s) => sum + Math.max(0, Number(s.rx_sec) || 0), 0);
    const tx = (stats || []).reduce((sum, s) => sum + Math.max(0, Number(s.tx_sec) || 0), 0);
    return { rx_sec: Number(rx.toFixed(2)), tx_sec: Number(tx.toFixed(2)) };
  } catch (err) {
    console.error('⚠️  System health: network stats failed:', err.message);
    return { rx_sec: 0, tx_sec: 0 };
  }
}

async function collectHealth() {
  const [load, mem, disk, network, queue] = await Promise.all([
    si.currentLoad().catch(() => ({ currentLoad: 0 })),
    si.mem().catch(() => ({ total: 0, active: 0, available: 0 })),
    readDiskStats(),
    readNetworkStats(),
    readQueueStats()
  ]);

  const memTotal = Number(mem.total) || 0;
  const memUsed = Number(mem.active) || Math.max(0, memTotal - (Number(mem.available) || 0));
  const bytesPerGB = 1024 ** 3;

  return {
    cpu: {
      currentLoad: Number((Number(load.currentLoad) || 0).toFixed(2)),
      cores: load.cpus ? load.cpus.length : undefined
    },
    memory: {
      totalGB: Number((memTotal / bytesPerGB).toFixed(2)),
      usedGB: Number((memUsed / bytesPerGB).toFixed(2)),
      percentUsed: Number(toPercent(memUsed, memTotal).toFixed(2))
    },
    disk,
    network,
    queue,
    system: {
      uptime: formatUptime(process.uptime()),
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform
    },
    timestamp: new Date().toISOString()
  };
}

router.get('/api/system-health', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.payload && now - cache.at < CACHE_TTL_MS) {
      return res.json(cache.payload);
    }

    const payload = await collectHealth();
    cache = { at: now, payload };
    res.json(payload);
  } catch (err) {
    console.error('❌ System health: failed to collect metrics:', err.message);
    res.status(500).json({ error: 'Failed to collect system health metrics' });
  }
});

module.exports = router;
