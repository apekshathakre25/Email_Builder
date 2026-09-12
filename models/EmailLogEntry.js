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
