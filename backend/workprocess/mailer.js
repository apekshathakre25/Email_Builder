require('dotenv').config();

const env = require('../config/env');
const emailQueue = require('./queue');
const nodemailer = require('nodemailer');
const createRedisClient = require('../config/redis');
const client = createRedisClient();
const EmailLog = require('../models/EmailLog');
const EmailLogEntry = require('../models/EmailLogEntry');
const UploadedFile = require('../models/UploadedFile');
const ImapTestResult = require('../models/ImapTestResult');
const { generateMessageId } = require('../utils/messageIdGenerator');
const { convert: convertHtmlToText } = require('html-to-text');
const {
  getInboxPattern,
  isInboxPatternHeaderBlocked
} = require('../config/inboxPatterns');
const {
  InboxPatternRenderError,
  renderInboxPattern
} = require('../services/inboxPatternRenderer');
const logger = require('../utils/logger');
const { sessionKeyTtlSeconds, emailStatsKeyForLogKey } = require('../utils/sessionKeys');
const {
  createEmailRateLimiter,
  normalizeJobRateLimit,
  RateLimitWaitAbortedError,
  CampaignStoppedError
} = require('../utils/emailRateLimiter');
const { isCampaignStopped, queueForResend } = require('../utils/campaignStop');

const mongoose = require('mongoose');
const connectMongoDB = require('../config/mongodb');

connectMongoDB();

if (env.isProduction) {
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};

}

const CONCURRENCY = env.workerConcurrency;

logger.force(`🚀 Email worker started with concurrency: ${CONCURRENCY}`);
logger.force(`📧 This worker can process ${CONCURRENCY} emails simultaneously`);

const log = logger.log;
const logError = logger.error;

/**
 * Declared here rather than beside shutdown() because waitForSendSlot polls it:
 * a job parked waiting for rate-limit capacity has to notice SIGTERM, otherwise
 * emailQueue.close() would block on it until PM2's kill_timeout expires.
 */
let shuttingDown = false;

/**
 * The shared send-rate limiter.
 *
 * Backed by the same Redis this worker already uses, so the bucket is common to
 * every worker process. That is the whole point: at the default
 * WORKER_INSTANCES=14 × WORKER_CONCURRENCY=50 there are ~700 concurrent sends
 * across 14 OS processes, and a per-process counter would enforce 14× the
 * configured rate.
 */
const emailRateLimiter = createEmailRateLimiter(client);

/**
 * Blocks until this send is allowed, or throws if it must be abandoned.
 *
 * Called immediately before transporter.sendMail so that the slot is consumed by
 * an actual delivery attempt and nothing else. Two consequences worth stating:
 *
 *  - A Bull retry re-enters the handler and therefore acquires a fresh slot, so
 *    retries are counted against the rate like any other send rather than
 *    slipping past it.
 *  - A job that fails before this point (unresolvable campaign config, bad
 *    payload) never consumes capacity, so failures do not eat the allowance.
 */
async function waitForSendSlot(rateLimit, email) {
  const outcome = await emailRateLimiter.waitForSlot(rateLimit, {
    shouldAbort: () => (shuttingDown ? 'worker is shutting down' : false)
  });

  if (outcome.waitedMs > 0) {
    log(`Rate limit: waited ${outcome.waitedMs}ms for capacity before sending to ${email}`);
  }

  return outcome;
}

/**
 * Refuses to proceed if the operator has stopped this campaign.
 *
 * This is the gate that covers *unpaced* campaigns. When the operator leaves the
 * interval empty there is no rate limit on the job, so waitForSendSlot is never
 * called and the atomic stop check inside the limiter's acquire script never runs.
 * Without this, a stop would be enforced only for paced campaigns — the worker
 * would keep delivering the entire queued backlog of an unpaced one while the UI
 * reported it stopped, which is the exact failure mode this must not have.
 *
 * Paced campaigns are checked here too. That is not redundant: it saves parking a
 * job slot in waitForSlot for a campaign that is already stopped, and it means the
 * decision to skip is made before any window capacity is touched. The limiter's
 * check remains the authoritative one, because only it is atomic with consuming a
 * slot.
 *
 * One Redis EXISTS per email. Negligible beside an SMTP round trip, and
 * deliberately not cached: a cache TTL would become stop latency, and "the stop
 * takes effect a second late" is the thing being fixed, not a tolerable cost.
 */
async function assertCampaignNotStopped(sessionId, jobId) {
  if (!sessionId) return;

  let stopped;
  try {
    stopped = await isCampaignStopped(client, sessionId);
  } catch (err) {
    // Fail open, loudly. Redis being unreachable already means the limiter and the
    // queue itself are in trouble, and refusing to send on a read error would turn
    // a transient blip into every recipient of every campaign being skipped.
    logger.warn(
      `⚠️  Job ${jobId}: could not read stop state for ${sessionId} (${err.message}); ` +
      'proceeding with the send.'
    );
    return;
  }

  if (stopped) throw new CampaignStoppedError(sessionId);
}

/**
 * Puts a single send back in line after its job was discarded by a stop.
 *
 * Necessary because `sentIndex:<id>` — the campaign's only resume position — was
 * advanced when this recipient was *enqueued*, so the next send would otherwise
 * start past it and this send would never happen. It cannot simply be rewound:
 * recipients settle out of order under concurrency, so no single index separates
 * "attempted" from "not attempted".
 *
 * `sendId` identifies the send, not the recipient. A campaign may legitimately owe
 * the same address several emails — a recipient list holds one entry per send — and
 * each has to be queued and resumed on its own. It also lets the drain recognise
 * this same send if it gets recorded twice, which happens when a stop races the
 * purge: see resendIdentity() in utils/campaignStop.
 *
 * The job was never handed to a mail server, so re-sending it cannot duplicate a
 * delivery, and /send-email drains this list before anything else on the next
 * submission.
 */
async function requeueStoppedRecipient(sessionId, email, sourceFile, sendId) {
  if (!sessionId || !email) return;

  try {
    await queueForResend(client, sessionId, [{ email, sourceFile, sendId }]);
  } catch (err) {
    // Logged at force level: this is the one case where a failure silently loses a
    // recipient, so it must be visible even with production logging turned down.
    logger.force(
      `⚠️  Campaign ${sessionId} stopped, but ${email} could not be queued for resend ` +
      `(${err.message}). It will show as pending; re-select the file to send it.`
    );
  }
}

const TEMPLATE_PATTERNS = {
  fromName: /\{\{FromName\}\}/g,
  toEmail: /\{\{ToEmail\}\}/g,
  subjectLine: /\{\{SubjectLine\}\}/g,
  fromEmail: /\{\{FromEmail\}\}/g,
  messageId: /\{\{MessageId\}\}/g,
  rfcDate: /\[\[RFC_Date_EST\]\]/g
};

/**
 * Buffers per-email outcomes and folds them into MongoDB in batches.
 *
 * This is the *durable* record only. It is not what the UI reads for live
 * progress — see appendToLogKey, which tallies each send into Redis as it
 * happens. That split is deliberate: batching one `$inc` per 100 emails instead
 * of one per email is what keeps MongoDB writable at
 * WORKER_INSTANCES × WORKER_CONCURRENCY concurrent sends, and the cost of it is a
 * counter that lags by up to `flushInterval`. Redis absorbs that cost for the UI
 * so this can stay batched.
 */
class BatchLogger {
  constructor(flushInterval = 2000, batchSize = 100) {
    this.buffers = new Map();
    this.flushInterval = flushInterval;
    this.batchSize = batchSize;
    this.isFlushing = false;

    // The handle is kept so drain() can stop the timer at shutdown; previously it
    // was discarded and the interval ran until the process died. unref() so this
    // timer alone cannot hold the event loop open after the queue, MongoDB and
    // Redis have all closed.
    this.timer = setInterval(() => this.flushAll(), this.flushInterval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async addLog(campaignId, type, email, error = null, originalSessionId = null, sendId = null) {
    if (!campaignId) return;

    const fileId = originalSessionId || campaignId;
    const bufferKey = `${campaignId}:${fileId}`;

    if (!this.buffers.has(bufferKey)) {
      this.buffers.set(bufferKey, {
        campaignId: campaignId,
        fileId: fileId,
        sentCount: 0,
        failedCount: 0,
        entries: [],
        lastUpdated: Date.now()
      });
    }

    const buffer = this.buffers.get(bufferKey);

    if (type === 'sent') {
      buffer.sentCount++;
    } else {
      buffer.failedCount++;
    }

    buffer.entries.push({
      email,
      // Which of this recipient's sends this row is. Lets a duplicated address be
      // reconciled occurrence by occurrence instead of by counting rows. Omitted
      // rather than stored empty for jobs that predate it, so old rows are
      // distinguishable from rows whose id is genuinely unknown.
      ...(sendId ? { sendId } : {}),
      status: type,
      error: error,
      time: new Date()
    });

    if (buffer.entries.length >= this.batchSize) {
      await this.flush(bufferKey);
    }
  }

  async flush(bufferKey) {
    const buffer = this.buffers.get(bufferKey);
    if (!buffer || (buffer.sentCount === 0 && buffer.failedCount === 0)) return;

    this.buffers.delete(bufferKey);

    const { campaignId, fileId } = buffer;

    let lastError = '';
    if (buffer.failedCount > 0) {
      const lastFailedEntry = [...buffer.entries].reverse().find(e => e.status === 'failed');
      if (lastFailedEntry) lastError = lastFailedEntry.error;
    }

    // Counters before entries, on purpose.
    //
    // These two writes used to run the other way round, which put the counter
    // every progress view reads behind an insertMany of one document per email —
    // the heaviest write in the flush, and the one most likely to be slow or to
    // fail under load. Ordering it first means a struggling `emaillogentries`
    // collection can no longer hold up or discard the tallies, and the failure
    // mode degrades to a missing log row rather than a campaign that under-reports
    // what it sent. They are separately guarded for the same reason.
    try {
      const emailLogUpdate = {
        $inc: {
          sentCount: buffer.sentCount,
          failedCount: buffer.failedCount,
          pendingCount: -(buffer.sentCount + buffer.failedCount)
        },
        $set: { updatedAt: new Date() }
      };

      if (lastError) {
        emailLogUpdate.$set.lastError = lastError;
      }

      await EmailLog.updateOne({ sessionId: campaignId }, emailLogUpdate);

      // Mark the campaign finished once nothing is pending.
      //
      // Nothing did this before. models/EmailLog.js declares an addEntry() method
      // that sets status='completed' and completedAt, but it has no callers — this
      // flush is what actually maintains the counters, and it only ever touched
      // $inc and updatedAt. Every campaign therefore stayed 'in_progress' forever.
      //
      // That is not cosmetic. utils/dbCleanup.js protects in_progress campaigns
      // from the retention sweep for 4x the retention window, so finished
      // campaigns were being retained for 12 days instead of 3, and each one was
      // added to the $nin exclusion list applied to every emaillogentries delete.
      // In production that list reached 6,404 session ids, of which 6,377 were
      // one-off test-* sends, and the sweep deleted 0 entries as a result.
      //
      // Expressed as a filtered update rather than a read-back: the condition is
      // evaluated server-side against the document this flush just wrote, so it is
      // atomic with respect to other workers flushing the same campaign and costs
      // no extra round trip to fetch state.
      //
      // `status: 'in_progress'` in the filter is deliberate — it makes this a
      // one-way transition and means a 'stopped' campaign is never silently
      // reopened or completed behind the operator's back.
      await EmailLog.updateOne(
        { sessionId: campaignId, status: 'in_progress', pendingCount: { $lte: 0 } },
        { $set: { status: 'completed', completedAt: new Date() } }
      );

      await UploadedFile.findOneAndUpdate(
        { sessionId: fileId },
        {
          $inc: {
            sentEmails: buffer.sentCount,
            failedEmails: buffer.failedCount,
            pendingEmails: -(buffer.sentCount + buffer.failedCount)
          }
        }
      );
    } catch (err) {
      logger.error('❌ Failed to flush batch counters:', err.message);
    }

    try {
      const entriesToInsert = buffer.entries.map(entry => ({
        ...entry,
        sessionId: fileId,
        campaignId: campaignId
      }));

      await EmailLogEntry.insertMany(entriesToInsert);
    } catch (err) {
      logger.error('❌ Failed to flush batch log entries:', err.message);
    }
  }

  /**
   * Drains every buffer. Skips the run if one is already in progress.
   *
   * The `try/finally` is load-bearing. `isFlushing` was previously cleared by a
   * plain assignment after the loop, so anything thrown between setting and
   * clearing it — flush() itself is guarded, but the Map iteration, the logger or
   * an out-of-memory condition are not — latched the flag at true permanently and
   * silently retired this worker's flushing for the rest of the process's life.
   * The symptom was not a lagging count but a count that stopped moving
   * altogether and never recovered until a restart.
   */
  async flushAll() {
    if (this.isFlushing) return;
    this.isFlushing = true;

    try {
      const sessIds = Array.from(this.buffers.keys());
      for (const sid of sessIds) {
        await this.flush(sid);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Final drain for shutdown. Stops the timer, waits out any in-flight flush,
   * then empties what is left.
   *
   * flushAll() alone is not enough here: its skip-if-busy guard would return
   * immediately if the interval happened to be mid-flush, and shutdown would
   * carry on and close the MongoDB connection underneath it. Waiting first is
   * what makes the last batch land.
   *
   * Without this, every deploy silently discarded up to `flushInterval` of
   * buffered outcomes per worker process, so `sentCount` under-reported a little
   * more after each restart. The Redis tally was never affected — it is written
   * per email — so this closes a gap between the two records as much as it
   * prevents the loss.
   */
  async drain({ timeoutMs = 5000 } = {}) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const deadline = Date.now() + timeoutMs;
    while (this.isFlushing && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    // Deliberately runs even if the wait timed out: a stuck flush has already
    // removed its own buffer from the Map, so this can only pick up what it left
    // behind, and losing those is the thing being prevented.
    this.isFlushing = false;
    await this.flushAll();
  }
}

const batchLogger = new BatchLogger();

/**
 * Appends one outcome to the session's Redis trail and bumps its live tally,
 * always with an expiry.
 *
 * The worker is what creates `emaillog:<sessionId>`, so the TTL has to be applied
 * here. Setting it from the enqueue side instead would race: EXPIRE on a key that
 * does not exist yet is a no-op, so a worker that pushed first would leave the
 * key persistent forever.
 *
 * Everything is pipelined, so this still costs the single round trip the bare
 * RPUSH did. RPUSH on its own preserves an existing TTL, but re-asserting it also
 * makes the trail of a long campaign slide instead of expiring mid-send.
 *
 * The HINCRBY is what /status actually reports as "Sent". It lives here, next to
 * the trail, rather than in BatchLogger, because this function runs once per
 * email at the moment the send resolves, whereas BatchLogger deliberately
 * buffers: MongoDB's `sentCount` cannot move faster than the 2s flush, and with
 * WORKER_INSTANCES worker processes each holding an independent buffer it moves
 * as that many unsynchronised step functions. That batching is right for the
 * durable record and wrong for a live counter, so the live counter is kept here
 * and MongoDB keeps its own tally for history.
 */
async function appendToLogKey(logKey, entry) {
  const ttl = sessionKeyTtlSeconds();
  const statsKey = emailStatsKeyForLogKey(logKey);

  const pipeline = client
    .pipeline()
    .rpush(logKey, JSON.stringify(entry))
    .expire(logKey, ttl);

  // Null only for a malformed or missing logKey, which the caller already guards
  // against. Skipping the tally is the right failure mode: /status falls back to
  // the MongoDB counters and reports a lagging number rather than a wrong one.
  if (statsKey) {
    pipeline
      .hincrby(statsKey, entry.status === 'failed' ? 'failed' : 'sent', 1)
      .expire(statsKey, ttl);
  }

  await pipeline.exec();
}

const transporterCache = new Map();

function getTransporter(smtp) {
  const key = JSON.stringify(smtp);

  if (!transporterCache.has(key)) {
    log('Creating new SMTP transporter with connection pooling');
    const transporter = nodemailer.createTransport({
      ...smtp,
      pool: true,
      maxConnections: 50,
      maxMessages: Infinity,
      rateDelta: 1000,
      rateLimit: 500
    });

    transporterCache.set(key, transporter);

    transporter.on('error', (err) => {
      logError('Transporter error:', err.message);
      transporterCache.delete(key);
    });
  }

  return transporterCache.get(key);
}

const replaceTemplateVars = (str, data) => {
  if (!str || typeof str !== 'string') return str;

  const messageId = `<${Date.now()}.${Math.random().toString(36).substr(2, 9)}@${data.fromEmail?.split('@')[1] || 'mail.local'}>`;

  const rfcDate = new Date().toUTCString();

  return str
    .replace(TEMPLATE_PATTERNS.fromName, data.fromName || '')
    .replace(TEMPLATE_PATTERNS.toEmail, data.toEmail || '')
    .replace(TEMPLATE_PATTERNS.subjectLine, data.subjectLine || '')
    .replace(TEMPLATE_PATTERNS.fromEmail, data.fromEmail || '')
    .replace(TEMPLATE_PATTERNS.messageId, messageId)
    .replace(TEMPLATE_PATTERNS.rfcDate, rfcDate);
};

/**
 * Campaign configuration lookup for compact Bull jobs.
 *
 * TWO job formats are supported, distinguished solely by `campaignRef`:
 *
 *   FORMAT 1 (legacy, in use today) — every campaign field is inlined on the job:
 *     { smtp, email, from, subject, message, isHtml, headers, templateData,
 *       messageIdTemplate, senderDomain, logKey, sessionId, originalSessionId }
 *     Passed straight through unchanged and unvalidated, so existing jobs already
 *     sitting in Redis behave exactly as before.
 *
 *   FORMAT 2 (compact, not yet produced) — only recipient-specific data on the job:
 *     { campaignRef, email, sessionId, originalSessionId }
 *     Shared campaign data is read once from Redis instead of being duplicated
 *     ~5KB per recipient.
 *
 * CONTRACT for the future producer (nothing writes this yet):
 *
 *   key   : campaign:<campaignRef>          (Redis STRING, JSON encoded)
 *   value : {
 *             smtp:              { host, port, secure, auth: { user, pass } },
 *             from:              string,
 *             subject:           string,
 *             message:           string,     // may be a large HTML body
 *             isHtml:            boolean,
 *             headers:           object,     // raw header templates
 *             messageIdTemplate: string|null,
 *             inboxPatternId:    string|null,
 *             senderDomain:      string,
 *             logKey:            string,     // e.g. emaillog:<sessionId>
 *             templateData:      { fromName, subjectLine, fromEmail }
 *           }
 *
 *   smtp, from, subject, message and logKey are required. `templateData` MUST NOT
 *   carry toEmail: that is recipient-specific and is always taken from job.data.email,
 *   so a stale value in the config cannot leak into another recipient's email.
 *
 *   The producer owns the key's lifetime (write before enqueue, TTL longer than the
 *   campaign). The worker only reads.
 */
const CAMPAIGN_CONFIG_KEY_PREFIX = 'campaign:';

// Bounded deliberately: a cached config can hold a multi-megabyte HTML body, so an
// unbounded cache would be a slow leak in a long-lived worker. A worker realistically
// serves one or two campaigns at a time; the TTL also releases bodies once a campaign
// goes quiet.
const CAMPAIGN_CONFIG_CACHE_MAX_ENTRIES = 8;
const CAMPAIGN_CONFIG_CACHE_TTL_MS = 60000;

const campaignConfigCache = new Map();
const campaignConfigInFlight = new Map();

function campaignConfigKey(campaignRef) {
  return `${CAMPAIGN_CONFIG_KEY_PREFIX}${campaignRef}`;
}

async function readCampaignConfig(campaignRef) {
  const key = campaignConfigKey(campaignRef);
  const raw = await client.get(key);

  // Absent key. Returned as null so the caller can fail the job with a precise
  // message; never substituted with another campaign's data.
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Campaign config at ${key} is not valid JSON: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Campaign config at ${key} is not a JSON object`);
  }

  return parsed;
}

async function getCampaignConfig(campaignRef) {
  const cached = campaignConfigCache.get(campaignRef);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.config;
    campaignConfigCache.delete(campaignRef);
  }

  // Collapse the stampede. With CONCURRENCY job slots a cold cache would otherwise
  // issue one GET of the full body per in-flight job at the start of every campaign.
  const inFlight = campaignConfigInFlight.get(campaignRef);
  if (inFlight) return inFlight;

  const pending = readCampaignConfig(campaignRef);
  campaignConfigInFlight.set(campaignRef, pending);

  try {
    const config = await pending;

    // A missing config is not cached: it may simply not have been written yet during
    // a rolling deploy, and caching the absence would fail jobs that would now succeed.
    if (config) {
      if (campaignConfigCache.size >= CAMPAIGN_CONFIG_CACHE_MAX_ENTRIES) {
        // Map preserves insertion order, so the first key is the oldest.
        campaignConfigCache.delete(campaignConfigCache.keys().next().value);
      }
      campaignConfigCache.set(campaignRef, {
        config,
        expiresAt: Date.now() + CAMPAIGN_CONFIG_CACHE_TTL_MS
      });
    }

    return config;
  } finally {
    campaignConfigInFlight.delete(campaignRef);
  }
}

function assertSendableCampaignConfig(config, campaignRef, jobId) {
  const missing = [];

  if (!config.smtp || typeof config.smtp !== 'object') missing.push('smtp');
  if (typeof config.from !== 'string') missing.push('from');
  if (typeof config.subject !== 'string') missing.push('subject');
  if (typeof config.message !== 'string') missing.push('message');
  if (typeof config.logKey !== 'string' || !config.logKey) missing.push('logKey');

  if (missing.length) {
    throw new Error(
      `Campaign config at ${campaignConfigKey(campaignRef)} has missing or invalid ` +
      `field(s): ${missing.join(', ')} — refusing to send job ${jobId} rather than ` +
      'delivering an incomplete email'
    );
  }
}

/**
 * Resolves the campaign-level payload for a job, whichever format it uses.
 *
 * Throws for any compact job that cannot be resolved, so the caller's existing catch
 * records the failure and rethrows, letting Bull fail the job under its normal
 * attempts/removeOnFail settings. It never falls back to inline job fields or to
 * another campaign.
 */
async function resolveJobPayload(job) {
  const data = job.data || {};
  const campaignRef = typeof data.campaignRef === 'string' ? data.campaignRef.trim() : '';

  // FORMAT 1 — legacy. Returned as-is, no validation, no copying.
  if (!campaignRef) return data;

  // FORMAT 2 — compact.
  if (typeof data.email !== 'string' || !data.email) {
    throw new Error(`Malformed compact job ${job.id}: campaignRef is set but recipient email is missing`);
  }

  const config = await getCampaignConfig(campaignRef);
  if (!config) {
    throw new Error(
      `Campaign config not found at ${campaignConfigKey(campaignRef)} for job ${job.id} ` +
      '— refusing to send'
    );
  }

  assertSendableCampaignConfig(config, campaignRef, job.id);

  // Field references only. `message` is not copied; JS strings are immutable and
  // shared, so the cached body is never duplicated per job.
  return {
    smtp: config.smtp,
    from: config.from,
    subject: config.subject,
    message: config.message,
    isHtml: config.isHtml,
    headers: config.headers,
    messageIdTemplate: config.messageIdTemplate,
    inboxPatternId: config.inboxPatternId,
    senderDomain: config.senderDomain,
    logKey: config.logKey,
    // toEmail is per-recipient and is always the job's own address, listed last so it
    // wins even if a config were written with a stale toEmail in it.
    templateData: { ...(config.templateData || {}), toEmail: data.email }
  };
}

emailQueue.process(CONCURRENCY, async (job) => {
  log(`Processing job ${job.id} for email: ${job.data.email}`);

  const { email, sessionId } = job.data;

  // The catch below logs to logKey. Legacy jobs carry it inline; for compact jobs it
  // lives in the campaign config, which may itself be what failed to load. Seed from
  // the job, then upgrade once the payload resolves.
  let logKey = job.data.logKey;

  try {

    const payload = await resolveJobPayload(job);
    logKey = payload.logKey;

    const {
      smtp, from, subject, message, isHtml, headers, templateData,
      messageIdTemplate, inboxPatternId, senderDomain
    } = payload;

    const transporter = getTransporter(smtp);

    let processedHeaders = {};

    if (headers && Object.keys(headers).length > 0 && templateData) {
      for (const [key, value] of Object.entries(headers)) {
        processedHeaders[key] = replaceTemplateVars(value, templateData);
      }
      log('✅ Template variables replaced in headers');
    } else {
      processedHeaders = headers || {};
    }

    if (messageIdTemplate && senderDomain) {
      const uniqueMessageId = generateMessageId(messageIdTemplate, senderDomain);
      processedHeaders['Message-ID'] = uniqueMessageId;
      log(`Generated unique Message-ID: ${uniqueMessageId}`);
    }

    let customFrom = from;
    let customHeaders = {};

    if (processedHeaders && Object.keys(processedHeaders).length > 0) {
      customHeaders = { ...processedHeaders };

      const fromHeaderKey = Object.keys(customHeaders).find(
        key => key.toLowerCase() === 'from'
      );

      if (fromHeaderKey) {
        customFrom = customHeaders[fromHeaderKey];
        delete customHeaders[fromHeaderKey];
        log(`Using custom From header: ${customFrom}`);
      }
    }

    let mailOptions = {
      from: customFrom,
      to: email,
      subject
    };
    if (isHtml) {
      mailOptions.html = message;
      try {

        mailOptions.text = convertHtmlToText(message, {
          wordwrap: 130,
          selectors: [
            { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
            { selector: 'img', format: 'skip' }
          ]
        });
      } catch (err) {
        logError('Error converting HTML to text:', err);

        mailOptions.text = message.replace(/<[^>]*>?/gm, '');
      }
    } else {
      mailOptions.text = message;
    }

    if (Object.keys(customHeaders).length > 0) {
      mailOptions.headers = customHeaders;
    }

    if (inboxPatternId) {
      const pattern = getInboxPattern(inboxPatternId);
      const profileName = pattern ? pattern.name : 'Unknown';
      const profileLog =
        `campaignId=${sessionId || 'none'} patternId=${inboxPatternId} ` +
        `patternName=${profileName} jobId=${job.id}`;

      try {
        for (const headerName of Object.keys(customHeaders)) {
          if (isInboxPatternHeaderBlocked(headerName)) {
            throw new InboxPatternRenderError(
              `Custom header "${headerName}" cannot be used with an Inbox Pattern`
            );
          }
        }

        const profileFromEmail = templateData?.fromEmail || '';
        const profileDomain = senderDomain || profileFromEmail.split('@')[1] || 'example.com';
        const profileMessageId =
          `<${Date.now()}.${Math.random().toString(36).slice(2, 11)}@${profileDomain}>`;

        mailOptions = renderInboxPattern(inboxPatternId, {
          ToEmail: email,
          ToName: templateData?.toName || '',
          FromName: templateData?.fromName || '',
          FromEmail: profileFromEmail,
          SubjectLine: subject,
          MessageId: profileMessageId,
          PlainContent: mailOptions.text || '',
          HtmlContent: mailOptions.html || '',
          Domain: profileDomain,
          FromDomain: profileDomain
        });

        if (customFrom !== from) mailOptions.from = customFrom;
        if (Object.keys(customHeaders).length > 0) mailOptions.headers = customHeaders;

        logger.info(`Inbox pattern render ${profileLog} success=true`);
      } catch (err) {
        err.inboxPatternRenderFailure = true;
        logger.error(`Inbox pattern render ${profileLog} success=false`);
        throw err;
      }
    }

    // Has the operator stopped this campaign? Asked as late as possible, after all
    // the payload work is done, so the answer is as fresh as it can be — and asked
    // for every job regardless of whether it is paced.
    await assertCampaignNotStopped(sessionId, job.id);

    // Last gate before delivery. Jobs enqueued without a rateLimit block — every
    // job produced before this feature shipped, and every campaign the operator
    // leaves the interval empty on — normalize to null and are sent unthrottled,
    // exactly as they were.
    const rateLimit = normalizeJobRateLimit(job.data.rateLimit, {
      onInvalid: (raw) => logger.warn(
        `⚠️  Job ${job.id} carries an unusable rateLimit (${JSON.stringify(raw)}); ` +
        'sending without a rate limit rather than failing the recipient.'
      )
    });

    if (rateLimit) {
      // Re-checks the stop atomically with taking a window slot, which is what
      // closes the gap between the check above and this send. Throws
      // CampaignStoppedError if the stop landed in between, including while this
      // job sat waiting for the next interval.
      await waitForSendSlot(rateLimit, email);
    }

    const sendInfo = await transporter.sendMail(mailOptions);

    if (sessionId) {
      const originalSessionId = job.data.originalSessionId || sessionId;
      batchLogger.addLog(sessionId, 'sent', email, null, originalSessionId, job.data.sendId);

      if (sessionId.startsWith('test-')) {

        const actualMessageId = customHeaders['Message-ID'] || sendInfo?.messageId || mailOptions.messageId || 'unknown';
        const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await ImapTestResult.findOneAndUpdate(
          {
            testEmail: email,
            status: 'pending',
            messageId: { $regex: `^pending-${sessionId}-${escapedEmail}-` }
          },
          {
            messageId: actualMessageId,
            $set: { sentAt: new Date() }
          },
          { sort: { createdAt: -1 } }
        ).catch(err => logger.error(`⚠️ Could not update test record: ${err.message}`));
      }
    }

    await appendToLogKey(logKey, { email, status: 'sent', time: Date.now() });
  } catch (err) {
    // A stopped campaign is not a failure, and must not be recorded as one.
    //
    // Handled before anything else in this block and returned from rather than
    // rethrown, which is what keeps the campaign's books straight:
    //
    //   - no batchLogger.addLog, so failedCount and lastError are untouched. The
    //     operator asked for the campaign to stop; they did not get 130 bounces.
    //   - no entry appended to the log trail, so the downloadable CSV lists only
    //     addresses that were actually attempted.
    //   - the recipient stays pending, because /status derives pending as
    //     total - sent - failed and neither moved.
    //   - the job completes instead of failing, so Bull discards it under
    //     removeOnComplete rather than retaining a payload-carrying failure record
    //     for every remaining recipient of a large stopped campaign.
    //
    // The address is queued for resend first, so it is not lost to the sentIndex
    // watermark that already counted it.
    if (err instanceof CampaignStoppedError) {
      await requeueStoppedRecipient(
        sessionId, email, job.data.originalSessionId || sessionId, job.data.sendId
      );
      log(`⏹️  Skipped ${email}: campaign ${sessionId} is stopped. Left pending, not failed.`);
      return { skipped: true, reason: 'campaign stopped', email };
    }

    // This recipient was never handed to a mail server, so it is not a delivery
    // failure: the address and credentials are not implicated, and counting it as
    // failed loses it for good. `sentIndex` already counted it when it was
    // enqueued, so a resumed campaign would skip straight past it.
    //
    // Treated exactly like a stopped campaign — queued for resend by address and
    // left pending — because the situations are identical in the only way that
    // matters: nothing was sent, and the operator should get the recipient back.
    // The previous behaviour logged "Safe to resend" and then marked it failed,
    // which made that advice impossible to act on.
    //
    // In production this abandoned 89 recipients across two campaigns: 400
    // concurrent job slots (8 workers x WORKER_CONCURRENCY=50) all waiting on a
    // bucket releasing 7 slots/second, with no fairness between waiters, so an
    // unlucky tail exceeded the 60s wait budget and was discarded.
    if (err instanceof RateLimitWaitAbortedError) {
      await requeueStoppedRecipient(
        sessionId, email, job.data.originalSessionId || sessionId, job.data.sendId
      );
      logger.warn(
        `⚠️  Not sent to ${email} — ${err.message}. Queued for resend and left pending.`
      );
      return { skipped: true, reason: 'rate-limit slot unavailable', email };
    }

    if (!err.inboxPatternRenderFailure) {
      logError(`❌ Failed to send email to ${email}:`, err.message);
    }

    if (sessionId) {
      const originalSessionId = job.data.originalSessionId || sessionId;
      batchLogger.addLog(sessionId, 'failed', email, err.message, originalSessionId, job.data.sendId);
    }

    // Guarded: a compact job whose campaign config could not be resolved has no
    // logKey, and RPUSH-ing to undefined would create a literal "undefined" key in
    // Redis. Legacy jobs always carry a logKey, so this is a no-op for them.
    if (logKey) {
      await appendToLogKey(logKey, { email, status: 'failed', error: err.message, time: Date.now() });
    }
    throw err;
  }
});

emailQueue.on('completed', (job) => {
  log(`✅ Job ${job.id} completed successfully`);
});

emailQueue.on('failed', (job, err) => {
  logError(`❌ Job ${job.id} failed:`, err.message);
});

emailQueue.on('error', (err) => {
  logError('❌ Queue error:', err);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.force(`📴 Received ${signal}, finishing active jobs and shutting down…`);

  try {

    await emailQueue.close();

    // After the queue is closed, so no further job can add to a buffer, and
    // before the MongoDB connection goes, which is what the flush writes through.
    await batchLogger.drain();

    for (const [, transporter] of transporterCache.entries()) {
      try {
        transporter.close();
      } catch (err) {
        logError('Error closing transporter:', err.message);
      }
    }

    await mongoose.connection.close();
    client.disconnect();

    logger.force('✅ Worker shut down cleanly');
    process.exit(0);
  } catch (err) {
    logError('Error during shutdown:', err.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
