const mongoose = require('mongoose');

const testEmailAccountSchema = new mongoose.Schema({

  email: {
    type: String,
    required: true,
    trim: true,
    unique: true
  },

    password: {
    type: String,
    required: true,
    select: false
  },
  addedAt: {
    type: Date,
    default: Date.now
  }
});

const imapCredentialsSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  host: {
    type: String,
    trim: true,
    default: ''
  },
  port: {
    type: Number,
    default: 993
  },
  ssl: {
    type: Boolean,
    default: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const TestEmailAccount = mongoose.model('TestEmailAccount', testEmailAccountSchema);
const ImapCredentials = mongoose.model('ImapCredentials', imapCredentialsSchema);

module.exports = { TestEmailAccount, ImapCredentials };
