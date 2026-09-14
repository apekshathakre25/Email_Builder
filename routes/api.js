const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { authenticateToken } = require('../middleware/auth');
const env = require('../config/env');

const sampleDir = path.join(__dirname, '..', 'uploads', 'sample');

router.use(authenticateToken);

if (!fs.existsSync(sampleDir)) {
    fs.mkdirSync(sampleDir, { recursive: true });
}

router.get('/file-upload', (req, res) => {
    // maxUploadBytes is rendered into the page so the browser can reject an
    // oversized file before spending bandwidth on it. The server-side multer
    // limit remains the authority; this is only a UX preflight.
    res.render('file-upload', {
        title: 'File Management',
        user: req.user,
        maxUploadBytes: env.maxUploadBytes
    });
});

router.get('/imapac', (req, res) => {
    res.render('imapac', { title: 'IMAP Account Management', user: req.user });
});

module.exports = router;
