const mongoose = require('mongoose');

const emailLogEntrySchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    index: true,
    description: "The source file ID for bulk emails, or the test campaign ID for test emails"
  },
  campaignId: {
    type: String,
    required: true,
    index: true,
    description: "The ID of the campaign that sent this email"
  },
  email: {
    type: String,
    required: true,
    trim: true,
    index: true
  },

  /**
   * Which individual send this row records, as `<sourceFile>#<indexInThatFile>`.
   *
   * A recipient list is a list of sends, so the same address can legitimately appear
   * several times and each occurrence is sent, logged and resumed on its own. The
   * address cannot identify a row; this can.
   *
   * Indexed but deliberately NOT unique. A unique index here would re-introduce
   * deduplication through the back door — the second send to a duplicated recipient
   * would fail to log — and retries mean one send can legitimately produce more than
   * one row. Absent on rows written before this field existed.
   */
  sendId: {
    type: String,
    trim: true,
    index: true
  },

  status: {
    type: String,
    enum: ['sent', 'failed'],
    required: true,
    index: true
  },
  error: {
    type: String,
    trim: true
  },
  time: {
    type: Date,
    default: Date.now,
    index: true
  }
});

emailLogEntrySchema.index({ sessionId: 1, status: 1 });

module.exports = mongoose.model('EmailLogEntry', emailLogEntrySchema);
