require('dotenv').config();
// First require: validates configuration so the worker fails fast on a bad
// deployment rather than starting and failing per-job.
const env = require('../config/env');
const emailQueue = require('./queue');
const nodemailer = require('nodemailer');
const createRedisClient = require('../config/redis');
const client = createRedisClient();
const EmailLog = require('../models/EmailLog');
const EmailLogEntry = require('../models/EmailLogEntry');
const UploadedFile = require('../models/UploadedFile');
const ImapTestResult = require('../models/ImapTestResult');
const { generateMessageId } = require('../utils/messageIdGenerator');
const { convert: convertHtmlToText } = require('html-to-text');
const logger = require('../utils/logger');


const mongoose = require('mongoose');
const connectMongoDB = require('../config/mongodb');


connectMongoDB();


if (env.isProduction) {
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  
}


const CONCURRENCY = env.workerConcurrency;

logger.force(`🚀 Email worker started with concurrency: ${CONCURRENCY}`);
logger.force(`📧 This worker can process ${CONCURRENCY} emails simultaneously`);

const log = logger.log;
const logError = logger.error;


const TEMPLATE_PATTERNS = {
  fromName: /\{\{FromName\}\}/g,
  toEmail: /\{\{ToEmail\}\}/g,
  subjectLine: /\{\{SubjectLine\}\}/g,
  fromEmail: /\{\{FromEmail\}\}/g,
  messageId: /\{\{MessageId\}\}/g,
  rfcDate: /\[\[RFC_Date_EST\]\]/g
};


class BatchLogger {
  constructor(flushInterval = 2000, batchSize = 100) {
    this.buffers = new Map();
    this.flushInterval = flushInterval;
    this.batchSize = batchSize;
    this.isFlushing = false;


    setInterval(() => this.flushAll(), this.flushInterval);
  }

  async addLog(campaignId, type, email, error = null, originalSessionId = null) {
    if (!campaignId) return;

    const fileId = originalSessionId || campaignId;
    const bufferKey = `${campaignId}:${fileId}`;

    if (!this.buffers.has(bufferKey)) {
      this.buffers.set(bufferKey, {
        campaignId: campaignId,
        fileId: fileId,
        sentCount: 0,
        failedCount: 0,
        entries: [],
        lastUpdated: Date.now()
      });
    }

    const buffer = this.buffers.get(bufferKey);
    
    if (type === 'sent') {
      buffer.sentCount++;
    } else {
      buffer.failedCount++;
    }

    buffer.entries.push({
      email,
      status: type,
      error: error,
      time: new Date()
    });

    if (buffer.entries.length >= this.batchSize) {
      await this.flush(bufferKey);
    }
  }

  async flush(bufferKey) {
    const buffer = this.buffers.get(bufferKey);
    if (!buffer || (buffer.sentCount === 0 && buffer.failedCount === 0)) return;


    this.buffers.delete(bufferKey);

    try {
      const { campaignId, fileId } = buffer;


      const entriesToInsert = buffer.entries.map(entry => ({
        ...entry,
        sessionId: fileId,     
        campaignId: campaignId 
      }));
      
      await EmailLogEntry.insertMany(entriesToInsert);


      let lastError = '';
      if (buffer.failedCount > 0) {
        const lastFailedEntry = [...buffer.entries].reverse().find(e => e.status === 'failed');
        if (lastFailedEntry) lastError = lastFailedEntry.error;
      }


      const emailLogUpdate = {
        $inc: { 
          sentCount: buffer.sentCount, 
          failedCount: buffer.failedCount,
          pendingCount: -(buffer.sentCount + buffer.failedCount)
        },
        $set: { updatedAt: new Date() }
      };

      if (lastError) {
        emailLogUpdate.$set.lastError = lastError;
      }

      await EmailLog.updateOne({ sessionId: campaignId }, emailLogUpdate);


      await UploadedFile.findOneAndUpdate(
        { sessionId: fileId },
        { 
          $inc: { 
            sentEmails: buffer.sentCount, 
            failedEmails: buffer.failedCount,
            pendingEmails: -(buffer.sentCount + buffer.failedCount)
          } 
        }
      );
      

    } catch (err) {
      logger.error('❌ Failed to flush batch logs:', err.message);
    }
  }

  async flushAll() {
    if (this.isFlushing) return;
    this.isFlushing = true;
    
    const sessIds = Array.from(this.buffers.keys());
    for (const sid of sessIds) {
      await this.flush(sid);
    }
    
    this.isFlushing = false;
  }
}

const batchLogger = new BatchLogger();



const transporterCache = new Map();


function getTransporter(smtp) {
  const key = JSON.stringify(smtp);

  if (!transporterCache.has(key)) {
    log('Creating new SMTP transporter with connection pooling');
    const transporter = nodemailer.createTransport({
      ...smtp,
      pool: true,
      maxConnections: 50,
      maxMessages: Infinity,
      rateDelta: 1000,
      rateLimit: 500 
    });

    transporterCache.set(key, transporter);


    transporter.on('error', (err) => {
      logError('Transporter error:', err.message);
      transporterCache.delete(key);
    });
  }

  return transporterCache.get(key);
}


const replaceTemplateVars = (str, data) => {
  if (!str || typeof str !== 'string') return str;


  const messageId = `<${Date.now()}.${Math.random().toString(36).substr(2, 9)}@${data.fromEmail?.split('@')[1] || 'mail.local'}>`;


  const rfcDate = new Date().toUTCString();


  return str
    .replace(TEMPLATE_PATTERNS.fromName, data.fromName || '')
    .replace(TEMPLATE_PATTERNS.toEmail, data.toEmail || '')
    .replace(TEMPLATE_PATTERNS.subjectLine, data.subjectLine || '')
    .replace(TEMPLATE_PATTERNS.fromEmail, data.fromEmail || '')
    .replace(TEMPLATE_PATTERNS.messageId, messageId)
    .replace(TEMPLATE_PATTERNS.rfcDate, rfcDate);
};


emailQueue.process(CONCURRENCY, async (job) => {
  log(`Processing job ${job.id} for email: ${job.data.email}`);

  const { smtp, email, from, subject, message, isHtml, headers, templateData, logKey, sessionId, messageIdTemplate, senderDomain } = job.data;

  try {

    const transporter = getTransporter(smtp);


    let processedHeaders = {};

    if (headers && Object.keys(headers).length > 0 && templateData) {
      for (const [key, value] of Object.entries(headers)) {
        processedHeaders[key] = replaceTemplateVars(value, templateData);
      }
      log('✅ Template variables replaced in headers');
    } else {
      processedHeaders = headers || {};
    }


    if (messageIdTemplate && senderDomain) {
      const uniqueMessageId = generateMessageId(messageIdTemplate, senderDomain);
      processedHeaders['Message-ID'] = uniqueMessageId;
      log(`Generated unique Message-ID: ${uniqueMessageId}`);
    }


    let customFrom = from;
    let customHeaders = {};

    if (processedHeaders && Object.keys(processedHeaders).length > 0) {
      customHeaders = { ...processedHeaders };

      const fromHeaderKey = Object.keys(customHeaders).find(
        key => key.toLowerCase() === 'from'
      );

      if (fromHeaderKey) {
        customFrom = customHeaders[fromHeaderKey];
        delete customHeaders[fromHeaderKey];
        log(`Using custom From header: ${customFrom}`);
      }
    }

    const mailOptions = {
      from: customFrom,
      to: email,
      subject
    };
    if (isHtml) {
      mailOptions.html = message;
      try {

        mailOptions.text = convertHtmlToText(message, {
          wordwrap: 130,
          selectors: [
            { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
            { selector: 'img', format: 'skip' }
          ]
        });
      } catch (err) {
        logError('Error converting HTML to text:', err);

        mailOptions.text = message.replace(/<[^>]*>?/gm, '');
      }
    } else {
      mailOptions.text = message;
    }


    if (Object.keys(customHeaders).length > 0) {
      mailOptions.headers = customHeaders;
    }

    await transporter.sendMail(mailOptions);




    if (sessionId) {
      const originalSessionId = job.data.originalSessionId || sessionId;
      batchLogger.addLog(sessionId, 'sent', email, null, originalSessionId);


      if (sessionId.startsWith('test-')) {
        const actualMessageId = customHeaders['Message-ID'] || mailOptions.messageId || 'unknown';
        const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await ImapTestResult.findOneAndUpdate(
          {
            testEmail: email,
            status: 'pending',
            messageId: { $regex: `^pending-${sessionId}-${escapedEmail}-` }
          },
          {
            messageId: actualMessageId,
            $set: { sentAt: new Date() }
          },
          { sort: { createdAt: -1 } }
        ).catch(err => logger.error(`⚠️ Could not update test record: ${err.message}`));
      }
    }


    await client.rpush(logKey, JSON.stringify({ email, status: 'sent', time: Date.now() }));
  } catch (err) {
    logError(`❌ Failed to send email to ${email}:`, err.message);


    if (sessionId) {
      const originalSessionId = job.data.originalSessionId || sessionId;
      batchLogger.addLog(sessionId, 'failed', email, err.message, originalSessionId);
    }

    await client.rpush(logKey, JSON.stringify({ email, status: 'failed', error: err.message, time: Date.now() }));
    throw err;
  }
});


emailQueue.on('completed', (job) => {
  log(`✅ Job ${job.id} completed successfully`);
});

emailQueue.on('failed', (job, err) => {
  logError(`❌ Job ${job.id} failed:`, err.message);
});

emailQueue.on('error', (err) => {
  logError('❌ Queue error:', err);
});


let shuttingDown = false;

/**
 * Drains cleanly so an in-flight send is not cut off mid-delivery.
 *
 * emailQueue.close() waits for active jobs to finish, which is why PM2 is
 * configured with a kill_timeout longer than a typical send.
 */
async function shutdown(signal) {
  if (shuttingDown) return; // PM2 may send more than one signal
  shuttingDown = true;

  logger.force(`📴 Received ${signal}, finishing active jobs and shutting down…`);

  try {
    // Stops accepting new jobs and waits for active ones to complete.
    await emailQueue.close();

    for (const [, transporter] of transporterCache.entries()) {
      try {
        transporter.close();
      } catch (err) {
        logError('Error closing transporter:', err.message);
      }
    }

    await mongoose.connection.close();
    client.disconnect();

    logger.force('✅ Worker shut down cleanly');
    process.exit(0);
  } catch (err) {
    logError('Error during shutdown:', err.message);
    process.exit(1);
  }
}

// PM2 sends SIGINT on reload/stop; SIGTERM arrives from most other supervisors.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));