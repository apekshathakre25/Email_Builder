# Issue #3 — Redis isolation for Opterite (READ-ONLY inspection)

Date: 2026-10-02
Scope: local repo `d:\Bulk Email` (branded `Opterite`, `backend/package.json` → `"name": "opterite"`), plus one read-only `cat` of `/opt/bulk-email-docker/docker-compose.prod.yml` on `contabo-opterite` for precedent.
Nothing was modified. No container was started, stopped or inspected destructively. No `redis-cli` was run. No secret values appear below.

---

## Summary

**The `prefix` claim is CONFIRMED, and it is worse than a prefix problem.**

`backend/workprocess/queue.js:62` is:

```js
const emailQueue = new Queue('emailQueue', {
  redis: redisOptions,
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 5000
  }
});
```

No `prefix`, no `redis.keyPrefix`. Bull therefore resolves `this.keyPrefix = opts.redis.keyPrefix || opts.prefix || 'bull'` (`backend/node_modules/bull/lib/queue.js:138`) to the default `'bull'`, and every key lands under `bull:emailQueue:*`. A shared Redis = a shared queue, byte for byte. Opterite's workers would `BRPOPLPUSH` live production jobs.

But Bull is only **one of nineteen** distinct Redis key spaces this codebase writes. The rest are plain, unprefixed, unnamespaced application keys — `recipients:<id>`, `sentIndex:<id>`, `campaignstop:<id>`, `otp:login:<email>`, `rl:login:<email>`, `dbcleanup:lock`. A shared Redis would also mean shared OTP login codes and a shared cleanup lock. Even setting a Bull `prefix` would not fix that. **A separate Redis instance is the only correct isolation.** A different DB index would work mechanically (the code does support it — see §2) but is rejected below for concrete reasons.

Decision-relevant facts:

| Fact | Consequence |
|---|---|
| Redis address comes **only** from `REDIS_URL`; no hostname is hardcoded anywhere in code | **No blocker.** `redis://opterite-redis:6379` is addressable. The literal `redis` hostname exists only in the *production compose file's* `environment:` block, not in source. |
| `config/redis.js:40` sets `maxRetriesPerRequest: null` explicitly | Correct for the shared app client. |
| `workprocess/queue.js` does **not** set `maxRetriesPerRequest`, but passes a plain options object (not a `createClient` factory) | **Not a problem.** Bull supplies `maxRetriesPerRequest: null` itself for `bclient`/`subscriber` (`bull/lib/queue.js:293-295`) and forces `enableReadyCheck: false` (`:122`). The Bull requirement is satisfied. |
| ⚠️ `workprocess/queue.js:47` does `port: Number(redisUrl.port)` | **`REDIS_URL` MUST carry an explicit `:6379`.** `redis://opterite-redis` with no port yields `port: 0`, and Bull's `_.defaults` (`bull/lib/queue.js:130`) only fills `undefined`, so `0` survives and the queue never connects. |
| ⚠️ `workprocess/queue.js:48` does `password: redisUrl.password` | WHATWG `URL.password` returns the **percent-encoded** form; `config/redis.js` hands the whole URL to ioredis, which **decodes** it. A password needing percent-encoding would make the queue authenticate with a different string than the rest of the app. Argues for no password, or alphanumeric only. |
| Production Redis precedent uses `--maxmemory-policy noeviction` | **No danger to flag.** The precedent is already correct and should be copied verbatim. |
| Production Redis uses `--appendonly yes` and publishes no host port | Copy both. |

---

## 1. Where Redis connection settings are loaded

There are **two independent connection builders**, and they do not share code.

### 1a. `backend/config/redis.js` — the application client

```js
const env = require('./env');
const Redis = require('ioredis');

function createRedisClient() {
  if (!process.env.REDIS_URL) {
    console.error('❌ REDIS_URL environment variable is required but not set!');
    throw new Error('REDIS_URL environment variable is required.');
  }

  const isSecure = process.env.REDIS_URL.startsWith('rediss://');

  const client = new Redis(process.env.REDIS_URL, {
    tls: isSecure ? {} : undefined,
    retryStrategy(times) { /* gives up after 30 attempts; delay = min(times*50, 10000) */ },
    reconnectOnError(err) { /* reconnects on READONLY | ECONNRESET | ETIMEDOUT */ },
    keepAlive: 30000,
    connectTimeout: 10000,
    commandTimeout: 30000,
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  ...
}

let sharedClient = null;
function getSharedRedisClient() {
  if (!sharedClient) sharedClient = createRedisClient();
  return sharedClient;
}

module.exports = createRedisClient;
module.exports.getSharedRedisClient = getSharedRedisClient;
```
(`backend/config/redis.js:1-67`)

The whole URL is handed to `ioredis`, so ioredis parses host, port, password **and the `/<db>` path**.

Operationally notable options:
- `maxRetriesPerRequest: null` + `enableOfflineQueue: true` — during a Redis outage commands **queue indefinitely** rather than failing fast. Requests hang instead of erroring. Combined with `commandTimeout: 30000` a stalled command eventually errors after 30s.
- `retryStrategy` gives up permanently after 30 attempts (~5 min). After that the client is dead and the process needs a restart — which `restart: unless-stopped` plus the container healthcheck does not detect, because the app has no Redis readiness probe (see §4, `routes/system-health.js`).
- `lazyConnect: false` — connects at module require time.
- TLS only when the URL scheme is `rediss://`. Not needed on a private compose network.

**Two consumption patterns coexist**, which is the part worth knowing:

| Call site | Which client |
|---|---|
| `backend/middleware/rateLimit.js:51,55` | `getSharedRedisClient()` (singleton) |
| `backend/utils/otpStore.js:1,12,…` | `getSharedRedisClient()` |
| `backend/utils/dbCleanup.js:49,245,461,609` | `getSharedRedisClient()` |
| `backend/routes/campaignQueue.js:27,33` | `getSharedRedisClient()` |
| `backend/routes/sendemails.js:9-10` | **`createRedisClient()` — its own extra connection** |
| `backend/workprocess/mailer.js:8-9` | **`createRedisClient()` — its own extra connection** |

So the singleton is not actually universal: the two hottest modules each open a dedicated connection.

### 1b. `backend/workprocess/queue.js` — Bull's connection, built by hand

```js
const redisUrl = new URL(process.env.REDIS_URL);
const isSecure = redisUrl.protocol === 'rediss:';

const redisDb = (() => {
  const path = (redisUrl.pathname || '').replace(/^\//, '');
  if (path === '') return 0;
  const parsed = Number(path);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(`⚠️  Queue: ignoring unusable Redis database "${path}" in REDIS_URL; using 0.`);
    return 0;
  }
  return parsed;
})();

const redisOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port),
  password: redisUrl.password,
  db: redisDb,
  tls: isSecure ? {} : undefined,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  connectTimeout: 10000,
  keepAlive: 30000
};
```
(`backend/workprocess/queue.js:16-60`)

This re-derives the connection from the URL by hand rather than reusing `config/redis.js`. Hence the two defects in the summary table: `port: 0` when the URL omits the port, and the percent-encoded password. Note also that `retryStrategy` here **never gives up** (unlike `config/redis.js`), so Bull reconnects forever — which is the right behaviour for a queue.

### 1c. Connection count per process

Bull creates up to three connections per queue, lazily, via `redisClientGetter` (`bull/lib/queue.js:288-331`):

```js
const createClient = _.isFunction(options.createClient)
  ? options.createClient
  : function(type, config) {
      if (['bclient', 'subscriber'].includes(type)) {
        return new Redis({ ...config, maxRetriesPerRequest: null });
      } else {
        return new Redis(config);
      }
    };
```

Because the app passes `redis: redisOptions` (a plain object) and **not** a `createClient` factory, Bull injects `maxRetriesPerRequest: null` itself on `bclient` and `subscriber`, and the guard at `bull/lib/queue.js:313-320` that throws `MISSING_REDIS_OPTS` cannot trip.

**Web process (`node app.js`):**
1. `config/redis.js` shared singleton — created eagerly, because `middleware/rateLimit.js` calls `redisStore(...)` at module scope.
2. `routes/sendemails.js:10` own client.
3. Bull `client` — connected eagerly by the version check `getRedisVersion(this.client)` at `bull/lib/queue.js:200`.
   No `bclient` (no `.process()`), and no `subscriber`: `queue.js` attaches only `.on('error')` and `.on('ready')`, neither of which is a `global:` or internal event, so `_registerEvent` (`bull/lib/queue.js:523-528`) does not touch `eclient`.

**= 3 connections per web replica.**

**Worker process (`node workprocess/mailer.js`):**
1. `mailer.js:9` own client (the worker never calls `getSharedRedisClient`).
2. Bull `client`.
3. Bull `bclient` — the blocking `brpoplpush` consumer (`bull/lib/queue.js:1245-1251`), created by `emailQueue.process(CONCURRENCY, …)` at `mailer.js:674`.
4. Bull `subscriber` (`eclient`) — created by `_initProcess` → `_registerEvent('delayed')` (`bull/lib/queue.js:383-393`).

**= 4 connections per worker replica.**

At production's declared scale (4 web + 8 worker) that is ~44 client connections — far under Redis' default `maxclients`. No tuning needed.

---

## 2. Required environment variables

**Exactly one Redis variable exists: `REDIS_URL`. There is no discrete `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`REDIS_DB` form anywhere in the codebase.** (Verified by a repo-wide search for `REDIS_HOST|REDIS_PASSWORD|REDIS_DB` — zero hits outside prior planning notes.)

| Key | Required? | Default when absent | Expected shape |
|---|---|---|---|
| `REDIS_URL` | **REQUIRED — fatal, no fallback** | none | `redis://host:port[/db]` or `rediss://…`. Port must be explicit. Password optional, inline (`redis://:***@host:6379`). |

### Validation — it throws, it does not fall back

Three independent guards, all fatal:

```js
redisUrl: required('REDIS_URL'),
```
(`backend/config/env.js:325`) — `required()` pushes to `errors[]` when unset or blank (`env.js:38-52`), and the module ends with:

```js
if (errors.length > 0) {
  console.error('\n❌ Invalid configuration — refusing to start:\n');
  ...
  throw new Error(`Invalid environment configuration (${errors.length} problem…)`);
}
```
(`backend/config/env.js:468-476`)

```js
if (!process.env.REDIS_URL) {
  console.error('❌ REDIS_URL environment variable is required but not set!');
  throw new Error('REDIS_URL environment variable is required.');
}
```
(`backend/config/redis.js:5-8` and again, verbatim, at `backend/workprocess/queue.js:11-14`)

There is **no** silent `redis://localhost:6379` default. Good — a misconfigured Opterite container will crash-loop loudly rather than quietly attaching to the wrong Redis. Note `routes/system-health.js:7-11` swallows a queue require failure (`try/catch`), so a broken `REDIS_URL` degrades `/api/system-health` instead of killing it — but `config/env.js` has already thrown by then, so the process still refuses to boot.

`config/env.js` performs **no format validation** on `REDIS_URL` beyond non-emptiness. A malformed URL surfaces as a `new URL()` throw in `workprocess/queue.js:16`.

### Loading order

`backend/config/loadEnv.js` resolves `.env` from `__dirname`, not cwd, and reads two files in order: `backend/.env` then `<repo-root>/.env`.

```js
const ENV_FILES = [path.join(BACKEND_DIR, '.env'), path.join(REPO_ROOT, '.env')];
dotenv.config({ path: ENV_FILES, quiet: true });
```
(`backend/config/loadEnv.js:48-56`)

Its own header states the precedence that matters for Compose: *"Anything already present in the real environment (a compose `environment:` block, a shell export, a CI secret) beats both."* So a compose `environment: REDIS_URL: …` reliably overrides whatever is baked into the image's `.env`.

### What `backend/.env` currently holds

Redis-related keys present: **`REDIS_URL` only.** Its value is the local-development form `redis://127.0.0.1:6379` — no password, no database index. (Quoted because it contains no credential.) This is a **dev value that must be overridden in Compose**, exactly as the production stack already does for `bulk-email-sender`.

### Database index: supported, but do not rely on it

A DB index **is** honoured end to end:
- `config/redis.js` passes the full URL to ioredis, which parses the path.
- `workprocess/queue.js:33-44` explicitly parses it into `db:`, with a fallback-to-0-and-warn for garbage.

The doc comment there records why, and it is a useful warning:

> *"This used to be dropped. … set `REDIS_URL=redis://host:6379/3` and the stop markers, rate-limit buckets and per-campaign tallies would live in database 3 while the jobs they describe lived in database 0. `isCampaignStopped` would then never see a stop…"*
> (`backend/workprocess/queue.js:20-32`)

The one existing consumer of the DB index is the test harness, which rewrites the URL path at require time before any client is constructed (`backend/tests/helpers/testDb.js`, read from git `HEAD` — the file is deleted in the working tree):

```js
const TEST_REDIS_DB = 15;
function isolateRedisDatabase() {
  const raw = process.env.REDIS_URL;
  if (!raw) throw new Error('REDIS_URL is required to run the test suite.');
  const url = new URL(raw);
  url.pathname = `/${TEST_REDIS_DB}`;
  ...
  process.env.REDIS_URL = isolated;
}
```

Its header explains the need: *"dropAllEmailLogKeys deletes every `emaillog:*` key, and adoptPersistentSessionKeys walks every session key it can find. Pointed at the default database those operate on real application keys."* Worth flagging separately: **the suite isolates by DB index, not by instance, so running `npm test` with a production `REDIS_URL` in the environment would write to database 15 of the production Redis.** Another argument for never putting a production Redis address in a developer's `.env`.

**Why a separate DB index is still the wrong isolation strategy here:**
1. It is one typo from catastrophe. Dropping `/1` from the URL silently re-merges the two deployments into production's keyspace. A separate container cannot be mis-typed into production.
2. `SELECT`-based separation shares one process: one memory ceiling, one `maxmemory-policy`, one AOF rewrite, one single-threaded event loop. Opterite's `SCAN` sweeps (`utils/sessionKeys.js:255-307`) and Lua scripts would contend with production's ~700 concurrent senders.
3. `utils/dbCleanup.js` would still be able to take production's `dbcleanup:lock` only if the DB matched — but a shared instance means a shared `FLUSHALL`, a shared restart, and a shared LOADING stall. The production host has already been taken down once by Redis restart latency (documented in the production compose comment quoted in §5).
4. Redis maintainers treat multiple databases as legacy; they are unavailable in cluster mode, and `utils/campaignQueue.js:42-45` already documents that its Lua assumes a single non-clustered instance.

**Recommendation: separate container, and leave the URL path empty (DB 0).**

---

## 3. Bull `emailQueue` initialization

`backend/workprocess/queue.js` in full is quoted in §1b above for the connection half; the queue half is:

```js
const emailQueue = new Queue('emailQueue', {
  redis: redisOptions,

  // Safety net for any producer that adds a job without explicit opts. Bull
  // otherwise retains completed and failed jobs indefinitely, and each record
  // carries the full email payload including the HTML body.
  //
  // Note: routes/sendemails.js passes per-job opts, which take precedence over
  // these defaults — that call site is where send jobs get their retention.
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 5000
  }
});

emailQueue.on('error', (err) => { … });
emailQueue.on('ready', () => { … });

module.exports = emailQueue;
```
(`backend/workprocess/queue.js:62-86`)

| Aspect | Finding |
|---|---|
| Queue name | `'emailQueue'` — **hardcoded string literal**, not env-driven. Nothing in the repo can change it. |
| `prefix` | **Absent.** Also no `redis.keyPrefix`. Bull falls back to `'bull'` at `bull/lib/queue.js:138`. Key space is `bull:emailQueue:*`. **This is the crux and it is confirmed.** |
| `defaultJobOptions` | `removeOnComplete: 1000`, `removeOnFail: 5000`. No `attempts`/`backoff` at queue level. |
| Queue-level `limiter` | **None.** Rate limiting is done in the worker by `utils/emailRateLimiter.js` instead (see §4). |
| `settings` | Not overridden, so Bull defaults apply: `lockDuration: 30000`, `stalledInterval: 30000`, `maxStalledCount: 1` (`bull/lib/queue.js:225-234`). Relevant to `stop_grace_period` — see §5. |
| `skipVersionCheck` | Not set, so Bull eagerly connects `client` and runs an `INFO` version check at construction. |

### Per-job options (these override the defaults)

The only producer sets its own opts (`backend/routes/sendemails.js:1581-1611`):

```js
const opts = {
  removeOnComplete: true,
  removeOnFail: 5000,
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 }
};
```

plus, for paced campaigns, a computed `opts.delay = windowIndex * jobRateLimit.intervalMs` (`sendemails.js:1626-1629`) — so a paced campaign parks its backlog in Bull's **delayed set**, which can be hours deep. That matters for isolation: delayed jobs survive in Redis long after the request that created them.

The surrounding comment is also the best available evidence on Redis sizing:

> *"Was `false`, which retains every failed job in Redis forever. Each record carries the full payload including the HTML body, so on the production host this accumulated to ~301k keys / 8.36GB with maxmemory unset and a noeviction policy — Redis would have exhausted RAM rather than shed load."*
> (`backend/routes/sendemails.js:1584-1590`)

### Producers

**One**, and it is a bulk add:

```js
const chunk = jobs.slice(offset, offset + ENQUEUE_CHUNK_SIZE);   // ENQUEUE_CHUNK_SIZE = 1000
await emailQueue.addBulk(chunk);
```
(`backend/routes/sendemails.js:1694`)

There is **no plain `.add()` anywhere in the backend.** The enqueue loop re-checks `isCampaignStopped(redisClient, sessionId)` between chunks (`sendemails.js:1687-1690`), so the stop marker truncates the producer too.

Other queue reads from the web side:
- `emailQueue.getJobs([type], offset, offset + PURGE_PAGE_SIZE - 1)` — the stop path pages through `waiting`/`delayed` to purge them (`sendemails.js:730`).
- `emailQueue.getJobCounts()` — `/api/system-health` (`routes/system-health.js:40`).

### Consumer

**One**, in the worker:

```js
const CONCURRENCY = env.workerConcurrency;      // WORKER_CONCURRENCY, default 20
emailQueue.process(CONCURRENCY, async (job) => { … });
```
(`backend/workprocess/mailer.js:51`, `:674`)

`env.workerConcurrency = parsePositiveInt('WORKER_CONCURRENCY', 20)` (`config/env.js:…`), so the default is 20 jobs in flight per worker process.

### Event listeners / repeatables

| Listener | Location |
|---|---|
| `error`, `ready` | `workprocess/queue.js:78,83` |
| `completed`, `failed`, `error` | `workprocess/mailer.js:935,939,943` |

All are **local** (non-`global:`) events. There are **no repeatable/cron jobs**, **no `queue.add` with `repeat`**, and **no second `Queue` instance anywhere** — a repo-wide search for `new Queue` returns exactly one hit.

Shutdown: `await emailQueue.close()` (`mailer.js:955`), preceded by a `shuttingDown` flag that unparks jobs waiting on rate-limit capacity (`mailer.js:61-65`).

---

## 4. Other Redis databases, queues and key spaces

**No second Bull queue and no second Redis database.** But there are **eighteen non-Bull key spaces**, none of them namespaced by deployment.

| # | Purpose | Module (line) | Key pattern | Type | TTL | Client |
|---|---|---|---|---|---|---|
| 1 | Email job queue | `workprocess/queue.js:62` | `bull:emailQueue:*` (`wait`, `active`, `delayed`, `failed`, `<jobId>`, `id`, `stalled`, `lock`…) | mixed | per-job `removeOnComplete: true` / `removeOnFail: 5000` | Bull `client`/`bclient`/`eclient` |
| 2 | Bull internal pub/sub | `bull/lib/queue.js:539-548` | channel `bull:emailQueue:delayed` (+ pattern subs) | pub/sub | n/a | Bull `subscriber` |
| 3 | Rate limit — OTP request | `middleware/rateLimit.js:93` | `rl:otp:<email‖ip>` | string | 15 min window | shared |
| 4 | Rate limit — login | `middleware/rateLimit.js:110` | `rl:login:<email‖ip>` | string | 15 min window | shared |
| 5 | Rate limit — send | `middleware/rateLimit.js:138` | `rl:send:<ip>` | string | 60 s window | shared |
| 6 | Rate limit — monitoring | `middleware/rateLimit.js:163` | `rl:monitor:<ip>` | string | 60 s window | shared |
| 7 | Rate limit — global backstop | `middleware/rateLimit.js:190` | `rl:global:<ip>` | string | 60 s window | shared |
| 8 | Login OTP + attempt counter | `utils/otpStore.js:5-21` | `otp:login:<email>` | hash `{otp, attempts}` | **300 s** | shared |
| 9 | Recipient list | `routes/sendemails.js:116-132` | `recipients:<sessionId>` | list | sliding, `sessionKeyTtlSeconds()` | sendemails' own |
| 10 | Resume watermark | `routes/sendemails.js:226,279` | `sentIndex:<sessionId>` | string, advanced by Lua `RESERVE_SEND_WINDOW_SCRIPT` | sliding | sendemails' own |
| 11 | Per-send trail | `workprocess/mailer.js:429-433`, `utils/sessionKeys.js:98` | `emaillog:<sessionId>` | list | sliding | mailer's own |
| 12 | Live sent/failed tally | `utils/sessionKeys.js:102` | `emailstats:<sessionId>` | hash | sliding, same pipeline as #11 | mailer writes, web `HMGET`s |
| 13 | **Campaign stop marker** | `utils/campaignStop.js:116-120`, `sessionKeys.js:106` | `campaignstop:<sessionId>` | string (JSON), `SET … 'EX' …` | `sessionKeyTtlSeconds()` | both |
| 14 | Resend backlog | `utils/campaignStop.js:235-245` | `resend:<sessionId>` | list, capped `RESEND_MAX_LENGTH` | TTL re-asserted per append | both |
| 15 | Email send-rate buckets | `utils/emailRateLimiter.js:56,237` | `ratelimit:emailsend:<sessionId>` | sorted set, Lua `EVALSHA` (`ZREMRANGEBYSCORE`/`ZCARD`/`ZADD`) | self-expiring, one window of grace | mailer's own |
| 16 | Campaign lane queue (per user) | `utils/campaignQueue.js:49,115` | `campaignlane:<userId>` | list (`RPUSH`/`LRANGE`/`LREM`) | 6 h (`ACTIVE_TTL_SECONDS`) | shared |
| 17 | Active campaign claim | `utils/campaignQueue.js:50,119` | `campaignactive:<userId>` | string | 6 h | shared |
| 18 | Per-campaign slot state | `utils/campaignQueue.js:51,123` | `campaignslot:<campaignId>` | hash (`state`, `lastSeenMs`, `settledAt`…) | `slotTtlSeconds()` = `max(6h, min(sessionKeyTtl, 7d))` | shared |
| 19 | Retention sweep lock | `utils/dbCleanup.js:57,378` | `dbcleanup:lock` | string, `SET … 'PX' 600000 'NX'` | **10 min**, renewed every 2 min | shared |
| 20 | Retention sweep schedule | `utils/dbCleanup.js:59,563` | `dbcleanup:lastRunAt` | string (epoch ms) | **none** | shared |
| 21 | Campaign config cache (reader only) | `workprocess/mailer.js:532,545` | `campaign:<campaignRef>` | string (JSON) | n/a | mailer's own |

Notes on specific items the brief asked about:

**`express-rate-limit` + `rate-limit-redis`** — shares the singleton, and uses **five distinct prefixes** rather than one:

```js
function redisStore(prefix) {
  const client = getSharedRedisClient();
  return new RedisStore({
    prefix,
    sendCommand: (...args) => client.call(...args)
  });
}
```
(`middleware/rateLimit.js:55-62`). Prefixes: `rl:otp:`, `rl:login:`, `rl:send:`, `rl:monitor:`, `rl:global:`. Bucket layout is documented in the file header (5/15min OTP, 10/15min login, 60/min send, 600/min monitoring, 300/min global in production).

**`utils/emailRateLimiter.js`** — a sliding-window sorted set, and it *also* enforces the campaign stop atomically inside the same Lua script:

> *"The acquire script refuses to grant a slot once `campaignstop:<scope>` exists … taking a slot and confirming the campaign is still running become one indivisible Redis operation."* (`utils/emailRateLimiter.js:42-49`)

Scripts are registered as ioredis custom commands via `redis.defineCommand(...)` (`:227,231`), so `EVALSHA` is used with `EVAL` only on `NOSCRIPT`. It requires a genuine ioredis client (`:221-223`) — relevant only in that Bull's clients are never passed to it.

**`utils/otpStore.js`** — `otp:login:<lowercased email>`, a hash of `{otp, attempts}`, TTL 300 s, `MAX_ATTEMPTS = 5`. Written at `routes/auth.js:109`, read and cleared at `routes/auth.js:295-327`.

**`utils/sessionKeys.js`** — owns six session-scoped prefixes and the sliding TTL (`sessionKeyTtlSeconds() = env.dbCleanup.retentionSeconds * 4`, so **12 days** at the default `DB_CLEANUP_DAYS=3`). It performs `SCAN`-based sweeps — `adoptPersistentSessionKeys` (`:255-307`) and `dropAllEmailLogKeys` (`:318+`) — with this explicit warning:

> *"SCAN, never KEYS: KEYS blocks the single-threaded server for the whole keyspace, which on this deployment shares Redis with the Bull queue and the rate limiter."* (`utils/sessionKeys.js:251-254`)

These are **not** session/auth keys — auth is a JWT cookie; nothing session-auth-related is in Redis apart from the OTP.

**`utils/dbCleanup.js`** — yes, a Redis-based coordination lock, correctly implemented:

```js
const acquired = await redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');   // :378
// release: compare-and-delete
'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'   // :390
// renew: compare-and-pexpire
'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end'  // :403
```
Fencing token, compare-and-swap release, 10-minute TTL renewed every 2 minutes, plus `dbcleanup:lastRunAt` so four cluster instances do not each sweep per interval (`:416-440`). **This lock is global per Redis instance, not per deployment.**

**`routes/system-health.js`** — reports **Bull job counts only** (`emailQueue.getJobCounts()`, `:40`). It does **not** `PING` Redis and does **not** report Redis memory/stats. Consequence: there is no Redis health signal in the app, so an unreachable Redis is invisible to the health endpoint and to any container healthcheck built on it.

**Pub/sub, `KEYS`, Lua, `INCR`** — no application-level `publish`/`subscribe` (only Bull's internal). No `KEYS`, no `FLUSHDB`/`FLUSHALL`. Lua in three places: `emailRateLimiter.js` (acquire + window-state), `campaignQueue.js` (claim/release/prune), `dbCleanup.js` (lock release/renew), plus `sendemails.js` `RESERVE_SEND_WINDOW_SCRIPT`. Counters: `HINCRBY` on `otp:login:*` attempts and on `emailstats:*` sent/failed.

### What would collide if Opterite shared the existing Redis

Every single row in the table above, because both deployments run the same code and therefore generate the same key names. The user-visible symptoms, concretely:

| Colliding key space | User-visible symptom |
|---|---|
| `bull:emailQueue:*` | **The headline failure: duplicate email to real recipients.** Opterite's workers `BRPOPLPUSH` production's jobs off the same `wait` list. A job consumed by Opterite is sent with Opterite's SMTP/limiter context, then marked complete in a keyspace production's `/status` reads — production reports progress it did not make, Opterite reports sends it never queued. Jobs stalled across the two worker fleets get redelivered once `maxStalledCount: 1` trips, producing a genuine second delivery to a live recipient. |
| `bull:emailQueue:*` purge path | `routes/sendemails.js:730` pages `waiting`/`delayed` jobs during a Stop. Stopping a campaign in Opterite would **delete queued production jobs**, silently abandoning real recipients. |
| `campaignstop:<sessionId>` | **Wrong campaign stopped, or a campaign that cannot send.** Session ids are recipient-file ids / `test-<timestamp>`; a `test-…` collision is entirely plausible. An Opterite stop marker blocks production's limiter (`emailRateLimiter.js` checks the key inside the acquire script), so production sending halts with recipients left pending and no visible cause. |
| `sentIndex:<sessionId>` | **Skipped recipients.** The watermark is advanced by Lua reservation. Two deployments reserving from one counter means each sees ranges it never enqueued — recipients are counted as handled and never sent. |
| `recipients:<sessionId>` | One deployment's upload overwrites the other's list (`storeRecipients` does `DEL` then `RPUSH`, `sendemails.js:116-123`) → "no valid recipients", or sending to the *other* tenant's address list. |
| `emaillog:` / `emailstats:<sessionId>` | Progress bars and live tallies mix the two deployments. `/status` shows sends nobody in that UI submitted. |
| `otp:login:<email>` | **Cross-deployment auth bleed.** An OTP requested on `opterite.in` validates on the production domain and vice versa (same `AUTHORIZED_USERS` emails are likely). The 5-attempt counter is also shared, so one side's failures lock out the other's login. |
| `rl:otp:` / `rl:login:` / `rl:send:` / `rl:monitor:` / `rl:global:` | Shared buckets. Opterite's polling consumes production's allowance; production operators get 429s on `/send-email`. This is the *exact* failure the file header documents as having caused a ~55 s production sending outage. |
| `ratelimit:emailsend:<sessionId>` | Both deployments draw slots from one bucket → the configured provider rate is enforced across both, so each sends at roughly half its configured rate, with no indication why. |
| `campaignlane:` / `campaignactive:` / `campaignslot:` | Keyed by `userId` and `campaignId`. Same operators on both → Opterite's campaign holds the lane and **blocks production campaigns from starting**, or an Opterite release promotes a production campaign. |
| `dbcleanup:lock` + `dbcleanup:lastRunAt` | **Retention stops running.** Whichever deployment sweeps first writes `lastRunAt`; the other then skips every interval (`isSweepDue`, `:427-440`). Mongo and disk grow unbounded on one side. Worse: the sweep calls `dropSessionKeys`, so one deployment's sweep can delete the other's live campaign keys. |
| Shared `maxmemory` ceiling | Production already hit 8.36 GB once. Adding Opterite's jobs under a `noeviction` 8 GB cap means `addBulk()` starts throwing for **both** deployments at the same moment. |
| Shared `SCAN` sweeps + Lua | `adoptPersistentSessionKeys` walks up to 50,000 keys; two deployments doing it against one single-threaded server adds latency to production's ~700 concurrent senders. |

---

## 5. Proposed Opterite Redis service for Docker Compose

### Precedent: the existing production block (read-only `cat`, unmodified)

```yaml
  redis:
    image: redis:7.4-alpine
    restart: unless-stopped
    command:
      - redis-server
      - --appendonly
      - "yes"
      - --maxmemory
      - 8gb
      - --maxmemory-policy
      - noeviction
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    logging: *logging
```
(`/opt/bulk-email-docker/docker-compose.prod.yml`, `redis:` service)

Its own comments are worth preserving as rationale:

> *"appendonly keeps queued jobs across a restart. Without it, restarting Redis silently drops every pending send."*
> *"maxmemory is a blast-radius guard, not a tuning knob. The host Redis ran with no ceiling and grew to 8.36GB (4.6GB AOF), which made every restart spend minutes in LOADING state and took the site down."*
> *"noeviction is deliberate: this is a work queue, not a cache. Evicting keys would silently discard queued sends. At the ceiling, writes are refused, so emailQueue.addBulk() throws and the request returns an error the operator can see, rather than losing jobs quietly."*

**The precedent is already correct on the dangerous setting.** No evicting policy to flag.

### Proposed Opterite service

```yaml
# docker-compose.yml  (Opterite — separate compose project: name: opterite)
name: opterite

services:
  opterite-redis:
    image: redis:7.4-alpine
    container_name: opterite-redis
    restart: unless-stopped
    command:
      - redis-server
      - --appendonly
      - "yes"
      - --appendfsync
      - everysec
      - --maxmemory
      - 2gb
      - --maxmemory-policy
      - noeviction
    volumes:
      - opterite-redis-data:/data
    networks:
      - default            # == opterite_default, the ONLY network
    expose:
      - "6379"             # documentation only; no host port published
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 10s
    stop_grace_period: 30s
    logging: *logging

  opterite-backend:
    # … build/image …
    restart: unless-stopped
    init: true
    env_file: [.env]
    environment:
      NODE_ENV: production
      REDIS_URL: redis://opterite-redis:6379
      TRUST_PROXY: "2"
    depends_on:
      opterite-redis:
        condition: service_healthy
    networks: [default]
    expose: ["3000"]

  opterite-worker:
    # … same image, command: ["node", "workprocess/mailer.js"] …
    restart: unless-stopped
    init: true
    env_file: [.env]
    environment:
      NODE_ENV: production
      REDIS_URL: redis://opterite-redis:6379
    depends_on:
      opterite-redis:
        condition: service_healthy
    networks: [default]
    stop_grace_period: 60s
    healthcheck:
      disable: true

networks:
  default:
    name: opterite_default      # explicit; never bulk-email-sender_default

volumes:
  opterite-redis-data:
```

### Line-by-line justification

**`image: redis:7.4-alpine`** — match the precedent. Bull 4 needs ≥ 5.0 (`MINIMUM_REDIS_VERSION`, enforced by the eager version check at `bull/lib/queue.js:200-216`), so 7.4 is comfortably fine, and running the same tag means one mental model and one upgrade decision for the host. Pinned to the minor, as the existing stack does.

**`--appendonly yes` — yes, durability is warranted.** Bull job state *is* the pending-send backlog, and this app leans on Redis for more than the queue:
- A paced campaign parks hours of work in Bull's delayed set (`sendemails.js:1626-1629`).
- `recipients:<id>` is the only copy of the validated address list consulted at send time (`sendemails.js:115-133`).
- `sentIndex:<id>` is the resume watermark — losing it re-sends or skips.
- `resend:<id>` holds recipients deliberately rescued from a stop (`campaignStop.js:217-247`).

Losing those means in-flight campaigns are irrecoverable from Redis; Mongo has the *outcomes* but not the queue. `--appendfsync everysec` (the Redis default) is added explicitly so the durability window is stated rather than assumed — at most one second of writes lost on an unclean stop. RDB snapshotting is left at the image default alongside AOF.

**`--maxmemory 2gb`** — same blast-radius reasoning as production, scaled down. Opterite is a new deployment with no established volume, and the production figure of 8 GB was sized for a host that had already run away to 8.36 GB *before* `removeOnFail` was bounded. With `removeOnComplete: true` and `removeOnFail: 5000` now in force (`sendemails.js:1582-1593`), 2 GB is generous headroom while leaving the existing 8 GB Redis its share of host RAM. **This number is a judgement call the operator should confirm against the host's free memory** — the two Redis instances plus 12 app containers now share it.

**`--maxmemory-policy noeviction`** — **non-negotiable.** Bull keys are work, not cache. Any LRU/LFU policy can evict a job hash, a `wait` list entry or a lock, which corrupts the queue silently: the job vanishes, the recipient is already counted in `sentIndex`, and nothing errors. With `noeviction`, hitting the ceiling makes `addBulk()` throw and surfaces as a visible failure. `recipients:`/`sentIndex:`/`resend:` are equally non-evictable for the same reason.

**`restart: unless-stopped`** — matches the brief and the existing stack; survives host reboot, respects a deliberate manual stop.

**`healthcheck` + `depends_on: condition: service_healthy`** — **yes, both app services should declare it.** `config/redis.js` sets `lazyConnect: false`, so the client connects at require time, and `workprocess/queue.js`'s Bull constructor connects eagerly too. Without gating, a cold `up -d` has the backend racing Redis' AOF load; `retryStrategy` would recover, but gating turns a noisy startup into a clean one. `start_period: 10s` added because AOF load on a populated volume can take a moment and should not burn retries. Interval/timeout/retries copied from the precedent (10s/3s/5 → unhealthy after ~50s).

**`networks: [default]` with `networks.default.name: opterite_default`** — one network, declared explicitly so Compose cannot be talked into attaching anything else. **`opterite-redis` must never join `bulk-email-sender_default`.** Note the related constraint from the earlier inspection: the production Caddyfile uses `dynamic a { name web }`, which resolves the bare name `web` on the shared network and load-balances onto every A record. Hence no Opterite service may be named or aliased `web`, `worker`, `redis` or `caddy` on the shared network. `opterite-redis` avoids the `redis` alias entirely, which is why it does not even need to be on the shared network — only `opterite-backend` does, and only so Caddy can reach it.

**No published host ports.** `expose: ["6379"]` is documentation; it opens nothing on the host. Confirmed that the backend reaches Redis purely by container DNS: the address comes only from `REDIS_URL` (§2), and Docker's embedded DNS resolves the service name `opterite-redis` on `opterite_default`. Nothing in the code needs a host port, and publishing one would expose an unauthenticated Redis to the internet on a VPS with no host firewall confirmed.

**`REDIS_URL: redis://opterite-redis:6379`** — the URL form is the *only* form the code reads (§2). Three requirements:
1. **The explicit `:6379` is mandatory.** `workprocess/queue.js:47` does `port: Number(redisUrl.port)`; an omitted port gives `port: 0`, and Bull's `_.defaults` (`bull/lib/queue.js:130`) will not replace `0`. Omitting the port breaks the queue while the rest of the app (ioredis-parsed) connects fine — a maddening half-broken state.
2. **No `/db` path.** Database 0, so the comment at `queue.js:20-32` about the two halves disagreeing is moot.
3. **It must be in the compose `environment:` block, not left to `.env`.** `backend/.env` ships `REDIS_URL=redis://127.0.0.1:6379`, which inside a container resolves to the container itself and fails. `config/loadEnv.js:35-40` documents that real environment variables beat both `.env` files — this is exactly the mechanism the production stack already relies on, and it must be reused.

Both `opterite-backend` and `opterite-worker` need the identical value: the worker reads `REDIS_URL` through the same `config/loadEnv` → `config/env` → `config/redis.js` path, and `workprocess/queue.js` reads `process.env.REDIS_URL` directly.

**Password: recommend NOT setting one, with the tradeoff stated.**
- *For leaving it open:* Redis is on a private bridge network with no published port and no `--bind` exposure to the host. Only containers attached to `opterite_default` can reach it. This is the conventional posture and it is what the existing production Redis already does — consistency has operational value.
- *Against:* any container later attached to `opterite_default` gets unauthenticated full access, including `FLUSHALL` and `CONFIG`. A `--requirepass` is defence in depth if the network is ever widened.
- **The deciding factor is a code defect:** `workprocess/queue.js:48` passes `redisUrl.password`, and the WHATWG `URL` getter returns the **percent-encoded** form, while `config/redis.js` hands the raw URL to ioredis, which **decodes** it. A password containing `@`, `:`, `/`, `#` or `%` would therefore authenticate correctly for the app client and fail for Bull. If a password is wanted anyway, restrict it to `[A-Za-z0-9]` so the two paths agree, and expect the URL in the report/logs as `redis://:***@opterite-redis:6379`.

**`stop_grace_period`.**
- On `opterite-redis`: `30s`, so a `SHUTDOWN` has time to fsync the AOF rather than being `SIGKILL`ed mid-write.
- On `opterite-worker`: **`60s`, copied from production, and this one is load-bearing.** The production comment explains precisely why 10s (the Compose default) is dangerous:

  > *"a job killed after its SMTP accept but before Bull recorded the completion still holds a lock, and Bull redelivers it once the lock expires — sending that recipient a second time. Buffered outcomes not yet flushed would also be lost, under-reporting sentCount."*

  That matches the code: `mailer.js:955` awaits `emailQueue.close()` (which waits for active jobs) and then `BatchLogger.drain()` flushes buffered outcomes to Mongo. Bull's default `lockDuration: 30000` is what makes a cut-short drain into a duplicate send. Opterite inherits the same risk and needs the same 60s.
- Ordering note: the worker should drain **before** Redis goes away. Compose stops in reverse dependency order, and `depends_on` on `opterite-redis` gives that for free.

**Service naming.** `opterite-redis` satisfies the constraint that the name must not be `redis`. **Confirmed not a blocker:** no Redis hostname is hardcoded in any source file. A repo-wide search found the literal `redis` host only in the *production compose file's* `environment: REDIS_URL: redis://redis:6379` — configuration, not code. One caveat worth knowing: `utils/campaignQueue.js:42-45` notes its Lua builds keys by concatenation and so assumes a single, non-clustered instance. A single `opterite-redis` container satisfies that.

---

## Verification that isolation is complete

Read-only commands, to be run **after** Opterite is up. Not executed as part of this inspection.

```bash
# 1. opterite-redis is on exactly one network, and it is opterite_default.
docker inspect opterite-redis \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\n"}}{{end}}'
#   expect: a single line, "opterite_default <ip>"

# 2. No Opterite container is attached to the production network.
docker network inspect bulk-email-sender_default \
  --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
#   expect: only bulk-email-sender-* containers, plus opterite-backend ONLY if the
#           shared-network bridge for Caddy was adopted — and never opterite-redis/worker.

# 3. Nothing in the Opterite stack publishes a Redis host port.
docker ps --filter name=opterite --format '{{.Names}}\t{{.Ports}}'
#   expect: no "0.0.0.0:6379->" or ":::6379->" anywhere

# 4. The Opterite backend cannot resolve the production alias `redis`.
docker exec opterite-backend getent hosts redis || echo "redis does not resolve — correct"
#   expect: the failure branch. If it DOES resolve, the container is on the shared
#           network and REDIS_URL is one typo away from production.

# 5. The Opterite backend resolves opterite-redis and nothing else.
docker exec opterite-backend getent hosts opterite-redis

# 6. Confirm the effective REDIS_URL inside each Opterite container.
docker inspect opterite-backend --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^REDIS_URL='
docker inspect opterite-worker  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^REDIS_URL='
#   expect exactly: REDIS_URL=redis://opterite-redis:6379   (explicit port, no /db path)

# 7. Production Redis client list shows no new peers.
#    Baseline this BEFORE starting Opterite, then re-run and diff.
docker exec bulk-email-sender-redis-1 redis-cli client list | awk '{print $2}' | sort | uniq -c
#    Opterite's container subnet must not appear. Expected peers: 4 web x 3 + 8 worker x 4 = 44.

# 8. Production Redis connected-client count is unchanged.
docker exec bulk-email-sender-redis-1 redis-cli info clients | grep -E 'connected_clients'

# 9. Production Bull keyspace has exactly one producer's worth of jobs.
docker exec bulk-email-sender-redis-1 redis-cli --scan --pattern 'bull:emailQueue:*' --count 100 | wc -l
docker exec bulk-email-sender-redis-1 redis-cli llen bull:emailQueue:wait
#    Baseline before, compare after. Opterite activity must not move these.

# 10. The two keyspaces are genuinely separate: each instance sees only its own keys.
docker exec opterite-redis redis-cli dbsize
docker exec bulk-email-sender-redis-1 redis-cli dbsize
docker exec opterite-redis redis-cli --scan --pattern 'bull:emailQueue:*' --count 100 | head
#    Opterite's bull keys exist in opterite-redis and its counts move independently.

# 11. Opterite's Redis has the right safety settings.
docker exec opterite-redis redis-cli config get maxmemory-policy   # expect: noeviction
docker exec opterite-redis redis-cli config get appendonly         # expect: yes
docker exec opterite-redis redis-cli config get maxmemory

# 12. Production containers are still healthy and were never restarted.
docker ps --filter name=bulk-email-sender --format '{{.Names}}\t{{.Status}}'
docker inspect bulk-email-sender-redis-1 --format '{{.State.StartedAt}} {{.RestartCount}}'
```

Note on #7–#9: these touch the production Redis with read-only commands. `client list`, `info`, `dbsize` and `llen` are O(1) or O(clients) and safe. `--scan` is explicitly used instead of `KEYS`, for the reason `utils/sessionKeys.js:251-254` gives. Run them during a quiet period regardless.

---

## Gaps and risks

**Could not be determined from the code**

1. **Who writes `campaign:<campaignRef>`.** `workprocess/mailer.js:532-653` *reads* that key and supports a compact job format keyed on it, but a repo-wide search found **no writer** in this revision. Either it is a forward-compatibility path for a producer not yet shipped, or the writer lives outside the backend. Either way it adds no new Redis configuration requirement; noted so nobody assumes the compact path is live.
2. **Host memory budget.** `--maxmemory 2gb` for Opterite is a judgement call. The existing Redis is capped at 8 GB and the earlier inspection noted 62 GB of host RAM, but current free memory and the combined footprint of 12-ish new containers was not measured. **The operator should confirm the number.**
3. **Opterite's intended scale.** The proposal assumes replica counts in the same ballpark as production (4 web / 8 worker). If Opterite runs fewer workers, `WORKER_CONCURRENCY` and the maxmemory figure can both come down.
4. **Whether `.env.example` exists.** `config/env.js:473` tells the operator to "See .env.example for the full list of required variables", but no such file is in the repo. Not Redis-specific; it will bite whoever hand-writes `/opt/opterite/.env`.
5. **The test suite is deleted in the working tree.** `backend/package.json` declares `"test": "node --test --test-force-exit --test-concurrency=1 \"tests/**/*.test.js\""`, and 21 test files including `backend/tests/helpers/testDb.js` exist in git `HEAD` but show as `D` (deleted) in `git status`. So `npm test` currently cannot run. Whether that deletion is intentional is a question for the user; it is unrelated to Redis isolation but it does mean **no automated check would catch the `port: 0` or percent-encoded-password defects below.**

**Risks the operator must decide on**

6. **`REDIS_URL` must carry an explicit port.** Flagged twice because it is the single most likely way to get a half-broken Opterite: the app connects, the queue does not, and the error is a connection refused to port 0. If a code fix is ever wanted, the one-line change is `port: Number(redisUrl.port) || 6379` in `workprocess/queue.js:47`. **Not implemented here** — this inspection is read-only.
7. **Percent-encoded password mismatch** between `workprocess/queue.js:48` (encoded) and `config/redis.js:12` (ioredis-decoded). Avoided entirely by setting no password, which is the recommendation. If a password is set, keep it alphanumeric.
8. **No Redis health signal in the app.** `routes/system-health.js` reports Bull job counts but never pings Redis, and `config/redis.js`'s `retryStrategy` gives up permanently after ~30 attempts. A long Redis outage can leave a *running* backend container with a dead Redis client and a passing HTTP healthcheck. Worth knowing; outside this issue's scope to fix.
9. **The 12-day sliding TTL on session keys** (`DB_CLEANUP_DAYS × 4`) applies to Opterite's Redis too, so its volume will accumulate `recipients:`/`emaillog:` data for roughly that long. Factor into the maxmemory decision.
10. **Nothing in the deployment enforces network separation.** The only thing keeping Opterite off production's Redis is the value of one environment variable plus network topology. Checks #1, #4 and #6 in the verification list are the standing guard; run them after every Opterite deploy, not just the first.
