const mongoose = require('mongoose');

/**
 * Per-user draft of the campaign form on /interface, so a browser refresh does
 * not discard what the operator typed.
 *
 * Scoped on `userId` (the login email from `req.user.email`) exactly like
 * `ImapCredentials`, which keeps one operator's SMTP configuration invisible to
 * another even when they share a machine and browser profile.
 *
 * Values are stored as strings rather than coerced to Number/Boolean because
 * this is a verbatim snapshot of form controls: an empty port and a port of 0
 * are different states to restore, and the form's own inputs are text.
 *
 * `smtpPass` holds AES-256-GCM ciphertext produced by utils/credentialCipher and
 * is `select:false`, following the same shape as `TestEmailAccount.password`.
 */
const emailConfigSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },

  smtpHost: { type: String, default: '' },
  smtpPort: { type: String, default: '' },
  smtpUser: { type: String, default: '' },

  smtpPass: {
    type: String,
    default: '',
    select: false
  },

  customHeaders: { type: String, default: '' },
  fromEmail: { type: String, default: '' },
  subject: { type: String, default: '' },
  fromName: { type: String, default: '' },
  testRecipients: { type: String, default: '' },

  // 'Bulk' | 'Test'. Mirrors the test-bulk radio group.
  testBulk: { type: String, default: '' },

  // '' | 'Plain' | 'HTML'. Empty is a real state: neither radio starts checked.
  messageType: { type: String, default: '' },

  message: { type: String, default: '' },
  fileIds: { type: String, default: '' },
  customMessageId: { type: String, default: '' },
  limit: { type: String, default: '' },

  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('EmailConfig', emailConfigSchema);
