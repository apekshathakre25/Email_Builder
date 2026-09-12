const mongoose = require('mongoose');

const uploadedFileSchema = new mongoose.Schema({
  originalName: {
    type: String,
    required: true,
    trim: true
  },
  storedPath: {
    type: String,
    required: true,
    trim: true
  },
  fileSize: {
    type: Number,
    required: true
  },
  fileType: {
    type: String,
    required: true,
    trim: true
  },
  uploadDate: {
    type: Date,
    default: Date.now
  },
  sessionId: {
    type: String,
    required: true,
    index: true
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
  },
  sentEmails: {
    type: Number,
    default: 0
  },
  failedEmails: {
    type: Number,
    default: 0
  },
  pendingEmails: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['uploaded', 'processing', 'completed', 'failed'],
    default: 'uploaded'
  },
  campaignName: {
    type: String,
    trim: true,
    default: 'Bulk Email Campaign'
  },
  fromEmail: {
    type: String,
    trim: true
  },
  subject: {
    type: String,
    trim: true
  }
});


uploadedFileSchema.virtual('completionPercentage').get(function () {
  if (this.validEmails === 0) return 0;
  return Math.round(((this.sentEmails + this.failedEmails) / this.validEmails) * 100);
});


uploadedFileSchema.virtual('successRate').get(function () {
  if (this.sentEmails + this.failedEmails === 0) return 0;
  return Math.round((this.sentEmails / (this.sentEmails + this.failedEmails)) * 100);
});


uploadedFileSchema.statics.findFilesWithPagination = function (page = 1, limit = 10, sortBy = 'uploadDate', sortOrder = 'desc') {
  const skip = (page - 1) * limit;
  const sort = {};
  sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

  return this.find()
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .lean();
};


uploadedFileSchema.statics.getFileStatistics = function () {
  return this.aggregate([
    {
      $group: {
        _id: null,
        totalFiles: { $sum: 1 },
        totalEmails: { $sum: '$totalEmails' },
        totalValidEmails: { $sum: '$validEmails' },
        totalSentEmails: { $sum: '$sentEmails' },
        totalFailedEmails: { $sum: '$failedEmails' },
        totalPendingEmails: { $sum: '$pendingEmails' },
        completedFiles: {
          $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
        },
        processingFiles: {
          $sum: { $cond: [{ $eq: ['$status', 'processing'] }, 1, 0] }
        }
      }
    }
  ]);
};

module.exports = mongoose.model('UploadedFile', uploadedFileSchema);
