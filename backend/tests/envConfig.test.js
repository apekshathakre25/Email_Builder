/**
 * DB_CLEANUP_DAYS is the single retention knob, so its parsing is worth pinning.
 *
 * Each case runs in a child process because config/env.js resolves once at
 * require time — which is also exactly how the real app reads it, so this
 * doubles as the "value is respected across a restart" check.
 *
 * The 0 case matters most: an unvalidated 0 would put the cutoff at "now" and the
 * next sweep would delete every settled campaign in the database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Printed on stdout by the child; env.js warnings go to stderr.
const PROBE = `
const env = require('./config/env');
const { cutoffDate } = require('./utils/dbCleanup');
const { sessionKeyTtlSeconds } = require('./utils/sessionKeys');
process.stdout.write(JSON.stringify({
  retentionDays: env.dbCleanup.retentionDays,
  retentionSeconds: env.dbCleanup.retentionSeconds,
  intervalHours: env.dbCleanup.intervalHours,
  cutoffAgeDays: (Date.now() - cutoffDate().getTime()) / 86400000,
  redisTtlSeconds: sessionKeyTtlSeconds()
}));
`;

function readConfigWith(overrides) {
  const stdout = execFileSync(process.execPath, ['-e', PROBE], {
    cwd: ROOT,
    env: { ...process.env, ...overrides },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });

  return JSON.parse(stdout);
}

for (const days of [1, 3, 7, 30, 365]) {
  test(`DB_CLEANUP_DAYS=${days} is honoured end to end`, () => {
    const config = readConfigWith({ DB_CLEANUP_DAYS: String(days) });

    assert.equal(config.retentionDays, days);
    assert.equal(config.retentionSeconds, days * 86400);
    assert.ok(
      Math.abs(config.cutoffAgeDays - days) < 0.01,
      `cutoff was ${config.cutoffAgeDays} days old`
    );
    assert.equal(config.redisTtlSeconds, days * 86400 * 4, 'Redis TTL tracks retention');
  });
}

for (const bad of ['0', '-5', 'abc', '2.5', '99999', '']) {
  test(`DB_CLEANUP_DAYS="${bad}" falls back to the safe default`, () => {
    const config = readConfigWith({ DB_CLEANUP_DAYS: bad });

    assert.equal(config.retentionDays, 3, 'must not accept an unsafe retention value');
    assert.ok(config.cutoffAgeDays > 2.9, 'cutoff must never collapse towards now');
  });
}

test('DB_CLEANUP_INTERVAL_HOURS is independent of the retention window', () => {
  const config = readConfigWith({ DB_CLEANUP_DAYS: '30', DB_CLEANUP_INTERVAL_HOURS: '2' });

  assert.equal(config.retentionDays, 30);
  assert.equal(config.intervalHours, 2, 'sweep frequency must not follow retention');
});

test('an out-of-range interval falls back without affecting retention', () => {
  const config = readConfigWith({ DB_CLEANUP_DAYS: '7', DB_CLEANUP_INTERVAL_HOURS: '0' });

  assert.equal(config.retentionDays, 7);
  assert.equal(config.intervalHours, 6);
});
