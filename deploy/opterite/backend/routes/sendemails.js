const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const csvParse = require('csv-parse/sync');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const createRedisClient = require('../config/redis');
const redisClient = createRedisClient();
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const emailQueue = require('../workprocess/queue');
const EmailLog = require('../models/EmailLog');
const EmailLogEntry = require('../models/EmailLogEntry');
const UploadedFile = require('../models/UploadedFile');
const ImapTestResult = require('../models/ImapTestResult');
const EmailConfig = require('../models/EmailConfig');
const { encrypt, tryDecrypt } = require('../utils/credentialCipher');
const { generateMessageId } = require('../utils/messageIdGenerator');
const {
  getInboxPattern,
  isInboxPatternHeaderBlocked
} = require('../config/inboxPatterns');
const logger = require('../utils/logger');
const { parseRateLimitConfig, createEmailRateLimiter } = require('../utils/emailRateLimiter');
const { HeaderValidationError, parseCustomHeaders } = require('../utils/headerResolver');
const {
  assertValidContentTransferEncoding
} = require('../utils/contentTransferEncoding');
const {
  sessionKeyTtlSeconds,
  touchSessionKeys,
  dropSessionKeys,
  dropEmailLogKey,
  dropAllEmailLogKeys,
  seedEmailStats,
  readEmailStats
} = require('../utils/sessionKeys');
const {
  stopCampaign,
  readCampaignStop,
  isCampaignStopped,
  clearCampaignStop,
  queueForResend,
  resendQueueLength,
  takeResendQueue
} = require('../utils/campaignStop');
const campaignQueue = require('../utils/campaignQueue');

/**
 * Read-only use of the limiter from the web side: /status asks it how much of the
 * current window is spent and when the next slot opens, which is what the interval
 * popup counts down. It never acquires from here — only the workers consume slots.
 */
const emailRateLimiter = createEmailRateLimiter(redisClient);

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.csv', '.txt', '.xlsx', '.xls', '.json']);

function safeFileName(originalName) {
  const base = path.basename(String(originalName || 'upload'));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || 'upload';
}

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: env.maxUploadBytes,
    files: 1,
    fields: 50,
    fieldNameSize: 200
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();

    if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
      const err = new Error(
        `Unsupported file type "${ext || 'unknown'}". Allowed: ${[...ALLOWED_UPLOAD_EXTENSIONS].join(', ')}`
      );
      err.code = 'UNSUPPORTED_FILE_TYPE'; // mapped to a 400 by the error handler
      return cb(err);
    }

    cb(null, true);
  }
});

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function findInboxPatternHeaderConflict(rawHeaders) {
  if (!rawHeaders || !String(rawHeaders).trim()) return null;

  for (const line of String(rawHeaders).split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;

    const name = line.slice(0, separator).trim();
    if (isInboxPatternHeaderBlocked(name)) {
      return name;
    }
  }

  return null;
}

async function storeRecipients(sessionId, recipients) {
  const key = `recipients:${sessionId}`;
  await redisClient.del(key);

  if (!recipients || recipients.length === 0) return;

  const chSize = 5000;
  for (let i = 0; i < recipients.length; i += chSize) {
    const chunk = recipients.slice(i, i + chSize);
    await redisClient.rpush(key, ...chunk);
  }

  // Applied after the list is fully populated, so a failure part-way through
  // cannot leave a half-written list that survives indefinitely. RPUSH does not
  // clear an existing TTL, but setting it last keeps the ordering obvious.
  //
  // Refreshed on every send (see /send-email), so a list in use never expires;
  // this only ends lists that nobody ever comes back to.
  await redisClient.expire(key, sessionKeyTtlSeconds());
}

async function getRecipients(sessionId) {
  const key = `recipients:${sessionId}`;
  try {

    const list = await redisClient.lrange(key, 0, -1);
    if (list && list.length > 0) return list;

    const type = await redisClient.type(key);
    if (type === 'string') {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : [];
    }
    return [];
  } catch (err) {
    if (err.message.includes('WRONGTYPE')) {

      const data = await redisClient.get(key);
      try {
        return data ? JSON.parse(data) : [];
      } catch { return []; }
    }
    throw err;
  }
}

function positiveCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/**
 * O(1) recipient count for the stored list.
 *
 * LLEN is O(1) in Redis; LRANGE key 0 -1 is O(n) and also materialises every
 * address in the Node heap. Only the length is needed here.
 */
async function getRecipientCountFromRedis(sessionId) {
  const key = `recipients:${sessionId}`;

  try {
    return await redisClient.llen(key);
  } catch (err) {
    // Older campaigns stored the list as a single JSON string, which makes LLEN
    // reject with WRONGTYPE. Fall back to the same shape getRecipients() already
    // understands rather than failing the poll.
    if (err && typeof err.message === 'string' && err.message.includes('WRONGTYPE')) {
      const data = await redisClient.get(key);
      try {
        const parsed = data ? JSON.parse(data) : null;
        return Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        return 0;
      }
    }
    throw err;
  }
}

/**
 * Total recipients for progress reporting, resolved without reading the list.
 *
 * /status is polled once per second per client while a campaign runs, so this
 * path must stay O(1). Reading the whole list to take its length cost ~600ms of
 * Redis blocking and ~150MB of allocation per poll at 1M recipients, which
 * starved the workers and the rate limiter of the same single-threaded Redis.
 *
 * Resolution order:
 *   1. EmailLog.totalRecipients — the campaign's total entry count across every
 *      selected file, repeats included. This is what makes multi-file campaigns
 *      correct: the Redis list under `sessionId` only ever holds the FIRST selected
 *      file, so its length under-reports a multi-file campaign.
 *   2. UploadedFile.validEmails — persisted at upload time; used when a file has
 *      been uploaded but no campaign record exists yet.
 *   3. Redis LLEN — O(1) equivalent of the previous LRANGE(...).length.
 */
async function getRecipientCount(sessionId, emailLog = null) {
  const campaignTotal = positiveCount(emailLog && emailLog.totalRecipients);
  if (campaignTotal !== null) return campaignTotal;

  try {
    const file = await UploadedFile.findOne({ sessionId }, 'validEmails').lean();
    const fileTotal = positiveCount(file && file.validEmails);
    if (fileTotal !== null) return fileTotal;
  } catch (err) {
    logger.debug(`getRecipientCount: UploadedFile lookup failed for ${sessionId}: ${err.message}`);
  }

  return getRecipientCountFromRedis(sessionId);
}

async function getSentIndex(sessionId) {
  const idx = await redisClient.get(`sentIndex:${sessionId}`);
  return idx ? parseInt(idx) : 0;
}

/**
 * Claims a contiguous range of the recipient list for this submission, atomically.
 *
 * WHY THIS REPLACES read-then-advance. The previous sequence was: read `sentIndex`,
 * slice the list from it, enqueue, then INCRBY. INCRBY being atomic did not help,
 * because the *read* came first — two Send Email clicks arriving together (a double
 * click, or two of the four web instances serving one impatient operator) both read
 * the same watermark, both sliced the same entries, and both enqueued them. Every
 * recipient in the overlap got two emails.
 *
 * Reserving first closes that: the watermark moves in the same operation that decides
 * the range, so a second caller can only ever be handed the entries after the first.
 *
 * `total` is passed in because it cannot be read here. A multi-file campaign's
 * recipient list is the concatenation of several Redis lists assembled in Node, so
 * LLEN on any one of them would under-report. Clamping inside the script is what stops
 * a concurrent pair from reserving past the end of the list.
 *
 * Returns { start, granted }. `granted` is 0 when the list is exhausted, which is how
 * the caller learns there is nothing left to take.
 */
const RESERVE_SEND_WINDOW_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local total = tonumber(ARGV[1])
local want = tonumber(ARGV[2])

if current > total then current = total end

local remaining = total - current
local granted = want
if granted > remaining then granted = remaining end
if granted < 0 then granted = 0 end

if granted > 0 then
  redis.call('INCRBY', KEYS[1], granted)
end
redis.call('EXPIRE', KEYS[1], ARGV[3])

return {tostring(current), tostring(granted)}
`;

async function reserveSendWindow(sessionId, { total, want }) {
  const safeWant = Math.max(0, Math.trunc(Number(want) || 0));
  const safeTotal = Math.max(0, Math.trunc(Number(total) || 0));

  if (safeWant === 0 || safeTotal === 0) {
    return { start: Math.min(await getSentIndex(sessionId), safeTotal), granted: 0 };
  }

  const [start, granted] = await redisClient.eval(
    RESERVE_SEND_WINDOW_SCRIPT, 1,
    `sentIndex:${sessionId}`,
    String(safeTotal), String(safeWant), String(sessionKeyTtlSeconds())
  );

  return { start: Number(start) || 0, granted: Number(granted) || 0 };
}

/**
 * Bounds for "Limit to Send" — the cap on one Send Email action.
 *
 * Deliberately not the same ceiling as `limit` (LIMIT_MAX, 1,000,000). That one bounds
 * a *rate*, where a million per window is already absurd. This bounds a count of
 * recipients, and a campaign can legitimately be larger than a million, so the ceiling
 * only exists to catch a typo.
 */
const LIMIT_TO_SEND_MIN = 1;
const LIMIT_TO_SEND_MAX = 10000000;

/**
 * Validates the optional per-action cap.
 *
 * Empty means "no cap", which is the behaviour every campaign had before this field
 * existed: an unpaced submission still takes `limit` recipients, a paced one still
 * takes everything remaining.
 *
 * Returns { ok, value, error }. `value` is null when no cap was given.
 */
function parseLimitToSend(raw) {
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (text === '') return { ok: true, value: null };

  // Number(), not parseInt(): parseInt('30000abc') is 30000, which would silently
  // accept a typo as a valid cap.
  const value = Number(text);

  if (!Number.isInteger(value)) {
    return { ok: false, error: `Limit to Send must be a whole number of emails (got "${text}").` };
  }
  if (value < LIMIT_TO_SEND_MIN) {
    return {
      ok: false,
      error: `Limit to Send must be at least ${LIMIT_TO_SEND_MIN} — leave it empty for no limit (got ${value}).`
    };
  }
  if (value > LIMIT_TO_SEND_MAX) {
    return { ok: false, error: `Limit to Send must be ${LIMIT_TO_SEND_MAX} or less (got ${value}).` };
  }

  return { ok: true, value };
}

/**
 * Live settled counts for a session: sent and failed, as of this instant.
 *
 * Why this exists rather than just reading `EmailLog.sentCount`: the worker does
 * not write that counter per email. Outcomes are buffered in worker memory and
 * folded into MongoDB by BatchLogger on a 2s timer, independently in each of the
 * WORKER_INSTANCES worker processes, so `sentCount` advances in unsynchronised
 * steps and trails the actual sends. Polling it faster cannot help — there is
 * nothing new to read between flushes. `emailstats:<id>` is incremented once per
 * email in the same Redis pipeline that appends to the log trail, so it is
 * current.
 *
 * Both sources count the same events, so the larger is taken rather than either
 * being trusted outright. Redis leads in the normal case, which is the point. But
 * MongoDB wins in two situations that must not regress: a session whose tally
 * expired or predates this mechanism, and the narrow window where a worker
 * increments a fresh field before the enqueue path could seed it. Neither source
 * can over-count, so max() is always the better-informed of the two and never
 * inflates.
 *
 * Deliberately not derived from the `emaillog:<id>` list. Counting it means
 * LRANGE 0 -1 on every poll — the same O(n) read, ~600ms of blocking and ~150MB
 * of allocation at 1M recipients, that getRecipientCount() exists to avoid. HMGET
 * is O(1).
 */
async function getSettledCounts(sessionId, emailLog) {
  const durable = {
    sent: (emailLog && emailLog.sentCount) || 0,
    failed: (emailLog && emailLog.failedCount) || 0
  };

  try {
    const live = await readEmailStats(redisClient, sessionId);
    if (!live) return durable;

    return {
      sent: Math.max(durable.sent, live.sent),
      failed: Math.max(durable.failed, live.failed)
    };
  } catch (err) {
    // A progress read must never fail the poll. The durable counters are correct,
    // just behind, which is strictly better than an error.
    logger.debug(`getSettledCounts: live tally unavailable for ${sessionId}: ${err.message}`);
    return durable;
  }
}

/**
 * One campaign's progress, using the same arithmetic GET /status reports.
 *
 * Exists so the campaign-lane reconciler (routes/campaignQueue.js) can decide
 * whether a campaign has finished without duplicating — and eventually drifting
 * from — the definition of "finished" that the UI already shows. Both now answer
 * from getSettledCounts / getRecipientCount / readCampaignStop.
 *
 * `finished` deliberately requires total > 0. A campaign whose recipient total
 * cannot be resolved yet must not be read as "0 of 0, therefore done"; that would
 * release the lane before a single email had been sent.
 */
async function readCampaignProgress(sessionId) {
  const emailLog = await EmailLog.findOne({ sessionId }, '-entries').sort({ createdAt: -1 });

  const stopRecord = await readCampaignStop(redisClient, sessionId);
  const { sent, failed } = await getSettledCounts(sessionId, emailLog);

  const total = sessionId.startsWith('test-')
    ? ((emailLog && emailLog.totalRecipients) || 0)
    : await getRecipientCount(sessionId, emailLog);

  const settled = sent + failed;

  // How many entries have been released to the queue for this campaign, across every
  // Send Email action so far. The lane reconciler compares it against `settled` to tell
  // a campaign paused by Limit to Send (everything released has settled, entries remain)
  // from one that has stalled (released work never came back).
  const sentIndex = await getSentIndex(sessionId);

  return {
    sessionId,
    total,
    sent,
    failed,
    settled,
    sentIndex,
    pending: Math.max(0, total - settled),
    stopped: stopRecord !== null,
    campaignStatus: (emailLog && emailLog.status) || null,
    rateIntervalSeconds: Number(emailLog && emailLog.rateLimit && emailLog.rateLimit.intervalSeconds) || 0,
    resendQueued: await resendQueueLength(redisClient, sessionId),
    finished: total > 0 && settled >= total,
    exists: Boolean(emailLog)
  };
}

/**
 * Marks a campaign finished in MongoDB.
 *
 * Until now nothing ever wrote 'completed'. `EmailLog.methods.addEntry` is the only
 * writer in the model and has no call sites — the worker records outcomes through
 * BatchLogger's `updateOne({$inc})`, a raw update that bypasses both the method and
 * the pre('save') hook, so `pendingCount` reaching zero had no consequence and every
 * finished campaign stayed 'in_progress' forever.
 *
 * Filtered on `status: 'in_progress'` so it is a one-way transition and cannot
 * overwrite a stop, exactly like the stop route's own update.
 */
async function markCampaignTerminal(sessionId, status) {
  try {
    await EmailLog.updateOne(
      { sessionId, status: 'in_progress' },
      { $set: { status, completedAt: new Date(), updatedAt: new Date() } }
    );
  } catch (err) {
    // The lane decision is held in Redis and does not depend on this write; a
    // failure here only means the durable record lags.
    logger.warn(`⚠️  Could not mark campaign ${sessionId} as ${status}: ${err.message}`);
  }
}

/**
 * Reports whether a saved SMTP password exists for the current operator.
 *
 * This used to return the entire campaign form. It no longer does: the form is
 * temporary per-tab UI state and now lives in the browser's sessionStorage
 * the frontend's per-tab form storage, which gives each tab an independent
 * draft. The server only ever held those fields to repaint the form after a
 * refresh — /send-email receives all of them in the request body — so persisting
 * them was a database write per keystroke for data nothing read back.
 *
 * The password itself is never included, only whether one is stored, so the
 * browser can show that sending will reuse it. The plaintext stays on the server
 * instead of being shipped on every page load.
 */
router.get('/email-config', async (req, res) => {
  try {
    const userId = req.user?.email;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const saved = await EmailConfig.findOne({ userId }).select('+smtpPass');

    res.json({ success: true, hasSmtpPass: Boolean(saved && saved.smtpPass) });
  } catch (err) {
    console.error('Error checking saved SMTP password:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Stores the operator's SMTP password.
 *
 * The only field accepted. Semantics are unchanged from when this endpoint also
 * carried the form draft, because they were chosen so an autosave could never
 * silently destroy a stored credential:
 *   - key absent        -> leave the stored password untouched
 *   - non-empty string  -> encrypt and replace
 *   - empty string      -> the operator cleared the field, so clear the stored one
 *
 * Now only called when the password field itself changes, rather than on every
 * edit anywhere in the form.
 */
router.post('/email-config', async (req, res) => {
  try {
    const userId = req.user?.email;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (!Object.prototype.hasOwnProperty.call(body, 'smtpPass')) {
      // Nothing to do. Reported as success because an absent key explicitly means
      // "leave the stored password alone".
      return res.json({ success: true, updated: false });
    }

    const raw = body.smtpPass === null || body.smtpPass === undefined ? '' : String(body.smtpPass);

    await EmailConfig.findOneAndUpdate(
      { userId },
      { userId, smtpPass: raw === '' ? '' : encrypt(raw), updatedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, updated: true });
  } catch (err) {
    console.error('Error saving SMTP password:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Discards the stored SMTP password.
 */
router.delete('/email-config', async (req, res) => {
  try {
    const userId = req.user?.email;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    await EmailConfig.deleteOne({ userId });
    res.json({ success: true });
  } catch (err) {
    console.error('Error clearing email config:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Resolves the SMTP password for a send.
 *
 * The password field is not repopulated after a refresh (the secret stays on the
 * server), so an empty field with a stored credential means "reuse the saved
 * one". A submitted password always wins, and with nothing stored this returns
 * the submitted value unchanged — so behaviour is identical for anyone who has
 * never saved a password.
 *
 * Unaffected by the form draft moving to sessionStorage: the password was always
 * the one field kept out of the browser, and it is still keyed on the login email
 * with one credential document per operator.
 */
async function resolveSmtpPass(userId, submitted) {
  if (submitted) return submitted;
  if (!userId) return submitted;

  const saved = await EmailConfig.findOne({ userId }).select('+smtpPass');
  if (!saved || !saved.smtpPass) return submitted;

  const decrypted = tryDecrypt(saved.smtpPass);
  if (!decrypted.ok) {
    console.error(`Could not decrypt stored SMTP password for ${userId}: ${decrypted.error}`);
    return submitted;
  }

  return decrypted.value;
}

router.post('/recipients', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    let emails = [];
    const ext = path.extname(file.originalname).toLowerCase();
    const filePath = file.path;

    if (ext === '.csv' || ext === '.txt') {
      const content = fs.readFileSync(filePath, 'utf8');
      let records;
      if (ext === '.csv') {
        records = csvParse.parse(content, { columns: false, skip_empty_lines: true });
        emails = records.flat().map(e => e.trim());
      } else {
        emails = content.split(/\r?\n/).map(e => e.trim());
      }
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      emails = data.flat().map(e => (typeof e === 'string' ? e.trim() : ''));
    } else if (ext === '.json') {
      const content = fs.readFileSync(filePath, 'utf8');
      const json = JSON.parse(content);
      if (Array.isArray(json)) {
        if (typeof json[0] === 'string') {
          emails = json.map(e => e.trim());
        } else if (typeof json[0] === 'object' && json[0].email) {
          emails = json.map(obj => obj.email.trim());
        }
      }
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    // Every valid entry is kept, including repeats of an address that already
    // appeared. A recipient list is a list of sends, not a set of people: uploading
    // 16 rows means 16 emails, and collapsing them to the 4 distinct addresses threw
    // away 12 sends the operator had asked for. Duplicates are the caller's
    // business, and the rest of the pipeline stores them faithfully — Redis
    // recipient lists are RPUSH lists, and EmailLogEntry has no unique index on
    // email, so a repeated address logs once per send.
    //
    // Trimming and lower-casing stay: that is normalisation of each entry, not
    // deduplication across entries.
    let validRecipients = [];
    const invalidRecipients = [];

    for (let email of emails) {
      if (!email) continue;
      const trimmed = email.trim().toLowerCase();
      if (isValidEmail(trimmed)) {
        validRecipients.push(trimmed);
      } else {
        invalidRecipients.push(email);
      }
    }

    emails = [];

    const sessionId = req.headers['x-session-id'] || uuidv4();
    const timestamp = Date.now();
    // originalname is client-controlled — sanitise before using it in a path.
    const newFileName = `${sessionId}_${timestamp}_${safeFileName(file.originalname)}`;
    const newFilePath = path.join(uploadsDir, newFileName);

    fs.renameSync(filePath, newFilePath);

    const uploadedFile = new UploadedFile({
      originalName: file.originalname,
      storedPath: newFilePath,
      fileSize: file.size,
      fileType: ext,
      sessionId: sessionId,
      // Every entry that was read, valid or not. Was `seen.size + invalid`, which
      // reported the count of *distinct* valid addresses and so under-reported a
      // file containing repeats.
      totalEmails: validRecipients.length + invalidRecipients.length,
      validEmails: validRecipients.length,
      invalidEmails: invalidRecipients.length,
      pendingEmails: validRecipients.length,
      status: 'uploaded'
    });

    await uploadedFile.save();

    await storeRecipients(sessionId, validRecipients);

    res.json({
      // The full validRecipients array is not needed by the frontend, which only
      // needs the counts and session id — and
      // at 1M addresses it was a ~28MB response body serialised on the event loop.
      total: validRecipients.length,
      sessionId,
      fileInfo: {
        originalName: file.originalname,
        totalEmails: emails.length,
        validEmails: validRecipients.length,
        invalidEmails: invalidRecipients.length
      }
    });
  } catch (err) {
    console.error('Error in /recipients:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * How many queued jobs one purge pass reads at a time, and the ceiling on a whole
 * purge.
 *
 * The cap is not a correctness limit. Anything the purge fails to remove is still
 * refused by the worker's own stop check and queued for resend there, so a capped
 * purge degrades to "the queue drains as no-ops" rather than "emails are sent".
 * It exists so stopping a million-recipient campaign cannot occupy a web process
 * indefinitely.
 */
const PURGE_PAGE_SIZE = 500;
const PURGE_MAX_JOBS = 500000;

/**
 * Removes a stopped campaign's not-yet-started jobs from the queue.
 *
 * WHY THIS IS NECESSARY AND NOT JUST TIDY
 * ---------------------------------------
 * The worker's stop check alone would make every remaining job a no-op, which
 * sounds sufficient. It is not, for two reasons:
 *
 *   1. Restarting lifts the stop marker. A paced campaign parks its backlog in
 *      Bull's delayed set with delays computed from the OLD limit and interval —
 *      potentially hours out. If those jobs were still there when the operator
 *      restarts at 100/10s, they would come due, find no stop marker, and send
 *      using the previous 35/5s configuration and a stale payload. Removing them
 *      is what makes "the new send uses the new settings" actually true.
 *   2. Every job carries a full copy of the message body. Leaving hundreds of
 *      thousands of them to dribble through as no-ops keeps that memory in Redis
 *      for as long as the longest delay.
 *
 * Active jobs are deliberately not touched. Bull refuses to remove a locked job,
 * and forcing it would risk losing the record of a delivery that already happened
 * — a duplicate on the next send. Those recipients are handled by the worker
 * instead: it declines the send and queues them for resend.
 *
 * Every removed recipient is recorded in `resend:<sessionId>` *before* its job
 * goes, because `sentIndex` has already counted it and nothing else remembers it.
 */
async function purgeStoppedCampaignJobs(sessionId) {
  const summary = { scanned: 0, removed: 0, requeued: 0, skipped: 0, capped: false };

  // 'paused' is included because a queue that was paused for any reason holds its
  // backlog in a separate list, and those jobs would resume with the rest.
  for (const type of ['delayed', 'waiting', 'paused']) {
    let offset = 0;

    for (;;) {
      if (summary.scanned >= PURGE_MAX_JOBS) {
        summary.capped = true;
        break;
      }

      let jobs;
      try {
        jobs = await emailQueue.getJobs([type], offset, offset + PURGE_PAGE_SIZE - 1);
      } catch (err) {
        logger.warn(`⚠️  Stop ${sessionId}: could not read ${type} jobs: ${err.message}`);
        break;
      }

      if (!jobs || jobs.length === 0) break;

      summary.scanned += jobs.length;

      // Jobs that stay put are what the next page has to skip over. Advancing by
      // the page size instead would step past jobs that shifted forward when the
      // ones before them were removed, and a campaign's jobs would be missed.
      let retained = 0;

      for (const job of jobs) {
        if (!job) continue;

        if (!job.data || job.data.sessionId !== sessionId) {
          retained += 1;
          continue;
        }

        const email = typeof job.data.email === 'string' ? job.data.email : '';
        const sourceFile = job.data.originalSessionId || sessionId;
        // Jobs enqueued before sendId existed have none; resendIdentity() falls back
        // to the address for those, which is the behaviour they were queued under.
        const sendId = typeof job.data.sendId === 'string' ? job.data.sendId : '';

        try {
          // Recorded before removal, on purpose: the reverse order could lose the
          // send entirely if the process died between the two.
          //
          // Recording it twice is harmless. If this process dies after queueing but
          // before removing, the job survives, the worker declines it on the stop
          // check and queues it for resend as well — but both records carry the same
          // `sendId`, so takeResendQueue recognises them as one send and the
          // recipient gets one email on restart. That is why the identity is the
          // sendId and not the address: collapsing on the address would also have
          // merged the genuinely separate sends a duplicated recipient is owed.
          if (email) {
            summary.requeued += await queueForResend(redisClient, sessionId, [{ email, sourceFile, sendId }]);
          }

          await job.remove();
          summary.removed += 1;
        } catch (err) {
          // Almost always "job is locked": it became active between the read and
          // the remove. The worker owns it now and will decline the send itself.
          summary.skipped += 1;
          retained += 1;
          logger.debug(`Stop ${sessionId}: could not remove job ${job.id}: ${err.message}`);
        }
      }

      if (jobs.length < PURGE_PAGE_SIZE) break;
      offset += retained;
    }

    if (summary.capped) break;
  }

  return summary;
}

/**
 * THE stop operation. One route, one meaning: stop the entire campaign.
 *
 * Both Stop Sending buttons in the UI — the one beside Send Email and the one
 * inside the interval popup — post here. There is no separate "stop the interval"
 * endpoint or semantic, because stopping the interval and stopping the campaign are
 * the same act.
 *
 * ORDER OF OPERATIONS, WHICH IS THE WHOLE DESIGN
 * ----------------------------------------------
 *   1. Write the Redis marker. This is the commit point, and it is first for that
 *      reason: from this instant the limiter refuses to grant window slots and
 *      every worker declines before sending. Nothing downstream can release
 *      another email, so everything after this is bookkeeping.
 *   2. Update MongoDB so the campaign reads as stopped in /logs and the retention
 *      sweep treats it as resumable work.
 *   3. Respond. The operator gets confirmation once the stop is genuinely in force,
 *      not once the UI has been told to look stopped.
 *   4. Purge the queued backlog in the background, because it can take a while on a
 *      large campaign and sending has already ceased.
 *
 * Idempotent by construction: the marker is written with SET NX, so a double click,
 * two open tabs, or both buttons at once produce one stop and one purge.
 */
router.post('/stop-sending', async (req, res) => {
  try {
    const raw = req.body?.sessionId ?? req.query?.sessionId ?? '';
    const sessionId = String(raw).trim();

    if (!sessionId) {
      return res.status(400).json({ error: 'No sessionId provided — nothing to stop.' });
    }

    // Step 1. The commit point. Done before any database work so that a slow or
    // unavailable MongoDB cannot delay the moment sending actually stops.
    const stop = await stopCampaign(redisClient, sessionId, {
      stoppedBy: req.user?.email || 'unknown',
      reason: 'operator clicked Stop Sending'
    });

    if (stop.committed) {
      logger.force(
        `⏹️  Campaign ${sessionId} STOPPED by ${stop.stoppedBy}. ` +
        'No further emails will be released for this campaign.'
      );
    } else {
      logger.info(`⏹️  Campaign ${sessionId} was already stopped at ${stop.stoppedAt}.`);
    }

    // Step 2. Durable state. Guarded so a MongoDB problem is reported but does not
    // undo or obscure a stop that is already in force in Redis.
    let emailLog = null;
    try {
      emailLog = await EmailLog.findOneAndUpdate(
        { sessionId, status: 'in_progress' },
        { $set: { status: 'stopped', stoppedAt: new Date(), updatedAt: new Date() } },
        { new: true }
      ).select('-entries');

      // Already terminal (completed, failed, or stopped by a previous click), so
      // there is nothing to transition — just read it for the response.
      if (!emailLog) {
        emailLog = await EmailLog.findOne({ sessionId }, '-entries');
      }

      // Recipient files return to 'uploaded': the operator staged them and they
      // still hold unsent addresses, which is what 'uploaded' means. Leaving them
      // at 'processing' would show them as mid-send forever.
      const fileIds = (emailLog && emailLog.sourceFileIds && emailLog.sourceFileIds.length > 0)
        ? emailLog.sourceFileIds
        : [sessionId];

      await UploadedFile.updateMany(
        { sessionId: { $in: fileIds }, status: 'processing' },
        { $set: { status: 'uploaded' } }
      );
    } catch (dbErr) {
      logger.error(
        `⚠️  Campaign ${sessionId} is stopped in Redis, but its records could not be ` +
        `updated: ${dbErr.message}`
      );
    }

    const { sent, failed } = await getSettledCounts(sessionId, emailLog);
    const total = sessionId.startsWith('test-')
      ? ((emailLog && emailLog.totalRecipients) || 0)
      : await getRecipientCount(sessionId, emailLog);

    // Step 3. Confirm, now that the stop is enforced.
    res.json({
      status: 'stopped',
      sessionId,
      alreadyStopped: !stop.committed,
      stoppedAt: stop.stoppedAt,
      stoppedBy: stop.stoppedBy,
      sent,
      failed,
      pending: Math.max(0, total - sent - failed),
      total,
      message: stop.committed
        ? 'Sending stopped. No further emails will be sent for this campaign.'
        : 'This campaign was already stopped.'
    });

    // Step 3b. Free this operator's campaign lane so anything waiting behind this
    // campaign can run. A stop is terminal for this run — the remaining recipients
    // stay pending and resumable, which is the existing contract — so holding the
    // lane afterwards would deadlock every queued campaign behind it.
    //
    // Guarded and after the response: sequencing is a convenience and must never be
    // able to fail a stop, which is the most consequential action in the product.
    try {
      const userId = req.user?.email;
      if (userId) {
        const { promotedCampaignId } = await campaignQueue.release(redisClient, {
          userId,
          campaignId: sessionId,
          state: campaignQueue.STATES.CANCELLED
        });
        if (promotedCampaignId) {
          logger.force(`▶️  Campaign lane: ${sessionId} stopped, ${promotedCampaignId} promoted.`);
        }
      }
    } catch (laneErr) {
      logger.warn(`⚠️  Could not release the campaign lane for ${sessionId}: ${laneErr.message}`);
    }

    // Step 4. Clear the backlog out of the queue. Only the click that actually
    // committed the stop does this; a repeat click must not start a second sweep.
    if (!stop.committed) return;

    setImmediate(async () => {
      try {
        const summary = await purgeStoppedCampaignJobs(sessionId);
        logger.force(
          `⏹️  Campaign ${sessionId}: removed ${summary.removed} queued job(s), ` +
          `${summary.requeued} recipient(s) kept for a later send, ` +
          `${summary.skipped} already in progress (declined by the worker)` +
          (summary.capped ? `, scan capped at ${PURGE_MAX_JOBS} jobs` : '') + '.'
        );
      } catch (purgeErr) {
        // Sending has already stopped; this only means the queue drains as no-ops.
        logger.error(
          `⚠️  Campaign ${sessionId}: queued jobs could not be purged (${purgeErr.message}). ` +
          'Sending is still stopped — the worker declines every remaining job.'
        );
      }
    });
  } catch (err) {
    console.error('Error in /stop-sending:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.post('/send-email', async (req, res) => {
  try {
    const {
      'smtp-host': smtpHost,
      'smtp-port': smtpPort,
      'smtp-user': smtpUser,
      'smtp-pass': smtpPass,
      'test-bulk': testBulk,
      'test-recp': testRecp,
      limit,
      'interval-seconds': intervalSeconds,
      'smtp-from-name': fromName,
      'smtp-from-email': fromEmail,
      subject,
      'custom-headers': customHeaders,
      'custom-message-id': customMessageId,
      'inbox-pattern-id': inboxPatternIdRaw,
      'plain-html': plainHtml,
      'content-transfer-encoding': contentTransferEncodingRaw,
      message,
      'file-ids': fileIds,
      'limit-to-send': limitToSendRaw,
      sessionId: initialSessionId
    } = req.body;

    const inboxPatternId = String(inboxPatternIdRaw || '').trim();
    let contentTransferEncoding;
    try {
      contentTransferEncoding = contentTransferEncodingRaw
        ? assertValidContentTransferEncoding(contentTransferEncodingRaw)
        : null;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (inboxPatternId && !getInboxPattern(inboxPatternId)) {
      return res.status(400).json({ error: `Unknown inbox pattern: ${inboxPatternId}` });
    }

    if (inboxPatternId) {
      if (customMessageId && customMessageId.trim()) {
        return res.status(400).json({
          error: 'Custom Message-ID cannot be used with an Inbox Pattern.'
        });
      }

      const conflictingHeader = findInboxPatternHeaderConflict(customHeaders);
      if (conflictingHeader) {
        return res.status(400).json({
          error: `Custom header "${conflictingHeader}" cannot be used with an Inbox Pattern.`
        });
      }
    }

    let headers;
    try {
      headers = parseCustomHeaders(customHeaders);
    } catch (err) {
      if (err instanceof HeaderValidationError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    // Send rate, validated server-side before anything is read or enqueued. The
    // browser checks the same bounds in public/js/recipents-upload.js purely to
    // give a faster error; this is the check that decides.
    //
    // `rateLimitConfig` is null when the operator left the interval empty, which
    // is the pre-existing behaviour: `limit` is then a per-submission batch size
    // and sending is unpaced.
    const rateLimitParse = parseRateLimitConfig({ limit, intervalSeconds });
    if (!rateLimitParse.ok) {
      return res.status(400).json({ error: rateLimitParse.error });
    }
    const rateLimitConfig = rateLimitParse.config;
    const parsedLimit = rateLimitParse.parsedLimit;

    // The cap on THIS Send Email action, independent of the rate. Validated here
    // rather than trusted from the browser, which checks the same bounds only to give
    // a faster error.
    const limitToSendParse = parseLimitToSend(limitToSendRaw);
    if (!limitToSendParse.ok) {
      return res.status(400).json({ error: limitToSendParse.error });
    }
    const limitToSend = limitToSendParse.value;

    let recipients = [];
    let batch = [];
    let batchCount = 0;
    let logKey = '';
    let selectedFileIds = [];
    let sessionId = initialSessionId;

    if (testBulk === 'Test') {
      const testEmails = testRecp.split(/[,;\n\r]+/).map(e => e.trim()).filter(isValidEmail);
      if (!testEmails.length) return res.status(400).json({ error: 'No valid test recipients' });

      if (!sessionId) {
        sessionId = `test-${Date.now()}`;
      }

      // Same entry shape as the bulk path, so everything downstream — the enqueue
      // loop, the mid-enqueue stop handler — reads one structure regardless of mode.
      // A test list can repeat an address too, and each repeat is its own send.
      recipients = testEmails.map((email, index) => ({
        email,
        sourceFile: sessionId,
        sendId: `${sessionId}#${index}`
      }));

      batch = recipients;
      batchCount = batch.length;

      logKey = `emaillog:${sessionId}`;
    } else {

      if (!fileIds || !fileIds.trim()) {
        return res.status(400).json({ error: 'File IDs are mandatory for bulk campaigns. Please specify which files to use.' });
      }

      selectedFileIds = fileIds.split(',').map(id => id.trim()).filter(id => id);

      if (selectedFileIds.length === 0) {
        return res.status(400).json({ error: 'Please provide at least one valid File ID for bulk campaigns.' });
      }

      for (const fileId of selectedFileIds) {
        const file = await UploadedFile.findOne({ sessionId: fileId });
        if (!file) {
          return res.status(400).json({ error: `File ID "${fileId}" not found. Please check your file IDs.` });
        }
      }

      let recipientDetails = [];
      for (const fileId of selectedFileIds) {
        const fileRecipients = await getRecipients(fileId);

        // `sendId` is this entry's position in this file's stored list. That list is
        // written once at upload and never mutated, so the position names exactly one
        // send and is stable across submissions — and, unlike the address, it stays
        // unique when a file deliberately lists the same recipient several times.
        // The stop/resend flow tracks these ids, which is what lets three
        // outstanding sends to one address resume as three.
        fileRecipients.forEach((email, indexInFile) => {
          recipientDetails.push({
            email,
            sourceFile: fileId,
            sendId: `${fileId}#${indexInFile}`
          });
        });
      }

      if (!recipientDetails.length) return res.status(400).json({ error: 'No valid recipients found in specified files' });

      // Taken in full, repeats included. This used to collapse recipientDetails to
      // one entry per distinct address, which meant a file deliberately containing
      // 16 rows for 4 addresses sent only 4 emails. Keeping every entry at upload
      // time (see POST /recipients) would have been pointless on its own, because
      // this was the second place the count was reduced.
      //
      // Note this also stops silently merging the same address across two selected
      // files: selecting file A and file B that share a recipient now sends to that
      // recipient once per file, which is the same rule applied consistently —
      // one send per entry.
      //
      // Carried as entries rather than bare addresses so each send keeps its own
      // identity and source file all the way to the queue. `sentIndex` still indexes
      // this positionally, exactly as it did when these were strings.
      recipients = recipientDetails;

      sessionId = selectedFileIds[0];
    }

    if (!recipients.length) return res.status(400).json({ error: 'No valid recipients' });

    // RESTARTING AFTER A STOP.
    //
    // Lifting the marker is the whole of it, and it has to happen before anything
    // is enqueued or the workers would decline the jobs this submission is about to
    // create. There is no separate resume path: a restart is an ordinary send that
    // happens to follow a stop, so it picks up whatever Limit and Interval are in
    // the form right now. Stopping a 35/5s campaign and resubmitting at 100/10s
    // sends at 100/10s, because the rate is read from this request and the previous
    // campaign's jobs were removed from the queue rather than left parked.
    const wasStopped = await clearCampaignStop(redisClient, sessionId);
    if (wasStopped) {
      logger.force(`▶️  Campaign ${sessionId} restarted by ${req.user?.email || 'unknown'} — stop lifted.`);
    }

    // Recipients whose jobs were discarded by a stop before they were ever handed
    // to a mail server. Taken first, because `sentIndex` has already counted them
    // and nothing else will bring them back.
    //
    // Atomic: the list is read and trimmed in one step, so two concurrent
    // submissions cannot both claim the same addresses.
    let resendBatch = [];
    if (testBulk !== 'Test') {
      try {
        resendBatch = await takeResendQueue(redisClient, sessionId);
        if (resendBatch.length > 0) {
          logger.force(
            `♻️  Campaign ${sessionId}: re-queueing ${resendBatch.length} recipient(s) ` +
            'left unsent by a previous stop.'
          );
        }
      } catch (resendErr) {
        // Left in the list for the next submission rather than lost. Better to
        // send the new batch now and pick these up later than to fail the request.
        logger.warn(`⚠️  Could not read the resend backlog for ${sessionId}: ${resendErr.message}`);
      }
    }

    // How many recipients this submission takes.
    //
    // The two branches exist because `limit` means different things depending on
    // whether an interval was supplied:
    //
    //   no interval  -> `limit` is a batch size, unchanged from before this
    //                   feature. Take that many recipients from the resume
    //                   position and send them as fast as SMTP allows.
    //
    //   interval set -> `limit` is a *rate* (emails per window), so it no longer
    //                   caps the submission. Take everything still unsent and let
    //                   the limiter pace it. This is what makes "100 recipients at
    //                   35 per 5s" finish in three windows from one click instead
    //                   of needing three clicks.
    const rateBatchLimit = testBulk === 'Test'
      ? recipients.length
      : (rateLimitConfig ? recipients.length : (parsedLimit || recipients.length));

    /**
     * LIMIT TO SEND — the cap on one Send Email action.
     *
     * Applied here, as a `min` over whatever the existing rule produced, which is what
     * keeps it orthogonal to the rate. `limit`/`interval` still decide how *fast* the
     * batch goes out; this decides how *many* go out for this click.
     *
     * It matters most in the paced branch above, where `limit` is a rate and therefore
     * stops bounding the submission — every remaining recipient is enqueued and the
     * workers pace them. Before this field there was no way to say "35 per 5 seconds,
     * but only 30,000 this time". Unpaced, `limit` was already acting as a per-click
     * batch size, so a smaller cap narrows it and a larger one leaves it alone.
     *
     * Test sends are exempt: a handful of inbox-placement addresses are not a batch.
     */
    const batchLimit = (limitToSend !== null && testBulk !== 'Test')
      ? Math.min(rateBatchLimit, limitToSend)
      : rateBatchLimit;

    // The resend backlog counts against the batch size, so "limit to send 30,000" means
    // 30,000 emails are released — not 30,000 plus however many a stop left behind.
    const forwardRoom = Math.max(0, batchLimit - resendBatch.length);

    // Reserved before slicing, so two simultaneous submissions get disjoint ranges
    // instead of both starting from the same watermark. Test sends keep their own
    // recipient list in the request and have no watermark, so they take it whole.
    let sentIndex = 0;
    let forwardBatch = [];

    if (testBulk === 'Test') {
      forwardBatch = recipients.slice(0, forwardRoom);
    } else {
      const reserved = await reserveSendWindow(sessionId, {
        total: recipients.length,
        want: forwardRoom
      });
      sentIndex = reserved.start;
      forwardBatch = recipients.slice(reserved.start, reserved.start + reserved.granted);
    }

    // Recipients from the backlog lead, then the campaign continues from its resume
    // position. Both are taken in full: an address may appear in the backlog and
    // again in the forward slice, and each occurrence is a send that was asked for.
    //
    // This used to filter the forward slice against the backlog, on the reasoning
    // that one address twice in a submission must be a mistake. That is no longer
    // true — a recipient list holds one entry per send — and the filter actively
    // removed sends: an address owed a retry from a stop would lose its next
    // scheduled send as well, because the two are indistinguishable by address.
    // Entries, not addresses: each carries the sendId that identifies it, so a
    // backlog entry and a scheduled send that happen to share an address stay
    // distinguishable all the way through.
    batch = [
      ...resendBatch,
      ...forwardBatch
    ];

    // Note for the enqueue loop below: indices [0, resendBatch.length) of `batch`
    // are backlog entries, which sit behind the resume position already; everything
    // after that came from the recipient list and is what advances it.

    if (!batch.length) {
      // The backlog is empty and the resume position is at the end of the list.
      return res.status(400).json({ error: 'No more recipients to send' });
    }
    batchCount = batch.length;
    logKey = `emaillog:${sessionId}`;

    // req.recipientSourceMap is gone. It existed so the enqueue loop could look up
    // "which file did this address come from", which required an address-keyed index
    // and could only ever return one answer per address. Every entry in `batch` now
    // carries its own sourceFile, so the lookup — and the last address-keyed
    // structure in the send path — is unnecessary.

    // Falls back to the saved encrypted password when the field was left empty
    // because the browser was refreshed. Returns `smtpPass` untouched when the
    // operator supplied one or has nothing saved.
    const resolvedSmtpPass = await resolveSmtpPass(req.user?.email, smtpPass);

    const smtp = {
      host: smtpHost,
      port: parseInt(smtpPort),
      secure: parseInt(smtpPort) === 465,
      auth: { user: smtpUser, pass: resolvedSmtpPass }
    };
    const from = `${fromName} <${fromEmail}>`;
    const isHtml = plainHtml === 'HTML';

    logger.debug('Parsed custom headers:', JSON.stringify(headers, null, 2));

    let processedMessageId = null;
    if (customMessageId && customMessageId.trim()) {

      const senderDomain = fromEmail.split('@')[1] || 'example.com';

      processedMessageId = customMessageId.trim();

      logger.debug('Custom Message-ID template:', processedMessageId);
      logger.debug('Sender domain for {{Domain}} replacement:', senderDomain);
    }

    let emailLog;
    if (testBulk === 'Test') {
      emailLog = new EmailLog({
        sessionId: sessionId,
        fromEmail,
        fromName,
        subject,
        messageType: plainHtml,
        totalRecipients: recipients.length,
        pendingCount: recipients.length,
        batchLimit: batch.length,
        smtpHost,
        customHeaders: headers,
        inboxPatternId: inboxPatternId || null,
        status: 'in_progress'
      });
    } else {

      /**
       * Get-or-create in one atomic step.
       *
       * This was `findOne` followed by `new EmailLog(...)` a few lines below, which two
       * simultaneous Send Email clicks could interleave: both found no record, both
       * constructed one, and the second `save()` failed with E11000 on the unique
       * `sessionId` index — so a double click returned HTTP 500 for one of the two
       * requests even though its recipients had already been reserved.
       *
       * `$setOnInsert`, so an existing campaign is read and left completely untouched
       * here; every mutation below still applies exactly as it did before. The creation
       * fields are the same ones the constructor used.
       */
      emailLog = await EmailLog.findOneAndUpdate(
        { sessionId },
        {
          $setOnInsert: {
            sessionId,
            fromEmail,
            fromName,
            subject,
            messageType: plainHtml,
            totalRecipients: recipients.length,
            pendingCount: recipients.length,
            // Same value the slice above used, rather than recomputing it, so the
            // record cannot disagree with what was actually taken.
            batchLimit,
            smtpHost,
            customHeaders: headers,
            inboxPatternId: inboxPatternId || null,
            status: 'in_progress'
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      /**
       * Per-submission fields, written as one atomic `$set` rather than by mutating the
       * loaded document and calling `save()`.
       *
       * `save()` carries Mongoose's optimistic version check, so two simultaneous Send
       * Email clicks both loaded the document at `__v: 0`, the first save bumped it, and
       * the second failed with a VersionError — another way a double click produced an
       * HTTP 500 after its recipients had already been reserved. An update operator has
       * no version check and is idempotent: both requests write the same values.
       *
       * lastError: cleared per submission. It is only ever written when a send fails
       * (mailer.js BatchLogger.flush) and was never cleared, so a single failed recipient
       * pinned an error onto /status for the rest of the campaign — and because a bulk
       * sessionId IS the recipient file's id, the next campaign on that file inherited
       * it from its very first poll.
       *
       * Counters are deliberately absent: sentCount/failedCount are cumulative across a
       * campaign's batches and resetting them would corrupt progress.
       *
       * rateLimit: the rate this submission is running at, recorded so /status can report
       * it without the browser having to assume the form still shows what was sent.
       * Overwritten every time, which is what makes a restart at a different rate read
       * correctly instead of showing the stopped campaign's.
       */
      const submissionSet = {
        lastError: '',
        sourceFileIds: selectedFileIds,
        inboxPatternId: inboxPatternId || null,
        rateLimit: rateLimitConfig
          ? { limit: rateLimitConfig.limit, intervalSeconds: rateLimitConfig.intervalSeconds }
          : { limit: undefined, intervalSeconds: undefined },
        updatedAt: new Date()
      };
      const submissionUnset = {};

      // A previously stopped campaign is running again. The status has to move back or
      // /status would keep reporting "stopped" while emails were going out, and the
      // retention sweep would treat a live campaign as halted.
      if (emailLog.status === 'stopped' || emailLog.status === 'failed') {
        submissionSet.status = 'in_progress';
        submissionUnset.stoppedAt = '';
        submissionUnset.completedAt = '';
      }

      emailLog = await EmailLog.findOneAndUpdate(
        { sessionId },
        Object.keys(submissionUnset).length > 0
          ? { $set: submissionSet, $unset: submissionUnset }
          : { $set: submissionSet },
        { new: true }
      );

      for (const fileId of selectedFileIds) {
        await UploadedFile.findOneAndUpdate(
          { sessionId: fileId },
          {
            status: 'processing',
            campaignName: `${fromName} - ${subject}`,
            fromEmail,
            subject
          }
        );
      }
    }

    // A test send is a brand-new record with a `test-<timestamp>` id that nothing else
    // can be writing, so it is created with save(). The bulk path applied its
    // per-submission fields atomically above, precisely because a bulk sessionId is
    // shared by every click on that recipient file.
    if (testBulk === 'Test') {
      emailLog.rateLimit = rateLimitConfig
        ? { limit: rateLimitConfig.limit, intervalSeconds: rateLimitConfig.intervalSeconds }
        : { limit: undefined, intervalSeconds: undefined };

      await emailLog.save();
    }

    // A send is the signal that this session is live, so restart the TTL clock on
    // its Redis keys. This is what guarantees a campaign that sends in batches
    // over days or weeks never loses its recipient list or resume position to an
    // expiry; only sessions nobody returns to are allowed to lapse.
    try {
      await touchSessionKeys(redisClient, sessionId);
    } catch (ttlErr) {
      // A refresh failure must not abort a send: the keys still have whatever
      // expiry they were last given.
      logger.warn(`⚠️  Could not refresh Redis TTL for session ${sessionId}: ${ttlErr.message}`);
    }

    // Aligns the live tally with the durable counters before any worker touches
    // it. This only ever does something the first time a session is sent after the
    // tally went missing — a campaign that predates the tally, or one whose key
    // outlived its TTL — and in exactly that case it is what stops /status from
    // reporting a sharp drop to near-zero on the next batch of a campaign that has
    // already sent thousands. HSETNX, so a live tally is never overwritten.
    try {
      await seedEmailStats(redisClient, sessionId, {
        sent: emailLog.sentCount,
        failed: emailLog.failedCount
      });
    } catch (statsErr) {
      // Non-fatal: /status takes the larger of the two sources, so an unseeded
      // tally degrades to the MongoDB counters rather than under-reporting.
      logger.warn(`⚠️  Could not seed live counters for session ${sessionId}: ${statsErr.message}`);
    }

    let finalMessage = message;
    if (isHtml && finalMessage && finalMessage.startsWith('%3C') && !finalMessage.includes('<html')) {
      try {
        finalMessage = decodeURIComponent(finalMessage.replace(/\+/g, '%20'));
        console.log('Successfully auto-decoded URL-encoded HTML payload.');
      } catch (err) {
        console.log('Failed to auto-decode message:', err);
      }
    }

    if (isHtml && finalMessage) {
      const sampleDir = path.join(uploadsDir, 'sample');

      try {
        if (!fs.existsSync(sampleDir)) {
          fs.mkdirSync(sampleDir, { recursive: true });
        }

        // The SMTP password is deliberately NOT recorded here. These sample
        // files persist on disk purely as a rendering preview, and writing the
        // credential into them exposed it to anything that could read the
        // uploads directory — backups, log shippers, host access.
        const metadata = [
          `SMTP Host: ${smtpHost || 'N/A'}`,
          `SMTP Port: ${smtpPort || 'N/A'}`,
          `SMTP User: ${smtpUser || 'N/A'}`,
          `From Name: ${fromName || 'N/A'}`,
          `From Email: ${fromEmail || 'N/A'}`,
          `Subject: ${subject || 'N/A'}`,
          `Custom Headers:\n${customHeaders ? customHeaders.trim() : 'None'}`
        ].join('\n');

        const fileContent = `<!-- MetaData:\n${metadata}\n-->\n${finalMessage}`;

        const contentHash = crypto.createHash('md5').update(fileContent).digest('hex');
        const samplePath = path.join(sampleDir, `sample_${contentHash}.html`);

        if (!fs.existsSync(samplePath)) {
          fs.writeFileSync(samplePath, fileContent, 'utf8');
        }

        const files = fs.readdirSync(sampleDir);
        const htmlFiles = files
          .filter(file => file.endsWith('.html'))
          .map(file => {
            const filePath = path.join(sampleDir, file);
            const stats = fs.statSync(filePath);
            return { name: file, time: stats.mtime.getTime() };
          })
          .sort((a, b) => b.time - a.time);

        if (htmlFiles.length > 10) {
          const filesToDelete = htmlFiles.slice(10);
          filesToDelete.forEach(f => {
            const filePath = path.join(sampleDir, f.name);
            try {
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
              }
            } catch (err) {

              if (err.code !== 'ENOENT') {
                console.error(`Error deleting old sample ${f.name}:`, err);
              }
            }
          });
        }
      } catch (saveErr) {
        console.error('Error saving HTML sample:', saveErr);
      }
    }

    const isAutoImapTest = req.body['auto-imap-test'] === 'on' || req.body['auto-imap-test'] === 'true';
    let testRecords = [];

    if (testBulk === 'Test' && isAutoImapTest) {
      const userId = req.user?.email || 'unknown';
      testRecords = batch.map((entry, index) => {
        const email = entry.email;
        const placeholderMessageId = `pending-${sessionId}-${email}-${index}`;
        return {
          testId: `${sessionId}-${email}-${index}-${Date.now()}`,
          testType: 'auto',
          testEmail: email,
          userId,
          ipAddress: smtpHost || 'unknown',
          status: 'pending',
          subject,
          fromEmail,
          messageId: placeholderMessageId,
          sentAt: new Date()
        };
      });
    }

    res.json({
      status: 'enqueued',
      batchCount,
      testIds: testRecords.map(r => r.testId)
    });

    setImmediate(async () => {
      try {
        const senderDomain = fromEmail.split('@')[1] || 'example.com';

        // No address-keyed source-file index any more. It used to exist because
        // `batch` held bare addresses, so the loop below had to look up which file
        // each one came from — originally an Array#find per recipient, which made
        // this O(n²) (~4s at 40k recipients, ~41min extrapolated at 1M, all in one
        // synchronous block). Every entry now carries its own sourceFile and sendId,
        // so the lookup is gone entirely: O(n) with nothing to index, and an address
        // appearing several times no longer has to resolve to a single file.

        // Attached to every job so the worker can enforce the rate. The scope is
        // the campaign session id, which for a bulk campaign is the recipient
        // file's id and is therefore stable across resumed batches — successive
        // batches of one campaign share a single bucket instead of each getting a
        // fresh allowance.
        const jobRateLimit = rateLimitConfig
          ? {
            limit: rateLimitConfig.limit,
            intervalMs: rateLimitConfig.intervalMs,
            scope: emailLog.sessionId
          }
          : null;

        if (jobRateLimit) {
          logger.force(
            `⏱️  Rate limit configured for ${emailLog.sessionId}: ${rateLimitConfig.limit} emails / ` +
            `${rateLimitConfig.intervalSeconds}s — enqueuing ${batch.length} recipients.`
          );
        }

        const jobs = batch.map((entry, index) => {
          const email = entry.email;

          // Taken from the entry itself rather than looked up by address, so each
          // occurrence keeps the file it actually came from.
          const originalSessionId = entry.sourceFile || emailLog.sessionId;
          const sendId = entry.sendId || '';

          const opts = {
            removeOnComplete: true,
            // Was `false`, which retains every failed job in Redis forever.
            // Each record carries the full payload including the HTML body,
            // so on the production host this accumulated to ~301k keys /
            // 8.36GB with maxmemory unset and a noeviction policy — Redis
            // would have exhausted RAM rather than shed load.
            //
            // A number keeps the most recent N failures for inspection and
            // trims older ones. Per-recipient outcomes are already persisted
            // to Mongo by BatchLogger (EmailLog / EmailLogEntry), so Redis is
            // not the record of truth for what failed.
            removeOnFail: 5000,

            // Was 1, which meant any transient condition lost the recipient
            // permanently on first touch — a dropped TCP connection, a momentary
            // ECONNRESET from the provider, a worker killed mid-send. `sentIndex`
            // has already counted them, so a resumed campaign skips them.
            //
            // 3 attempts with exponential backoff (2s, 4s) gives a blip time to
            // pass. Retries re-enter the worker handler, so a paced campaign
            // re-acquires a rate-limit slot and a retry is counted against the
            // rate like any other send rather than slipping past it.
            //
            // This is a safety net for transient faults, not a way to paper over
            // real rejections: a genuine 550 fails all three attempts quickly and
            // is still recorded as failed, which is correct.
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 }
          };

          if (jobRateLimit) {
            // Pacing hint, not the guarantee — utils/emailRateLimiter is what
            // actually enforces the rate, in the worker, right before the send.
            //
            // Without this every job becomes runnable at once, so all ~700 worker
            // slots would pick one up and then sit blocked on the limiter: the
            // rate would still be correct, but the backlog would be held in
            // worker memory (each job carries the full HTML body) instead of in
            // Redis' delayed set, and a graceful shutdown would have hundreds of
            // parked jobs to unwind. Releasing one window's worth at a time keeps
            // the queue doing the queueing.
            //
            // The index restarts at 0 on a resumed batch, so these delays are
            // only ever approximate; the limiter absorbs the difference.
            const windowIndex = Math.floor(index / jobRateLimit.limit);
            if (windowIndex > 0) {
              opts.delay = windowIndex * jobRateLimit.intervalMs;
            }
          }

          return {
            data: {
              smtp,
              email,
              from,
              subject,
              message: finalMessage,
              isHtml,
              contentTransferEncoding,
              headers,
              messageIdTemplate: processedMessageId,
              senderDomain,
              templateData: {
                fromName,
                toEmail: email,
                subjectLine: subject,
                fromEmail
              },
              logKey,
              sessionId: emailLog.sessionId,
              originalSessionId,
              ...(inboxPatternId ? { inboxPatternId } : {}),
              // Identity of this one send, so that if the job is discarded by a stop
              // the worker can queue *this* send for retry rather than "some send to
              // this address". Without it, three outstanding emails to one recipient
              // are indistinguishable and collapse to one on restart.
              sendId,
              // Omitted entirely when rate limiting is off, so a job looks exactly
              // as it did before this feature and the worker's own check treats it
              // as unthrottled.
              ...(jobRateLimit ? { rateLimit: jobRateLimit } : {})
            },
            opts
          };
        });

        // Enqueued in chunks rather than as one addBulk, for two reasons.
        //
        // The first is the stop. This block runs after the response has been sent,
        // and on a large campaign it can be mapping and writing jobs for a long
        // time — long enough for the operator to click Stop Sending while it is
        // still going. A single addBulk would commit every remaining recipient
        // regardless. Re-reading the marker between chunks means a stop truncates
        // the enqueue instead of racing it, so "no new work is released after the
        // stop is committed" holds for the producer as well as the workers.
        //
        // The second is the resume position. Advancing it per chunk, atomically,
        // means a truncated enqueue leaves `sentIndex` describing what was actually
        // queued. Advancing it once by batch.length after the fact would claim the
        // whole batch had been dealt with and silently skip the remainder on the
        // next send.
        const ENQUEUE_CHUNK_SIZE = 1000;
        let enqueued = 0;
        let stoppedDuringEnqueue = false;

        for (let offset = 0; offset < jobs.length; offset += ENQUEUE_CHUNK_SIZE) {
          if (await isCampaignStopped(redisClient, sessionId)) {
            stoppedDuringEnqueue = true;
            break;
          }

          const chunk = jobs.slice(offset, offset + ENQUEUE_CHUNK_SIZE);
          await emailQueue.addBulk(chunk);
          enqueued += chunk.length;

          // The watermark is NOT advanced here any more. It was moved forward per
          // chunk, after the fact, which left the read-slice-enqueue sequence open to
          // two concurrent submissions claiming the same entries. reserveSendWindow()
          // above now claims the range up front, in the same operation that decides it.
          //
          // A truncated enqueue is still accounted for: the watermark counts what was
          // reserved, and whatever did not make it into the queue is pushed to the
          // resend backlog below, which /status subtracts from work in flight.
        }

        if (stoppedDuringEnqueue) {
          // The recipients that never made it into the queue. They are behind the
          // watermark only if they came from the backlog; either way none of them
          // was enqueued, so recording them here is what keeps them reachable.
          const notEnqueued = batch.slice(enqueued);
          if (notEnqueued.length > 0 && testBulk !== 'Test') {
            // Passed through as-is: each entry already carries its own sourceFile and
            // sendId, so the backlog records exactly which sends were held back.
            await queueForResend(
              redisClient,
              sessionId,
              notEnqueued.map((entry) => ({
                email: entry.email,
                sourceFile: entry.sourceFile || sessionId,
                sendId: entry.sendId || ''
              }))
            );
          }

          logger.force(
            `⏹️  Campaign ${sessionId} was stopped mid-enqueue: ${enqueued} job(s) queued, ` +
            `${notEnqueued.length} recipient(s) held back for a later send.`
          );
        }

        if (testBulk === 'Test' && isAutoImapTest && testRecords.length > 0) {
          try {
            const userId = req.user?.email || 'unknown';

            const deleteResult = await ImapTestResult.deleteMany({
              userId,
              status: { $in: ['inbox', 'spam'] }
            });

            if (deleteResult.deletedCount > 0) {
              logger.info(`🗑️ Deleted ${deleteResult.deletedCount} old completed test results for user ${userId} before sending new tests`);
            }

            await ImapTestResult.insertMany(testRecords);
          } catch (saveErr) {
            console.error('Error saving test email records:', saveErr);
          }
        }
      } catch (bgErr) {
        console.error('Background email enqueue error (session: ' + sessionId + '):', bgErr.message);
      }
    });

  } catch (err) {
    console.error('Error in /send-email:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * The rate this campaign is paced at, and where the current window stands.
 *
 * Both are what the interval popup renders: the configured Limit and Interval, and
 * a countdown to the moment the next slot frees ("Next interval: 00:03"). The
 * countdown comes from the limiter's own bucket, read without consuming anything,
 * so the number the operator watches is the same one the workers are actually
 * gated on rather than a second timer guessing at it in the browser.
 *
 * Returns null when the campaign has no rate configured, which is the signal for
 * the frontend not to show an interval popup at all — an unpaced campaign has no
 * intervals to report.
 */
async function getRateWindowState(sessionId, emailLog) {
  const configured = emailLog && emailLog.rateLimit;
  const limit = Number(configured && configured.limit);
  const intervalSeconds = Number(configured && configured.intervalSeconds);

  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;

  const intervalMs = Math.max(1, Math.ceil(intervalSeconds * 1000));
  const state = { limit, intervalSeconds, intervalMs, used: 0, resetInMs: 0 };

  try {
    const live = await emailRateLimiter.windowState(sessionId, intervalMs);
    state.used = Math.min(limit, live.used);
    state.resetInMs = live.resetInMs;
  } catch (err) {
    // The configured rate is still worth reporting without live window usage; the
    // popup shows Limit and Interval and simply has no countdown this poll.
    logger.debug(`getRateWindowState: window unavailable for ${sessionId}: ${err.message}`);
  }

  return state;
}

router.get('/status', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'No sessionId provided' });

    let total = 0;
    let lastError = '';
    let emailLog = null;

    emailLog = await EmailLog.findOne({ sessionId }, '-entries').sort({ createdAt: -1 });
    if (emailLog) {
      lastError = emailLog.lastError || '';
    }

    // Read from Redis, not from EmailLog.status. The marker is what the workers
    // obey, so it is also what the UI must be told about: if the two ever disagree
    // — a stop committed while MongoDB was unavailable — reporting the marker means
    // the UI matches what is actually happening to the sending.
    const stopRecord = await readCampaignStop(redisClient, sessionId);
    const stopped = stopRecord !== null;

    // Live where possible, durable where not. See getSettledCounts().
    const { sent, failed } = await getSettledCounts(sessionId, emailLog);

    if (sessionId.startsWith('test-')) {
      total = (emailLog && emailLog.totalRecipients) || 0;
    } else {
      // Deliberately not getRecipients(): that read the entire list just to take
      // its length. See getRecipientCount() for the resolution order.
      total = await getRecipientCount(sessionId, emailLog);
    }

    const sentIndex = await getSentIndex(sessionId);

    // Recipients that were enqueued, then had their jobs discarded by a stop. They
    // are counted in sentIndex but are not in flight and never will be.
    const resendQueued = await resendQueueLength(redisClient, sessionId);

    // Enqueued minus settled. Both terms are now current to the same instant:
    // sentIndex is written at enqueue and sent/failed come from the live tally, so
    // this no longer over-reports in-flight work by however far the MongoDB
    // counters happened to be behind.
    //
    // The backlog is subtracted because sentIndex counts work as released and a
    // stop un-releases it. Without this, a stopped campaign would sit showing a
    // Queue of however many recipients it had left, implying sending was continuing
    // — which is precisely the impression a stop has to dispel.
    const sending = Math.max(0, sentIndex - sent - failed - resendQueued);

    // Returned rather than recomputed in the browser. The client used to derive
    // this itself and also wrote an optimistic value at submit, which made Pending
    // the one counter that moved instantly — it was subtracting *enqueued* work
    // from it, not *settled* work — and then contradicted itself on the next poll.
    // One definition, one source: recipients not yet attempted.
    const pending = Math.max(0, total - sent - failed);

    const rateWindow = await getRateWindowState(sessionId, emailLog);

    res.json({
      total,
      sent,
      failed,
      sending,
      pending,
      sentIndex,
      lastError,
      // Stop state. `stopped` is the flag the poller treats as terminal, so the
      // countdown halts and the inputs unlock from the server's answer rather than
      // from the click that requested it — which is what makes a stop issued in
      // another tab, or by another operator, show up here too.
      stopped,
      stoppedAt: (stopRecord && stopRecord.stoppedAt) || null,
      stoppedBy: (stopRecord && stopRecord.stoppedBy) || '',
      campaignStatus: (emailLog && emailLog.status) || null,
      resendQueued,
      // Null for an unpaced campaign: no rate, so no interval to count down.
      rateLimit: rateWindow
        ? { limit: rateWindow.limit, intervalSeconds: rateWindow.intervalSeconds }
        : null,
      window: rateWindow
        ? { used: rateWindow.used, limit: rateWindow.limit, resetInMs: rateWindow.resetInMs }
        : null
    });
  } catch (err) {
    console.error('Error in /status:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/log-download', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'No sessionId provided' });

    const logKey = `emaillog:${sessionId}`;
    const logs = await redisClient.lrange(logKey, 0, -1);

    const entries = await EmailLogEntry.find({ sessionId }).lean();

    if (!entries || !entries.length) return res.status(404).json({ error: 'No logs found' });

    const rows = ['email,status,error,time'];
    entries.forEach(entry => {
      rows.push([
        entry.email,
        entry.status,
        entry.error ? '"' + entry.error.replace(/"/g, '""') + '"' : '',
        entry.time.toISOString()
      ].join(','));
    });

    const csv = rows.join('\n');

    res.setHeader('Content-disposition', `attachment; filename=emaillog-${sessionId}.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csv);
  } catch (err) {
    console.error('Error in log download:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sortBy = req.query.sortBy || 'createdAt';
    const sortOrder = req.query.sortOrder || 'desc';

    const logs = await EmailLog.findLogsWithPagination(page, limit, sortBy, sortOrder);
    const totalLogs = await EmailLog.estimatedDocumentCount();
    const totalPages = Math.ceil(totalLogs / limit);

    res.json({
      logs,
      pagination: {
        page,
        limit,
        totalLogs,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (err) {
    console.error('Error fetching logs:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const log = await EmailLog.findOne({ sessionId });

    if (!log) {
      return res.status(404).json({ error: 'Log not found' });
    }

    res.json(log);
  } catch (err) {
    console.error('Error fetching log:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs-stats', async (req, res) => {
  try {
    const stats = await EmailLog.getStatistics();
    res.json(stats[0] || {
      totalCampaigns: 0,
      totalEmails: 0,
      totalSent: 0,
      totalFailed: 0,
      completedCampaigns: 0,
      inProgressCampaigns: 0
    });
  } catch (err) {
    console.error('Error fetching log statistics:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/logs/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await EmailLog.deleteOne({ sessionId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Log not found' });
    }

    const entryResult = await EmailLogEntry.deleteMany({ campaignId: sessionId });

    // The log's Redis trail goes with it. Only that key: `recipients:` and
    // `sentIndex:` belong to the recipient file, which still exists.
    const redisKeysDeleted = await dropEmailLogKey(redisClient, sessionId);

    res.json({
      success: true,
      message: 'Log and related entries deleted successfully',
      deletedLogs: result.deletedCount,
      deletedEntries: entryResult.deletedCount || 0,
      redisKeysDeleted
    });
  } catch (err) {
    console.error('Error deleting log:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/logs', async (req, res) => {
  try {
    // Both counts come from their own deleteMany result. This previously
    // reported `result.deletedCount` without ever declaring `result`, so a
    // successful wipe threw a ReferenceError and returned 500 — the data was
    // gone but the caller was told the request had failed.
    const logResult = await EmailLog.deleteMany({});
    const entryResult = await EmailLogEntry.deleteMany({});

    const deletedLogs = logResult.deletedCount || 0;
    const deletedEntries = entryResult.deletedCount || 0;

    // Every campaign's Redis trail, since every campaign log just went.
    const redisKeysDeleted = await dropAllEmailLogKeys(redisClient);

    res.json({
      success: true,
      message: `All ${deletedLogs} logs and their entries deleted successfully`,
      deletedLogs,
      deletedEntries,
      redisKeysDeleted
    });
  } catch (err) {
    console.error('Error deleting all logs:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/logs/:sessionId/download', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const log = await EmailLog.findOne({ sessionId });

    if (!log) {
      return res.status(404).json({ error: 'Log not found' });
    }

    const entries = await EmailLogEntry.find({ sessionId }).lean();

    const rows = ['email,status,error,time'];
    entries.forEach(entry => {
      rows.push([
        entry.email,
        entry.status,
        entry.error ? '"' + entry.error.replace(/"/g, '""') + '"' : '',
        entry.time.toISOString()
      ].join(','));
    });

    const csv = rows.join('\n');

    res.setHeader('Content-disposition', `attachment; filename=emaillog-${sessionId}.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csv);
  } catch (err) {
    console.error('Error downloading log:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sortBy = req.query.sortBy || 'uploadDate';
    const sortOrder = req.query.sortOrder || 'desc';

    const files = await UploadedFile.findFilesWithPagination(page, limit, sortBy, sortOrder);
    const totalFiles = await UploadedFile.countDocuments();
    const totalPages = Math.ceil(totalFiles / limit);

    res.json({
      files,
      pagination: {
        page,
        limit,
        totalFiles,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (err) {
    console.error('Error fetching files:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files-stats', async (req, res) => {
  try {
    const stats = await UploadedFile.getFileStatistics();
    res.json(stats[0] || {
      totalFiles: 0,
      totalEmails: 0,
      totalValidEmails: 0,
      totalSentEmails: 0,
      totalFailedEmails: 0,
      totalPendingEmails: 0,
      completedFiles: 0,
      processingFiles: 0
    });
  } catch (err) {
    console.error('Error fetching file statistics:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files/:sessionId/original', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const file = await UploadedFile.findOne({ sessionId });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!fs.existsSync(file.storedPath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.download(file.storedPath, file.originalName);
  } catch (err) {
    console.error('Error downloading original file:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files/:sessionId/sent', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const log = await EmailLog.findOne({ sessionId });

    const entries = await EmailLogEntry.find({ sessionId, status: 'sent' }).lean();
    const sentEmails = entries.map(entry => entry.email);

    const csv = ['email\n' + sentEmails.join('\n')];

    res.setHeader('Content-disposition', `attachment; filename=sent-emails-${sessionId}.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csv.join('\n'));
  } catch (err) {
    console.error('Error downloading sent emails:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files/:sessionId/failed', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const log = await EmailLog.findOne({ sessionId });

    const entries = await EmailLogEntry.find({ sessionId, status: 'failed' }).lean();
    const failedEmails = entries.map(entry => `${entry.email},${entry.error || ''}`);

    const csv = ['email,error\n' + failedEmails.join('\n')];

    res.setHeader('Content-disposition', `attachment; filename=failed-emails-${sessionId}.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csv.join('\n'));
  } catch (err) {
    console.error('Error downloading failed emails:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files/:sessionId/pending', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const file = await UploadedFile.findOne({ sessionId });
    const log = await EmailLog.findOne({ sessionId });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    const originalEmails = await getRecipients(sessionId);

    const entries = await EmailLogEntry.find({ sessionId }).select('email sendId').lean();

    // Reconciled per send, never by address.
    //
    // `originalEmails.filter(e => !processedSet.has(e))` used to do this, which
    // dropped every occurrence of an address as soon as one of them had been sent: a
    // file listing bob@example.com three times with one send completed reported
    // nothing pending for bob instead of two.
    //
    // Rows carrying a sendId are matched exactly — `<sessionId>#<index>` names the
    // position in this file's list, so the specific occurrence is marked done and the
    // others stay pending. Rows without one predate the field, so they fall back to a
    // per-address tally: still multiplicity-correct (one row settles one occurrence),
    // just not tied to a particular position. Order is preserved either way.
    const settledSendIds = new Set();
    const settledCounts = new Map();

    for (const entry of entries) {
      if (entry.sendId) {
        settledSendIds.add(entry.sendId);
      } else {
        settledCounts.set(entry.email, (settledCounts.get(entry.email) || 0) + 1);
      }
    }

    const pendingEmails = [];
    originalEmails.forEach((email, indexInFile) => {
      if (settledSendIds.has(`${sessionId}#${indexInFile}`)) return;

      const remaining = settledCounts.get(email) || 0;
      if (remaining > 0) {
        settledCounts.set(email, remaining - 1);
        return;
      }

      pendingEmails.push(email);
    });

    const csv = ['email\n' + pendingEmails.join('\n')];

    res.setHeader('Content-disposition', `attachment; filename=pending-emails-${sessionId}.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csv.join('\n'));
  } catch (err) {
    console.error('Error downloading pending emails:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/files/delete-all', async (req, res) => {
  console.log('🗑️ DELETE ALL FILES ROUTE HIT');
  try {

    const files = await UploadedFile.find({});
    console.log(`📊 Found ${files.length} files to delete`);

    if (files.length === 0) {
      console.log('⚠️ No files to delete');
      return res.json({ message: 'No files to delete', deletedCount: 0 });
    }

    let deletedCount = 0;
    let failedCount = 0;
    let redisKeysDeleted = 0;

    for (const file of files) {
      try {
        console.log(`🗑️ Deleting file: ${file.sessionId} - ${file.originalName}`);

        if (fs.existsSync(file.storedPath)) {
          fs.unlinkSync(file.storedPath);
          console.log(`✅ Deleted from disk: ${file.storedPath}`);
        } else {
          console.log(`⚠️ File not found on disk: ${file.storedPath}`);
        }

        await UploadedFile.deleteOne({ sessionId: file.sessionId });
        console.log(`✅ Deleted from database: ${file.sessionId}`);

        // Without this the recipient list, resume position and log trail stayed
        // in Redis with no owning row and nothing left to ever clean them up.
        const keysDropped = await dropSessionKeys(redisClient, file.sessionId);
        redisKeysDeleted += keysDropped;

        deletedCount++;
      } catch (err) {
        console.error(`❌ Error deleting file ${file.sessionId}:`, err);
        failedCount++;
      }
    }
    console.log(`✅ Delete all complete: ${deletedCount} deleted, ${failedCount} failed`);
    res.json({
      success: true,
      message: `Successfully deleted ${deletedCount} files. Campaign logs are preserved for history.`,
      deletedCount,
      failedCount,
      redisKeysDeleted
    });
  } catch (err) {
    console.error('❌ Error deleting all files:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/files/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const file = await UploadedFile.findOne({ sessionId });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (fs.existsSync(file.storedPath)) {
      fs.unlinkSync(file.storedPath);
    }

    await UploadedFile.deleteOne({ sessionId });

    // The row is gone, so nothing would ever reclaim these keys again.
    const redisKeysDeleted = await dropSessionKeys(redisClient, sessionId);

    res.json({
      success: true,
      message: 'File deleted successfully. Campaign logs are preserved for history.',
      redisKeysDeleted
    });
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

/**
 * Exposed for tests. This is the rule that decides whether a send uses the
 * password in the request or the one stored for the operator, which is what makes
 * it safe for the browser to discard an autofilled password rather than submit it
 * (see discardUngesturedPassword in public/js/form-persistence.js). An express
 * Router is a function, so hanging a property off it leaves `app.use(router)`
 * working exactly as before.
 */
module.exports.resolveSmtpPass = resolveSmtpPass;

/**
 * Shared with routes/campaignQueue.js, which sequences one operator's campaigns and
 * needs the same definition of progress and completion this file already serves to
 * /status. Exported rather than duplicated so the two can never disagree about
 * whether a campaign has finished.
 */
module.exports.readCampaignProgress = readCampaignProgress;
module.exports.markCampaignTerminal = markCampaignTerminal;

/**
 * Exported for tests. `parseLimitToSend` is the authoritative validation for the
 * per-action cap, and `reserveSendWindow` is the atomic range reservation that makes two
 * simultaneous Send Email clicks claim disjoint entries instead of the same ones.
 */
module.exports.parseLimitToSend = parseLimitToSend;
module.exports.reserveSendWindow = reserveSendWindow;
module.exports.LIMIT_TO_SEND_MIN = LIMIT_TO_SEND_MIN;
module.exports.LIMIT_TO_SEND_MAX = LIMIT_TO_SEND_MAX;
