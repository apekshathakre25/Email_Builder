const mongoose = require('mongoose');

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
  emailDetails: {
    messageId: String,
    uid: Number,
    preview: String,
    hasAttachments: Boolean,
    rawHeaders: String,
    rawBody: String,
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

module.exports = mongoose.model('ImapTestResult', imapTestResultSchema);
