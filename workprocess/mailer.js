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
const logger = require('../utils/logger');

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

const TEMPLATE_PATTERNS = {
  fromName: /\{\{FromName\}\}/g,
  toEmail: /\{\{ToEmail\}\}/g,
  subjectLine: /\{\{SubjectLine\}\}/g,
  fromEmail: /\{\{FromEmail\}\}/g,
  messageId: /\{\{MessageId\}\}/g,
  rfcDate: /\[\[RFC_Date_EST\]\]/g
};

class BatchLogger {
  constructor(flushInterval = 2000, batchSize = 100) {
    this.buffers = new Map();
    this.flushInterval = flushInterval;
    this.batchSize = batchSize;
    this.isFlushing = false;

    setInterval(() => this.flushAll(), this.flushInterval);
  }

  async addLog(campaignId, type, email, error = null, originalSessionId = null) {
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

    try {
      const { campaignId, fileId } = buffer;

      const entriesToInsert = buffer.entries.map(entry => ({
        ...entry,
        sessionId: fileId,
        campaignId: campaignId
      }));

      await EmailLogEntry.insertMany(entriesToInsert);

      let lastError = '';
      if (buffer.failedCount > 0) {
        const lastFailedEntry = [...buffer.entries].reverse().find(e => e.status === 'failed');
        if (lastFailedEntry) lastError = lastFailedEntry.error;
      }

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
      logger.error('❌ Failed to flush batch logs:', err.message);
    }
  }

  async flushAll() {
    if (this.isFlushing) return;
    this.isFlushing = true;

    const sessIds = Array.from(this.buffers.keys());
    for (const sid of sessIds) {
      await this.flush(sid);
    }

    this.isFlushing = false;
  }
}

const batchLogger = new BatchLogger();

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

    const { smtp, from, subject, message, isHtml, headers, templateData, messageIdTemplate, senderDomain } = payload;

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

    const mailOptions = {
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

    const sendInfo = await transporter.sendMail(mailOptions);

    if (sessionId) {
      const originalSessionId = job.data.originalSessionId || sessionId;
      batchLogger.addLog(sessionId, 'sent', email, null, originalSessionId);

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

    await client.rpush(logKey, JSON.stringify({ email, status: 'sent', time: Date.now() }));
  } catch (err) {
    logError(`❌ Failed to send email to ${email}:`, err.message);

    if (sessionId) {
      const originalSessionId = job.data.originalSessionId || sessionId;
      batchLogger.addLog(sessionId, 'failed', email, err.message, originalSessionId);
    }

    // Guarded: a compact job whose campaign config could not be resolved has no
    // logKey, and RPUSH-ing to undefined would create a literal "undefined" key in
    // Redis. Legacy jobs always carry a logKey, so this is a no-op for them.
    if (logKey) {
      await client.rpush(logKey, JSON.stringify({ email, status: 'failed', error: err.message, time: Date.now() }));
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

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.force(`📴 Received ${signal}, finishing active jobs and shutting down…`);

  try {

    await emailQueue.close();

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
