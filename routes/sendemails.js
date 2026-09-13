const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const csvParse = require('csv-parse/sync');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const createRedisClient = require('../config/redis');
const redisClient = createRedisClient();
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const emailQueue = require('../workprocess/queue');
const EmailLog = require('../models/EmailLog');
const EmailLogEntry = require('../models/EmailLogEntry');
const UploadedFile = require('../models/UploadedFile');
const ImapTestResult = require('../models/ImapTestResult');
const { generateMessageId } = require('../utils/messageIdGenerator');
const logger = require('../utils/logger');

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.csv', '.txt', '.xlsx', '.xls', '.json']);

function safeFileName(originalName) {
  const base = path.basename(String(originalName || 'upload'));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || 'upload';
}

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: env.maxUploadBytes,
    files: 1,
    fields: 50,
    fieldNameSize: 200
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();

    if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
      const err = new Error(
        `Unsupported file type "${ext || 'unknown'}". Allowed: ${[...ALLOWED_UPLOAD_EXTENSIONS].join(', ')}`
      );
      err.code = 'UNSUPPORTED_FILE_TYPE'; // mapped to a 400 by the error handler
      return cb(err);
    }

    cb(null, true);
  }
});

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function storeRecipients(sessionId, recipients) {
  const key = `recipients:${sessionId}`;
  await redisClient.del(key);

  if (!recipients || recipients.length === 0) return;

  const chSize = 5000;
  for (let i = 0; i < recipients.length; i += chSize) {
    const chunk = recipients.slice(i, i + chSize);
    await redisClient.rpush(key, ...chunk);
  }
}

async function getRecipients(sessionId) {
  const key = `recipients:${sessionId}`;
  try {

    const list = await redisClient.lrange(key, 0, -1);
    if (list && list.length > 0) return list;

    const type = await redisClient.type(key);
    if (type === 'string') {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : [];
    }
    return [];
  } catch (err) {
    if (err.message.includes('WRONGTYPE')) {

      const data = await redisClient.get(key);
      try {
        return data ? JSON.parse(data) : [];
      } catch { return []; }
    }
    throw err;
  }
}

async function getSentIndex(sessionId) {
  const idx = await redisClient.get(`sentIndex:${sessionId}`);
  return idx ? parseInt(idx) : 0;
}

async function setSentIndex(sessionId, idx) {
  await redisClient.set(`sentIndex:${sessionId}`, idx.toString());
}

async function getLogStats(logKey) {
  const logs = await redisClient.lrange(logKey, 0, -1);
  let sent = 0, failed = 0, lastError = '';
  if (logs) {
    logs.forEach(entry => {
      try {
        const log = JSON.parse(entry);
        if (log.status === 'sent') sent++;
        if (log.status === 'failed') {
          failed++;
          lastError = log.error || '';
        }
      } catch { }
    });
  }
  return { sent, failed, lastError };
}

router.post('/recipients', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    let emails = [];
    const ext = path.extname(file.originalname).toLowerCase();
    const filePath = file.path;

    if (ext === '.csv' || ext === '.txt') {
      const content = fs.readFileSync(filePath, 'utf8');
      let records;
      if (ext === '.csv') {
        records = csvParse.parse(content, { columns: false, skip_empty_lines: true });
        emails = records.flat().map(e => e.trim());
      } else {
        emails = content.split(/\r?\n/).map(e => e.trim());
      }
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      emails = data.flat().map(e => (typeof e === 'string' ? e.trim() : ''));
    } else if (ext === '.json') {
      const content = fs.readFileSync(filePath, 'utf8');
      const json = JSON.parse(content);
      if (Array.isArray(json)) {
        if (typeof json[0] === 'string') {
          emails = json.map(e => e.trim());
        } else if (typeof json[0] === 'object' && json[0].email) {
          emails = json.map(obj => obj.email.trim());
        }
      }
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    let validRecipients = [];
    const invalidRecipients = [];
    const seen = new Set();

    for (let email of emails) {
      if (!email) continue;
      const trimmed = email.trim().toLowerCase();
      if (isValidEmail(trimmed)) {
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          validRecipients.push(trimmed);
        }
      } else {
        invalidRecipients.push(email);
      }
    }

    emails = [];

    const sessionId = req.headers['x-session-id'] || uuidv4();
    const timestamp = Date.now();
    // originalname is client-controlled — sanitise before using it in a path.
    const newFileName = `${sessionId}_${timestamp}_${safeFileName(file.originalname)}`;
    const newFilePath = path.join(uploadsDir, newFileName);

    fs.renameSync(filePath, newFilePath);

    const uploadedFile = new UploadedFile({
      originalName: file.originalname,
      storedPath: newFilePath,
      fileSize: file.size,
      fileType: ext,
      sessionId: sessionId,
      totalEmails: seen.size + invalidRecipients.length,
      validEmails: validRecipients.length,
      invalidEmails: invalidRecipients.length,
      pendingEmails: validRecipients.length,
      status: 'uploaded'
    });

    await uploadedFile.save();

    await storeRecipients(sessionId, validRecipients);

    res.json({
      total: validRecipients.length,
      validRecipients,
      sessionId,
      fileInfo: {
        originalName: file.originalname,
        totalEmails: emails.length,
        validEmails: validRecipients.length,
        invalidEmails: invalidRecipients.length
      }
    });
  } catch (err) {
    console.error('Error in /recipients:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/send-email', async (req, res) => {
  try {
    const {
      'smtp-host': smtpHost,
      'smtp-port': smtpPort,
      'smtp-user': smtpUser,
      'smtp-pass': smtpPass,
      'test-bulk': testBulk,
      'test-recp': testRecp,
      limit,
      'smtp-from-name': fromName,
      'smtp-from-email': fromEmail,
      subject,
      'custom-headers': customHeaders,
      'custom-message-id': customMessageId,
      'plain-html': plainHtml,
      message,
      'file-ids': fileIds,
      sessionId: initialSessionId
    } = req.body;

    let recipients = [];
    let batch = [];
    let batchCount = 0;
    let logKey = '';
    let selectedFileIds = [];
    let sessionId = initialSessionId;

    if (testBulk === 'Test') {
      recipients = testRecp.split(/[,;\n\r]+/).map(e => e.trim()).filter(isValidEmail);
      if (!recipients.length) return res.status(400).json({ error: 'No valid test recipients' });
      batch = recipients;
      batchCount = batch.length;

      if (!sessionId) {
        sessionId = `test-${Date.now()}`;
      }
      logKey = `emaillog:${sessionId}`;
    } else {

      if (!fileIds || !fileIds.trim()) {
        return res.status(400).json({ error: 'File IDs are mandatory for bulk campaigns. Please specify which files to use.' });
      }

      selectedFileIds = fileIds.split(',').map(id => id.trim()).filter(id => id);

      if (selectedFileIds.length === 0) {
        return res.status(400).json({ error: 'Please provide at least one valid File ID for bulk campaigns.' });
      }

      for (const fileId of selectedFileIds) {
        const file = await UploadedFile.findOne({ sessionId: fileId });
        if (!file) {
          return res.status(400).json({ error: `File ID "${fileId}" not found. Please check your file IDs.` });
        }
      }

      let recipientDetails = [];
      for (const fileId of selectedFileIds) {
        const fileRecipients = await getRecipients(fileId);
        for (const email of fileRecipients) {
          recipientDetails.push({ email, sourceFile: fileId });
        }
      }

      if (!recipientDetails.length) return res.status(400).json({ error: 'No valid recipients found in specified files' });

      const seen = new Set();
      let uniqueRecipients = [];
      for (const item of recipientDetails) {
        if (!seen.has(item.email)) {
          seen.add(item.email);
          uniqueRecipients.push(item);
        }
      }

      recipients = uniqueRecipients.map(i => i.email);

      req.recipientSourceMap = uniqueRecipients;

      sessionId = selectedFileIds[0];
    }

    if (!recipients.length) return res.status(400).json({ error: 'No valid recipients' });
    const batchLimit = testBulk === 'Test' ? recipients.length : (parseInt(limit) || recipients.length);
    const sentIndex = await getSentIndex(sessionId);
    batch = recipients.slice(sentIndex, sentIndex + batchLimit);
    if (!batch.length) return res.status(400).json({ error: 'No more recipients to send' });
    batchCount = batch.length;
    logKey = `emaillog:${sessionId}`;

    const smtp = {
      host: smtpHost,
      port: parseInt(smtpPort),
      secure: parseInt(smtpPort) === 465,
      auth: { user: smtpUser, pass: smtpPass }
    };
    const from = `${fromName} <${fromEmail}>`;
    const isHtml = plainHtml === 'HTML';

    let headers = {};
    if (customHeaders && customHeaders.trim()) {
      logger.debug('Raw custom headers received:', customHeaders);
      const headerLines = customHeaders.split('\n');
      for (const line of headerLines) {
        const trimmedLine = line.trim();
        if (trimmedLine && trimmedLine.includes(':')) {
          const [key, ...valueParts] = trimmedLine.split(':');
          const value = valueParts.join(':').trim();
          if (key && value) {
            headers[key.trim()] = value;
          }
        }
      }
      logger.debug('Parsed custom headers:', JSON.stringify(headers, null, 2));
    }

    let processedMessageId = null;
    if (customMessageId && customMessageId.trim()) {

      const senderDomain = fromEmail.split('@')[1] || 'example.com';

      processedMessageId = customMessageId.trim();

      logger.debug('Custom Message-ID template:', processedMessageId);
      logger.debug('Sender domain for {{Domain}} replacement:', senderDomain);
    }

    let emailLog;
    if (testBulk === 'Test') {
      emailLog = new EmailLog({
        sessionId: sessionId,
        fromEmail,
        fromName,
        subject,
        messageType: plainHtml,
        totalRecipients: recipients.length,
        pendingCount: recipients.length,
        batchLimit: batch.length,
        smtpHost,
        customHeaders: headers,
        status: 'in_progress'
      });
    } else {

      emailLog = await EmailLog.findOne({ sessionId });
      if (!emailLog) {
        emailLog = new EmailLog({
          sessionId,
          fromEmail,
          fromName,
          subject,
          messageType: plainHtml,
          totalRecipients: recipients.length,
          pendingCount: recipients.length,
          batchLimit: parseInt(limit) || recipients.length,
          smtpHost,
          customHeaders: headers,
          status: 'in_progress'
        });
      }

      for (const fileId of selectedFileIds) {
        await UploadedFile.findOneAndUpdate(
          { sessionId: fileId },
          {
            status: 'processing',
            campaignName: `${fromName} - ${subject}`,
            fromEmail,
            subject
          }
        );
      }
    }
    await emailLog.save();

    let finalMessage = message;
    if (isHtml && finalMessage && finalMessage.startsWith('%3C') && !finalMessage.includes('<html')) {
      try {
        finalMessage = decodeURIComponent(finalMessage.replace(/\+/g, '%20'));
        console.log('Successfully auto-decoded URL-encoded HTML payload.');
      } catch (err) {
        console.log('Failed to auto-decode message:', err);
      }
    }

    if (isHtml && finalMessage) {
      const sampleDir = path.join(uploadsDir, 'sample');

      try {
        if (!fs.existsSync(sampleDir)) {
          fs.mkdirSync(sampleDir, { recursive: true });
        }

        // The SMTP password is deliberately NOT recorded here. These sample
        // files persist on disk purely as a rendering preview, and writing the
        // credential into them exposed it to anything that could read the
        // uploads directory — backups, log shippers, host access.
        const metadata = [
          `SMTP Host: ${smtpHost || 'N/A'}`,
          `SMTP Port: ${smtpPort || 'N/A'}`,
          `SMTP User: ${smtpUser || 'N/A'}`,
          `From Name: ${fromName || 'N/A'}`,
          `From Email: ${fromEmail || 'N/A'}`,
          `Subject: ${subject || 'N/A'}`,
          `Custom Headers:\n${customHeaders ? customHeaders.trim() : 'None'}`
        ].join('\n');

        const fileContent = `<!-- MetaData:\n${metadata}\n-->\n${finalMessage}`;

        const contentHash = crypto.createHash('md5').update(fileContent).digest('hex');
        const samplePath = path.join(sampleDir, `sample_${contentHash}.html`);

        if (!fs.existsSync(samplePath)) {
          fs.writeFileSync(samplePath, fileContent, 'utf8');
        }

        const files = fs.readdirSync(sampleDir);
        const htmlFiles = files
          .filter(file => file.endsWith('.html'))
          .map(file => {
            const filePath = path.join(sampleDir, file);
            const stats = fs.statSync(filePath);
            return { name: file, time: stats.mtime.getTime() };
          })
          .sort((a, b) => b.time - a.time);

        if (htmlFiles.length > 10) {
          const filesToDelete = htmlFiles.slice(10);
          filesToDelete.forEach(f => {
            const filePath = path.join(sampleDir, f.name);
            try {
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
              }
            } catch (err) {

              if (err.code !== 'ENOENT') {
                console.error(`Error deleting old sample ${f.name}:`, err);
              }
            }
          });
        }
      } catch (saveErr) {
        console.error('Error saving HTML sample:', saveErr);
      }
    }

    const isAutoImapTest = req.body['auto-imap-test'] === 'on' || req.body['auto-imap-test'] === 'true';
    let testRecords = [];

    if (testBulk === 'Test' && isAutoImapTest) {
      const userId = req.user?.email || 'unknown';
      testRecords = batch.map((email, index) => {
        const placeholderMessageId = `pending-${sessionId}-${email}-${index}`;
        return {
          testId: `${sessionId}-${email}-${index}-${Date.now()}`,
          testType: 'auto',
          testEmail: email,
          userId,
          ipAddress: smtpHost || 'unknown',
          status: 'pending',
          subject,
          fromEmail,
          messageId: placeholderMessageId,
          sentAt: new Date()
        };
      });
    }

    res.json({
      status: 'enqueued',
      batchCount,
      testIds: testRecords.map(r => r.testId)
    });

    setImmediate(async () => {
      try {
        const senderDomain = fromEmail.split('@')[1] || 'example.com';
        const jobs = batch.map(email => {
          const sourceMap = req.recipientSourceMap ? req.recipientSourceMap.find(r => r.email === email) : null;
          const originalSessionId = sourceMap ? sourceMap.sourceFile : emailLog.sessionId;

          return {
            data: {
              smtp,
              email,
              from,
              subject,
              message: finalMessage,
              isHtml,
              headers,
              messageIdTemplate: processedMessageId,
              senderDomain,
              templateData: {
                fromName,
                toEmail: email,
                subjectLine: subject,
                fromEmail
              },
              logKey,
              sessionId: emailLog.sessionId,
              originalSessionId
            },
            opts: {
              removeOnComplete: true,
              removeOnFail: false,
              attempts: 1
            }
          };
        });

        await emailQueue.addBulk(jobs);

        if (testBulk !== 'Test') {
          await setSentIndex(sessionId, (await getSentIndex(sessionId)) + batch.length);
        }

        if (testBulk === 'Test' && isAutoImapTest && testRecords.length > 0) {
          try {
            const userId = req.user?.email || 'unknown';

            const deleteResult = await ImapTestResult.deleteMany({
              userId,
              status: { $in: ['inbox', 'spam'] }
            });

            if (deleteResult.deletedCount > 0) {
              logger.info(`🗑️ Deleted ${deleteResult.deletedCount} old completed test results for user ${userId} before sending new tests`);
            }

            await ImapTestResult.insertMany(testRecords);
          } catch (saveErr) {
            console.error('Error saving test email records:', saveErr);
          }
        }
      } catch (bgErr) {
        console.error('Background email enqueue error (session: ' + sessionId + '):', bgErr.message);
      }
    });

  } catch (err) {
    console.error('Error in /send-email:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'No sessionId provided' });

    let total = 0;
    let sent = 0;
    let failed = 0;
    let lastError = '';
    let emailLog = null;

    if (sessionId.startsWith('test-')) {

      emailLog = await EmailLog.findOne({ sessionId }, '-entries').sort({ createdAt: -1 });
      if (emailLog) {
        total = emailLog.totalRecipients || 0;
        sent = emailLog.sentCount || 0;
        failed = emailLog.failedCount || 0;
        lastError = emailLog.lastError || '';
      }
    } else {

      const recipients = await getRecipients(sessionId);
      total = recipients.length;

      emailLog = await EmailLog.findOne({ sessionId }, '-entries').sort({ createdAt: -1 });
      if (emailLog) {
        sent = emailLog.sentCount || 0;
        failed = emailLog.failedCount || 0;
        lastError = emailLog.lastError || '';
      }
    }

    const sentIndex = await getSentIndex(sessionId);

    const sending = Math.max(0, sentIndex - sent - failed);

    lastError = emailLog ? (emailLog.lastError || '') : '';

    res.json({ total, sent, failed, sending, sentIndex, lastError });
  } catch (err) {
    console.error('Error in /status:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/log-download', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'No sessionId provided' });

    const logKey = `emaillog:${sessionId}`;
    const logs = await redisClient.lrange(logKey, 0, -1);

    const entries = await EmailLogEntry.find({ sessionId }).lean();

    if (!entries || !entries.length) return res.status(404).json({ error: 'No logs found' });

    const rows = ['email,status,error,time'];
    entries.forEach(entry => {
      rows.push([
        entry.email,
        entry.status,
        entry.error ? '"' + entry.error.replace(/"/g, '""') + '"' : '',
        entry.time.toISOString()
      ].join(','));
    });

    const csv = rows.join('\n');

    res.setHeader('Content-disposition', `attachment; filename=emaillog-${sessionId}.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csv);
  } catch (err) {
    console.error('Error in log download:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sortBy = req.query.sortBy || 'createdAt';
    const sortOrder = req.query.sortOrder || 'desc';

    const logs = await EmailLog.findLogsWithPagination(page, limit, sortBy, sortOrder);
    const totalLogs = await EmailLog.estimatedDocumentCount();
    const totalPages = Math.ceil(totalLogs / limit);

    res.json({
      logs,
      pagination: {
        page,
        limit,
        totalLogs,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (err) {
    console.error('Error fetching logs:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const log = await EmailLog.findOne({ sessionId });

    if (!log) {
      return res.status(404).json({ error: 'Log not found' });
    }

    res.json(log);
  } catch (err) {
    console.error('Error fetching log:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs-stats', async (req, res) => {
  try {
    const stats = await EmailLog.getStatistics();
    res.json(stats[0] || {
      totalCampaigns: 0,
      totalEmails: 0,
      totalSent: 0,
      totalFailed: 0,
      completedCampaigns: 0,
      inProgressCampaigns: 0
    });
  } catch (err) {
    console.error('Error fetching log statistics:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/logs/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await EmailLog.deleteOne({ sessionId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Log not found' });
    }

    await EmailLogEntry.deleteMany({ campaignId: sessionId });

    res.json({ message: 'Log and related entries deleted successfully' });
  } catch (err) {
    console.error('Error deleting log:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/logs', async (req, res) => {
  try {
    await EmailLog.deleteMany({});
    await EmailLogEntry.deleteMany({});

    res.json({
      message: `All ${result.deletedCount} logs and their entries deleted successfully`
    });
  } catch (err) {
    console.error('Error deleting all logs:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs/:sessionId/download', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const log = await EmailLog.findOne({ sessionId });

    if (!log) {
      return res.status(404).json({ error: 'Log not found' });
    }

    const entries = await EmailLogEntry.find({ sessionId }).lean();

    const rows = ['email,status,error,time'];
    entries.forEach(entry => {
      rows.push([
        entry.email,
        entry.status,
        entry.error ? '"' + entry.error.replace(/"/g, '""') + '"' : '',
        entry.time.toISOString()
      ].join(','));
    });

    const csv = rows.join('\n');

    res.setHeader('Content-disposition', `attachment; filename=emaillog-${sessionId}.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csv);
  } catch (err) {
    console.error('Error downloading log:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sortBy = req.query.sortBy || 'uploadDate';
    const sortOrder = req.query.sortOrder || 'desc';

    const files = await UploadedFile.findFilesWithPagination(page, limit, sortBy, sortOrder);
    const totalFiles = await UploadedFile.countDocuments();
    const totalPages = Math.ceil(totalFiles / limit);

    res.json({
      files,
      pagination: {
        page,
        limit,
        totalFiles,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (err) {
    console.error('Error fetching files:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files-stats', async (req, res) => {
  try {
    const stats = await UploadedFile.getFileStatistics();
    res.json(stats[0] || {
      totalFiles: 0,
      totalEmails: 0,
      totalValidEmails: 0,
      totalSentEmails: 0,
      totalFailedEmails: 0,
      totalPendingEmails: 0,
      completedFiles: 0,
      processingFiles: 0
    });
  } catch (err) {
    console.error('Error fetching file statistics:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files/:sessionId/original', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const file = await UploadedFile.findOne({ sessionId });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!fs.existsSync(file.storedPath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.download(file.storedPath, file.originalName);
  } catch (err) {
    console.error('Error downloading original file:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files/:sessionId/sent', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const log = await EmailLog.findOne({ sessionId });

    const entries = await EmailLogEntry.find({ sessionId, status: 'sent' }).lean();
    const sentEmails = entries.map(entry => entry.email);

    const csv = ['email\n' + sentEmails.join('\n')];

    res.setHeader('Content-disposition', `attachment; filename=sent-emails-${sessionId}.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csv.join('\n'));
  } catch (err) {
    console.error('Error downloading sent emails:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files/:sessionId/failed', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const log = await EmailLog.findOne({ sessionId });

    const entries = await EmailLogEntry.find({ sessionId, status: 'failed' }).lean();
    const failedEmails = entries.map(entry => `${entry.email},${entry.error || ''}`);

    const csv = ['email,error\n' + failedEmails.join('\n')];

    res.setHeader('Content-disposition', `attachment; filename=failed-emails-${sessionId}.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csv.join('\n'));
  } catch (err) {
    console.error('Error downloading failed emails:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files/:sessionId/pending', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const file = await UploadedFile.findOne({ sessionId });
    const log = await EmailLog.findOne({ sessionId });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    const originalEmails = await getRecipients(sessionId);

    let processedEmails = [];
    const entries = await EmailLogEntry.find({ sessionId }).select('email').lean();
    processedEmails = entries.map(entry => entry.email);

    const processedSet = new Set(processedEmails);

    const pendingEmails = originalEmails.filter(email => !processedSet.has(email));

    const csv = ['email\n' + pendingEmails.join('\n')];

    res.setHeader('Content-disposition', `attachment; filename=pending-emails-${sessionId}.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csv.join('\n'));
  } catch (err) {
    console.error('Error downloading pending emails:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/files/delete-all', async (req, res) => {
  console.log('🗑️ DELETE ALL FILES ROUTE HIT');
  try {

    const files = await UploadedFile.find({});
    console.log(`📊 Found ${files.length} files to delete`);

    if (files.length === 0) {
      console.log('⚠️ No files to delete');
      return res.json({ message: 'No files to delete', deletedCount: 0 });
    }

    let deletedCount = 0;
    let failedCount = 0;

    for (const file of files) {
      try {
        console.log(`🗑️ Deleting file: ${file.sessionId} - ${file.originalName}`);

        if (fs.existsSync(file.storedPath)) {
          fs.unlinkSync(file.storedPath);
          console.log(`✅ Deleted from disk: ${file.storedPath}`);
        } else {
          console.log(`⚠️ File not found on disk: ${file.storedPath}`);
        }

        await UploadedFile.deleteOne({ sessionId: file.sessionId });
        console.log(`✅ Deleted from database: ${file.sessionId}`);
        deletedCount++;
      } catch (err) {
        console.error(`❌ Error deleting file ${file.sessionId}:`, err);
        failedCount++;
      }
    }
    console.log(`✅ Delete all complete: ${deletedCount} deleted, ${failedCount} failed`);
    res.json({
      message: `Successfully deleted ${deletedCount} files. Campaign logs are preserved for history.`,
      deletedCount,
      failedCount
    });
  } catch (err) {
    console.error('❌ Error deleting all files:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/files/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const file = await UploadedFile.findOne({ sessionId });

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (fs.existsSync(file.storedPath)) {
      fs.unlinkSync(file.storedPath);
    }

    await UploadedFile.deleteOne({ sessionId });

    res.json({ message: 'File deleted successfully. Campaign logs are preserved for history.' });
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
