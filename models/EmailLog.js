const mongoose = require('mongoose');

const emailLogSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  campaignName: {
    type: String,
    trim: true,
    default: 'Bulk Email Campaign'
  },
  fromEmail: {
    type: String,
    required: true,
    trim: true
  },
  fromName: {
    type: String,
    trim: true
  },
  subject: {
    type: String,
    required: true,
    trim: true
  },
  messageType: {
    type: String,
    enum: ['Plain', 'HTML'],
    default: 'Plain'
  },
  totalRecipients: {
    type: Number,
    required: true,
    default: 0
  },
  sentCount: {
    type: Number,
    default: 0
  },
  failedCount: {
    type: Number,
    default: 0
  },
  pendingCount: {
    type: Number,
    default: 0
  },
  batchLimit: {
    type: Number,
    default: 0
  },
  smtpHost: {
    type: String,
    trim: true
  },
  customHeaders: {
    type: Map,
    of: String,
    default: new Map()
  },
  recipientFile: {
    originalName: {
      type: String,
      trim: true
    },
    storedPath: {
      type: String,
      trim: true
    },
    fileSize: {
      type: Number
    },
    uploadDate: {
      type: Date,
      default: Date.now
    },
    totalEmails: {
      type: Number,
      default: 0
    },
    validEmails: {
      type: Number,
      default: 0
    },
    invalidEmails: {
      type: Number,
      default: 0
    }
  },
  lastError: {
    type: String,
    trim: true,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  completedAt: {
    type: Date
  },
  /**
   * When the operator stopped the campaign. Cleared when it is started again.
   *
   * Recorded separately from `completedAt` because the two mean different things:
   * a completed campaign reached every recipient, a stopped one was cut short and
   * usually still has pending recipients the operator may come back for.
   */
  stoppedAt: {
    type: Date
  },
  /**
   * The send rate the campaign is currently configured for, as accepted by the
   * last submission.
   *
   * Persisted because it was previously only attached to individual Bull jobs,
   * which meant the only way to answer "what rate is this campaign running at?"
   * was to read a job out of the queue. /status reports these so the interval
   * popup can show Limit and Interval without the browser having to assume the
   * form still holds the values that were actually submitted.
   *
   * Overwritten on every send, which is what makes a restart honest: stop a
   * campaign running 35/5s, resubmit at 100/10s, and this says 100/10s.
   */
  rateLimit: {
    limit: {
      type: Number
    },
    intervalSeconds: {
      type: Number
    }
  },
  /**
   * Every recipient file this campaign draws from.
   *
   * A bulk campaign's sessionId is only the *first* selected file's id, so the
   * others were previously unrecoverable from the campaign record. Stopping a
   * campaign needs all of them, to return each file from `processing` to
   * `uploaded` rather than leaving the extras looking permanently mid-send.
   */
  sourceFileIds: {
    type: [String],
    default: []
  },
  status: {
    type: String,
    // 'stopped' is terminal-but-resumable: the operator halted it and may submit
    // the remaining recipients later. Kept distinct from 'failed', which means the
    // sending itself went wrong, and from 'completed', which means nobody is left.
    enum: ['in_progress', 'completed', 'failed', 'stopped'],
    default: 'in_progress'
  }
});

/**
 * Supports the retention sweep in utils/dbCleanup.js, which selects on
 * { status: { $ne: 'in_progress' }, createdAt: { $lt: cutoff } }.
 *
 * status leads because it is the equality-ish predicate and createdAt is the
 * range, which is the order a compound index can actually serve. Without this
 * the sweep collection-scans every campaign ever recorded on each run.
 *
 * Also serves the default `/logs` listing, which sorts on createdAt.
 */
emailLogSchema.index({ status: 1, createdAt: 1 });

emailLogSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

emailLogSchema.virtual('totalProcessed').get(function () {
  return this.sentCount + this.failedCount;
});

emailLogSchema.virtual('completionPercentage').get(function () {
  if (this.totalRecipients === 0) return 0;
  return Math.round((this.totalProcessed / this.totalRecipients) * 100);
});

emailLogSchema.methods.addEntry = async function (email, status, error = null) {

  if (status === 'sent') {
    this.sentCount++;
  } else if (status === 'failed') {
    this.failedCount++;
    if (error) this.lastError = error;
  }

  this.pendingCount = Math.max(0, this.totalRecipients - (this.sentCount + this.failedCount));

  if (this.pendingCount === 0) {
    this.status = 'completed';
    this.completedAt = new Date();
  }

  return this.save();
};

emailLogSchema.statics.findLogsWithPagination = function (page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc') {
  const skip = (page - 1) * limit;
  const sort = {};
  sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

  return this.find()
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .select('-entries')
    .lean();
};

emailLogSchema.statics.getStatistics = function () {
  return this.aggregate([
    {
      $group: {
        _id: null,
        totalCampaigns: { $sum: 1 },
        totalEmails: { $sum: '$totalRecipients' },
        totalSent: { $sum: '$sentCount' },
        totalFailed: { $sum: '$failedCount' },
        completedCampaigns: {
          $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
        },
        inProgressCampaigns: {
          $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] }
        }
      }
    }
  ]);
};

module.exports = mongoose.model('EmailLog', emailLogSchema);
