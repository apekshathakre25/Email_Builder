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
  status: {
    type: String,
    enum: ['in_progress', 'completed', 'failed'],
    default: 'in_progress'
  }
});

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
