const mongoose = require('mongoose');
const env = require('../config/env');

// Named explicitly rather than letting MongoDB derive "createdAt_1", so the
// boot-time reconciler in utils/dbCleanup.js can find this exact index and
// adjust its expiry when DB_CLEANUP_DAYS changes.
const TTL_INDEX_NAME = 'createdAt_ttl';

const imapTestResultSchema = new mongoose.Schema({
  testId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  testType: {
    type: String,
    enum: ['auto', 'manual'],
    required: true
  },
  testEmail: {
    type: String,
    required: true,
    trim: true
  },
  ipAddress: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    enum: ['pending', 'inbox', 'spam', 'not_found'],
    default: 'pending'
  },
  subject: {
    type: String,
    trim: true
  },
  fromEmail: {
    type: String,
    trim: true
  },
  userId: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  messageId: {
    type: String,
    trim: true
  },
  sentAt: {
    type: Date,
    default: Date.now
  },
  checkedAt: {
    type: Date
  },
  /**
   * `rawHeaders` and `rawBody` were removed: they were persisted on every
   * checked test but never read back, and `fullRaw` already holds the complete
   * message source, headers included. Storing all three meant roughly three
   * copies of each test message.
   *
   * `fullRaw` stays because the details modal has a Raw Email tab that renders
   * it. It is the largest field here, which is why this collection carries the
   * TTL index below.
   *
   * Documents written before this change keep their old fields; they are not
   * migrated, they simply age out under the retention policy.
   */
  emailDetails: {
    messageId: String,
    uid: Number,
    preview: String,
    hasAttachments: Boolean,
    fullRaw: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

imapTestResultSchema.index({ testType: 1, createdAt: -1 });
imapTestResultSchema.index({ testEmail: 1, sentAt: -1 });
imapTestResultSchema.index({ userId: 1, status: 1, createdAt: -1 });

/**
 * TTL index — MongoDB expires these documents itself, without the app running.
 *
 * This collection is the one safe place for a blind TTL. A test result is
 * write-once and read only while the operator is looking at that test: the send
 * path in routes/sendemails.js already deletes a user's finished (inbox/spam)
 * results the moment they start a new test run, and nothing joins to these
 * documents. A `pending` record that nobody matched within the retention window
 * is a dead test, not live state.
 *
 * Contrast EmailLogEntry, which deliberately has no TTL: a campaign can outlive
 * the retention window, and expiring its early entries mid-send would corrupt
 * the pending-recipients export.
 *
 * `expireAfterSeconds` is derived from DB_CLEANUP_DAYS. Because MongoDB rejects
 * re-creating an existing index with different options, changing that variable
 * requires a collMod rather than a plain createIndex — utils/dbCleanup.js
 * reconciles it on boot, which is what makes the .env value take effect on
 * restart. The sweep also covers this collection by age, so the app stays
 * correct even if the TTL index cannot be created (e.g. insufficient rights).
 */
imapTestResultSchema.index(
  { createdAt: 1 },
  {
    name: TTL_INDEX_NAME,
    expireAfterSeconds: env.dbCleanup.retentionSeconds
  }
);

const ImapTestResult = mongoose.model('ImapTestResult', imapTestResultSchema);

// Exposed on the model so the reconciler and the schema cannot drift apart on
// the index name. The default export stays the model itself, which is what every
// existing require() of this file expects.
ImapTestResult.TTL_INDEX_NAME = TTL_INDEX_NAME;

module.exports = ImapTestResult;
