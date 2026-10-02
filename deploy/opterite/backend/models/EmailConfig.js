const mongoose = require('mongoose');

/**
 * The operator's stored SMTP password, and nothing else.
 *
 * This collection used to hold a verbatim snapshot of the whole campaign form on
 * /interface — host, port, subject, message body, recipients, send rate, the lot —
 * as one document per user. That was wrong on two counts. It wrote to MongoDB on a
 * debounce timer every time anything was typed into the form, for data the server
 * never reads back: /send-email receives every one of those fields in the request
 * body. And because there was exactly one document per login email, every open tab
 * read and wrote the same row, so two tabs could not hold different drafts. The
 * form state now lives in each tab's sessionStorage in the React frontend,
 * which gives per-tab isolation for free and costs the database nothing.
 *
 * What is left is the one field that genuinely has to persist server-side. The
 * password field is deliberately never repopulated in the browser, so after a
 * refresh it is empty and `resolveSmtpPass` in routes/sendemails.js substitutes the
 * stored credential. Keeping it here rather than in sessionStorage is the whole
 * reason this model still exists: it must be encrypted at rest, which only the
 * server can do.
 *
 * Scoped on `userId` (the login email from `req.user.email`) exactly like
 * `ImapCredentials`, which keeps one operator's credential invisible to another
 * even when they share a machine and browser profile. One document per user is
 * the correct shape for a credential store, so `unique` stays.
 *
 * `smtpPass` holds AES-256-GCM ciphertext produced by utils/credentialCipher and
 * is `select:false`, following the same shape as `TestEmailAccount.password`.
 *
 * Documents written by the previous implementation still carry the retired form
 * fields. Mongoose ignores paths that are not in the schema, so they are inert and
 * need no migration; they can be dropped at leisure with a one-off
 * `$unset`. The `userId` index and every stored `smtpPass` ciphertext are
 * unchanged, so existing operators keep their saved password.
 */
const emailConfigSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },

  smtpPass: {
    type: String,
    default: '',
    select: false
  },

  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('EmailConfig', emailConfigSchema);
