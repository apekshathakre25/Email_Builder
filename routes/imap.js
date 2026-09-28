const express = require('express');
const router = express.Router();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const ImapTestResult = require('../models/ImapTestResult');
const { TestEmailAccount, ImapCredentials } = require('../models/TestEmailAccount');
const { encrypt, tryDecrypt } = require('../utils/credentialCipher');

router.post('/check-inbox', async (req, res) => {
    const { host, port, ssl, email, password } = req.body;

    if (!host || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields: host, email, password' });
    }

    let client;

    try {

        client = new ImapFlow({
            host: host,
            port: port || 993,
            secure: ssl !== false,
            auth: {
                user: email,
                pass: password
            },
            logger: false
        });

        await client.connect();

        let lock = await client.getMailboxLock('INBOX');

        try {

            const messages = [];

            const mailbox = client.mailbox;
            if (mailbox.exists === 0) {
                return res.json({ emails: [] });
            }

            const count = Math.min(20, mailbox.exists);
            const start = Math.max(1, mailbox.exists - count + 1);

            for await (let message of client.fetch(`${start}:*`, {
                envelope: true,
                bodyStructure: true,
                source: true
            })) {
                try {
                    const parsed = await simpleParser(message.source);

                    messages.push({
                        uid: message.uid,
                        subject: parsed.subject || '(No Subject)',
                        from: parsed.from?.text || 'Unknown',
                        date: parsed.date || new Date(),
                        preview: parsed.text ? parsed.text.substring(0, 100) + '...' : '',
                        hasAttachments: parsed.attachments?.length > 0
                    });
                } catch (parseError) {
                    console.error('Error parsing message:', parseError);
                }
            }

            messages.sort((a, b) => new Date(b.date) - new Date(a.date));

            res.json({ emails: messages });
        } finally {
            lock.release();
        }
    } catch (error) {
        console.error('IMAP Inbox Error:', error);

        let errorMessage = 'Failed to check inbox';

        if (error.message.includes('authentication')) {
            errorMessage = 'Authentication failed. Please check your email and app password.';
        } else if (error.message.includes('connect')) {
            errorMessage = 'Connection failed. Please check IMAP host and port.';
        } else if (error.message.includes('timeout')) {
            errorMessage = 'Connection timeout. Please check your network connection.';
        }

        res.status(500).json({ error: errorMessage, details: error.message });
    } finally {
        if (client) {
            try {
                await client.logout();
            } catch (logoutError) {
                console.error('Error during logout:', logoutError);
            }
        }
    }
});

router.post('/check-spam', async (req, res) => {
    const { host, port, ssl, email, password } = req.body;

    if (!host || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields: host, email, password' });
    }

    let client;

    try {
        client = new ImapFlow({
            host: host,
            port: port || 993,
            secure: ssl !== false,
            auth: {
                user: email,
                pass: password
            },
            logger: false
        });

        await client.connect();

        const spamFolderNames = [
            '[Gmail]/Spam',
            'Spam',
            'Junk',
            'Junk Email',
            'Bulk Mail',
            'INBOX.Spam',
            'INBOX.Junk',
            'Bulk',
            '[Yahoo]/Bulk',
            '[Yahoo]/Spam',
            'Junk E-mail',
            'Deleted Messages',
            'INBOX/Spam',
            'INBOX/Junk'
        ];

        let spamFolder = null;
        let lock = null;
        let availableFolders = [];
        try {
            const mailboxes = await client.list();
            availableFolders = mailboxes.map(mb => mb.path);
            console.log('Available mailboxes:', availableFolders);
        } catch (listError) {
            console.error('Error listing mailboxes:', listError);
        }

        for (const folderName of spamFolderNames) {
            try {
                lock = await client.getMailboxLock(folderName);
                spamFolder = folderName;
                break;
            } catch (error) {
                continue;
            }
        }

        if (!lock) {
            return res.status(404).json({
                error: 'Spam folder not found. Tried: ' + spamFolderNames.join(', '),
                availableFolders: availableFolders,
                suggestion: 'Please check available folders and update the spam folder name',
                emails: []
            });
        }

        try {
            const messages = [];
            const mailbox = client.mailbox;
            if (mailbox.exists === 0) {
                return res.json({ emails: [] });
            }
            const count = Math.min(20, mailbox.exists);
            const start = Math.max(1, mailbox.exists - count + 1);

            for await (let message of client.fetch(`${start}:*`, {
                envelope: true,
                bodyStructure: true,
                source: true
            })) {
                try {
                    const parsed = await simpleParser(message.source);
                    messages.push({
                        uid: message.uid,
                        subject: parsed.subject || '(No Subject)',
                        from: parsed.from?.text || 'Unknown',
                        date: parsed.date || new Date(),
                        preview: parsed.text ? parsed.text.substring(0, 100) + '...' : '',
                        hasAttachments: parsed.attachments?.length > 0,
                        folder: spamFolder
                    });
                } catch (parseError) {
                    console.error('Error parsing message:', parseError);
                }
            }
            messages.sort((a, b) => new Date(b.date) - new Date(a.date));

            res.json({ emails: messages, folder: spamFolder });
        } finally {
            lock.release();
        }
    } catch (error) {
        console.error('IMAP Spam Error:', error);

        let errorMessage = 'Failed to check spam folder';

        if (error.message.includes('authentication')) {
            errorMessage = 'Authentication failed. Please check your email and app password.';
        } else if (error.message.includes('connect')) {
            errorMessage = 'Connection failed. Please check IMAP host and port.';
        } else if (error.message.includes('timeout')) {
            errorMessage = 'Connection timeout. Please check your network connection.';
        }

        res.status(500).json({ error: errorMessage, details: error.message });
    } finally {
        if (client) {
            try {
                await client.logout();
            } catch (logoutError) {
                console.error('Error during logout:', logoutError);
            }
        }
    }
});

router.post('/list-mailboxes', async (req, res) => {
    const { host, port, ssl, email, password } = req.body;

    if (!host || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields: host, email, password' });
    }

    let client;

    try {
        client = new ImapFlow({
            host: host,
            port: port || 993,
            secure: ssl !== false,
            auth: {
                user: email,
                pass: password
            },
            logger: false
        });
        await client.connect();
        const mailboxes = await client.list();
        const mailboxList = mailboxes.map(mb => ({
            path: mb.path,
            name: mb.name,
            specialUse: mb.specialUse,
            subscribed: mb.subscribed
        }));

        res.json({ mailboxes: mailboxList });
    } catch (error) {
        console.error('IMAP List Mailboxes Error:', error);
        res.status(500).json({ error: 'Failed to list mailboxes', details: error.message });
    } finally {
        if (client) {
            try {
                await client.logout();
            } catch (logoutError) {
                console.error('Error during logout:', logoutError);
            }
        }
    }
});

router.get('/email-accounts', async (req, res) => {
    try {
        if (!req.user?.email) return res.status(401).json({ error: 'Authentication required' });

        const accounts = await TestEmailAccount.find({}).sort({ addedAt: 1 });
        const safe = accounts.map(a => ({
            _id: a._id,
            email: a.email,
            addedAt: a.addedAt
        }));
        res.json({ success: true, accounts: safe });
    } catch (err) {
        console.error('Error fetching email accounts:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/email-accounts', async (req, res) => {
    try {
        if (!req.user?.email) return res.status(401).json({ error: 'Authentication required' });

        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Invalid email address' });
        }

        const account = await TestEmailAccount.findOneAndUpdate(
            { email: email.toLowerCase().trim() },
            {
                email: email.toLowerCase().trim(),
                password: encrypt(password),
                addedAt: new Date()
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        res.json({ success: true, account: { _id: account._id, email: account.email, addedAt: account.addedAt } });
    } catch (err) {
        console.error('Error adding email account:', err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/email-accounts/:id', async (req, res) => {
    try {
        if (!req.user?.email) return res.status(401).json({ error: 'Authentication required' });

        const result = await TestEmailAccount.deleteOne({ _id: req.params.id });
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting email account:', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/account-password/:id', async (req, res) => {
    try {
        if (!req.user?.email) return res.status(401).json({ error: 'Authentication required' });

        const account = await TestEmailAccount.findOne({ _id: req.params.id }).select('+password');
        if (!account) return res.status(404).json({ error: 'Account not found' });

        const decrypted = tryDecrypt(account.password);
        if (!decrypted.ok) {
            console.error(`Could not decrypt stored password for account ${req.params.id}: ${decrypted.error}`);
            return res.status(500).json({
                error: 'Stored credential could not be decrypted. It may have been saved under a different CREDENTIAL_ENCRYPTION_KEY; please re-add the account.'
            });
        }

        res.json({ success: true, password: decrypted.value });
    } catch (err) {
        console.error('Error fetching account password:', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/credentials', async (req, res) => {
    try {
        const userId = req.user?.email;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const creds = await ImapCredentials.findOne({ userId });
        if (!creds) return res.json({ success: true, credentials: null });

        res.json({ success: true, credentials: { host: creds.host, port: creds.port, ssl: creds.ssl } });
    } catch (err) {
        console.error('Error fetching IMAP credentials:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/credentials', async (req, res) => {
    try {
        const userId = req.user?.email;
        if (!userId) return res.status(401).json({ error: 'Authentication required' });

        const { host, port, ssl } = req.body;
        if (!host) return res.status(400).json({ error: 'IMAP host is required' });

        await ImapCredentials.findOneAndUpdate(
            { userId },
            { userId, host: host.trim(), port: parseInt(port) || 993, ssl: ssl !== false && ssl !== 'false', updatedAt: new Date() },
            { upsert: true, new: true }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Error saving IMAP credentials:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/save-test-result', async (req, res) => {
    try {
        const { testId, testType, testEmail, ipAddress, subject, fromEmail } = req.body;
        const userId = req.user?.email || 'unknown';

        if (!testId || !testType || !testEmail || !ipAddress) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const testResult = new ImapTestResult({
            testId,
            testType,
            testEmail,
            userId,
            ipAddress,
            subject,
            fromEmail,
            status: 'pending'
        });

        await testResult.save();
        res.json({ success: true, testResult });
    } catch (error) {
        console.error('Error saving test result:', error);
        res.status(500).json({ error: 'Failed to save test result', details: error.message });
    }
});

router.post('/save-manual-test-results', async (req, res) => {
    try {
        const { recipients, ipAddress, subject, fromEmail } = req.body;
        const userId = req.user?.email || 'unknown';

        if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({ error: 'Recipients array is required' });
        }

        if (!ipAddress) {
            return res.status(400).json({ error: 'IP address is required' });
        }

        const savedResults = [];

        for (const recipient of recipients) {
            const testId = `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            const testResult = new ImapTestResult({
                testId,
                testType: 'manual',
                testEmail: recipient,
                userId,
                ipAddress,
                subject: subject || '(No Subject)',
                fromEmail: fromEmail || '',
                status: 'pending'
            });

            await testResult.save();
            savedResults.push(testResult);
        }

        res.json({ success: true, count: savedResults.length, results: savedResults });
    } catch (error) {
        console.error('Error saving manual test results:', error);
        res.status(500).json({ error: 'Failed to save manual test results', details: error.message });
    }
});

router.post('/check-auto-test', async (req, res) => {
    const { host, port, ssl, email, password, testIds } = req.body;

    if (!host || !email || !password || !testIds || !Array.isArray(testIds)) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    let client;

    try {

        const testResults = await ImapTestResult.find({ testId: { $in: testIds } });

        if (testResults.length === 0) {
            return res.json({ success: true, results: [], checkedCount: 0 });
        }

        client = new ImapFlow({
            host: host,
            port: port || 993,
            secure: ssl !== false,
            auth: {
                user: email,
                pass: password
            },
            logger: false
        });

        await client.connect();

        const results = [];
        const foundTestIds = new Set();

        let inboxLock = await client.getMailboxLock('INBOX');
        try {
            const mailbox = client.mailbox;
            if (mailbox.exists > 0) {
                const count = Math.min(50, mailbox.exists);
                const start = Math.max(1, mailbox.exists - count + 1);

                for await (let message of client.fetch(`${start}:*`, {
                    envelope: true,
                    source: true
                })) {
                    try {
                        const parsed = await simpleParser(message.source);

                        let extractedMessageId = parsed.messageId;
                        if (!extractedMessageId && parsed.headers) {
                            extractedMessageId = parsed.headers.get('message-id');
                        }

                        for (const testResult of testResults) {
                            if (foundTestIds.has(testResult.testId)) continue;

                            let isMatch = false;
                            let matchMethod = '';

                            if (extractedMessageId && testResult.messageId) {
                                isMatch = extractedMessageId.toLowerCase() === testResult.messageId.toLowerCase();
                                if (isMatch) {
                                    matchMethod = 'Message-ID';
                                    console.log(`✅ INBOX: Matched by Message-ID: ${extractedMessageId} for ${testResult.testEmail}`);
                                }
                            }

                            if (!isMatch) {
                                const isRecipient = parsed.to?.value?.some(addr =>
                                    addr.address?.toLowerCase() === testResult.testEmail.toLowerCase()
                                );
                                const subjectMatches = !testResult.subject ||
                                    testResult.subject === '(No Subject)' ||
                                    parsed.subject?.includes(testResult.subject) ||
                                    testResult.subject?.includes(parsed.subject);
                                const emailDate = parsed.date || new Date();
                                const testDate = new Date(testResult.sentAt);
                                const timeDiff = Math.abs(emailDate - testDate) / 1000 / 60;
                                const isRecent = timeDiff < 10;
                                isMatch = isRecipient && subjectMatches && isRecent;
                                if (isMatch) {
                                    matchMethod = 'Fallback (recipient+subject+time)';
                                    console.log(`⚠️ INBOX: Matched by fallback for ${testResult.testEmail} - MessageID in DB: ${testResult.messageId}, MessageID in email: ${extractedMessageId}`);
                                }
                            }

                            if (isMatch) {
                                foundTestIds.add(testResult.testId);
                                console.log(`📧 INBOX: Found test email for ${testResult.testEmail} using ${matchMethod}`);
                                // Only fullRaw is captured now. rawHeaders and rawBody were
                                // also being stored, but nothing ever read them: the details
                                // modal renders emailDetails.preview and emailDetails.fullRaw
                                // only. fullRaw already contains the headers and the body
                                // verbatim, so those two fields were a second and third copy
                                // of the same message on every test document.
                                const fullRaw = message.source ? message.source.toString() : '';

                                results.push({
                                    testId: testResult.testId,
                                    status: 'inbox',
                                    folder: 'INBOX',
                                    subject: parsed.subject,
                                    from: parsed.from?.text,
                                    date: parsed.date,
                                    uid: message.uid,
                                    messageId: extractedMessageId,
                                    preview: parsed.text ? parsed.text.substring(0, 100) : '',
                                    fullRaw: fullRaw
                                });
                            }
                        }
                    } catch (parseError) {
                        console.error('Error parsing message:', parseError);
                    }
                }
            }
        } finally {
            inboxLock.release();
        }

        const spamFolderNames = [
            '[Gmail]/Spam', 'Spam', 'Junk', 'Junk Email', 'Bulk Mail',
            'INBOX.Spam', 'INBOX.Junk', 'Bulk', '[Yahoo]/Bulk', '[Yahoo]/Spam',
            'Junk E-mail', 'INBOX/Spam', 'INBOX/Junk'
        ];

        let spamFolder = null;
        for (const folderName of spamFolderNames) {
            try {
                let spamLock = await client.getMailboxLock(folderName);
                spamFolder = folderName;

                try {
                    const mailbox = client.mailbox;
                    if (mailbox.exists > 0) {
                        const count = Math.min(50, mailbox.exists);
                        const start = Math.max(1, mailbox.exists - count + 1);

                        for await (let message of client.fetch(`${start}:*`, {
                            envelope: true,
                            source: true
                        })) {
                            try {
                                const parsed = await simpleParser(message.source);

                                let extractedMessageId = parsed.messageId;
                                if (!extractedMessageId && parsed.headers) {
                                    extractedMessageId = parsed.headers.get('message-id');
                                }

                                for (const testResult of testResults) {
                                    if (foundTestIds.has(testResult.testId)) continue;

                                    let isMatch = false;
                                    let matchMethod = '';

                                    if (extractedMessageId && testResult.messageId) {
                                        isMatch = extractedMessageId.toLowerCase() === testResult.messageId.toLowerCase();
                                        if (isMatch) {
                                            matchMethod = 'Message-ID';
                                            console.log(`✅ SPAM: Matched by Message-ID: ${extractedMessageId} for ${testResult.testEmail}`);
                                        }
                                    }

                                    if (!isMatch) {
                                        const isRecipient = parsed.to?.value?.some(addr =>
                                            addr.address?.toLowerCase() === testResult.testEmail.toLowerCase()
                                        );
                                        const subjectMatches = !testResult.subject ||
                                            testResult.subject === '(No Subject)' ||
                                            parsed.subject?.includes(testResult.subject) ||
                                            testResult.subject?.includes(parsed.subject);
                                        const emailDate = parsed.date || new Date();
                                        const testDate = new Date(testResult.sentAt);
                                        const timeDiff = Math.abs(emailDate - testDate) / 1000 / 60;
                                        const isRecent = timeDiff < 10;
                                        isMatch = isRecipient && subjectMatches && isRecent;
                                        if (isMatch) {
                                            matchMethod = 'Fallback (recipient+subject+time)';
                                            console.log(`⚠️ SPAM: Matched by fallback for ${testResult.testEmail} - MessageID in DB: ${testResult.messageId}, MessageID in email: ${extractedMessageId}`);
                                        }
                                    }

                                    if (isMatch) {
                                        foundTestIds.add(testResult.testId);
                                        console.log(`📧 SPAM: Found test email for ${testResult.testEmail} using ${matchMethod}`);
                                        // See the INBOX branch: fullRaw supersedes rawHeaders
                                        // and rawBody, which nothing reads.
                                        const fullRaw = message.source ? message.source.toString() : '';

                                        results.push({
                                            testId: testResult.testId,
                                            status: 'spam',
                                            folder: spamFolder,
                                            subject: parsed.subject,
                                            from: parsed.from?.text,
                                            date: parsed.date,
                                            uid: message.uid,
                                            messageId: extractedMessageId,
                                            preview: parsed.text ? parsed.text.substring(0, 100) : '',
                                            fullRaw: fullRaw
                                        });
                                    }
                                }
                            } catch (parseError) {
                                console.error('Error parsing message:', parseError);
                            }
                        }
                    }
                } finally {
                    spamLock.release();
                }
                break;
            } catch (error) {
                continue;
            }
        }
        for (const result of results) {
            await ImapTestResult.findOneAndUpdate(
                { testId: result.testId },
                {
                    status: result.status,
                    messageId: result.messageId,
                    checkedAt: new Date(),
                    emailDetails: {
                        messageId: result.messageId,
                        uid: result.uid,
                        preview: result.preview,
                        fullRaw: result.fullRaw
                    }
                }
            );
        }

        res.json({ success: true, results, checkedCount: results.length });
    } catch (error) {
        console.error('IMAP Auto Test Error:', error);
        res.status(500).json({ error: 'Failed to check auto test', details: error.message });
    } finally {
        if (client) {
            try {
                await client.logout();
            } catch (logoutError) {
                console.error('Error during logout:', logoutError);
            }
        }
    }
});

router.get('/test-results', async (req, res) => {
    try {
        const { testType, limit = 50 } = req.query;
        const userId = req.user?.email;

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        const query = { userId };
        if (testType) {
            query.testType = testType;
        }

        const results = await ImapTestResult.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit));

        res.json({ success: true, results });
    } catch (error) {
        console.error('Error fetching test results:', error);
        res.status(500).json({ error: 'Failed to fetch test results', details: error.message });
    }
});

router.delete('/test-results/:testId', async (req, res) => {
    try {
        const { testId } = req.params;
        const userId = req.user?.email;

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        const result = await ImapTestResult.deleteOne({ testId, userId });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Test result not found or unauthorized' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting test result:', error);
        res.status(500).json({ error: 'Failed to delete test result', details: error.message });
    }
});

module.exports = router;
