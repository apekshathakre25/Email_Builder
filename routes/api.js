const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { authenticateToken } = require('../middleware/auth');

const sampleDir = path.join(__dirname, '..', 'uploads', 'sample');


router.use(authenticateToken);


if (!fs.existsSync(sampleDir)) {
    fs.mkdirSync(sampleDir, { recursive: true });
}


router.get('/file-upload', (req, res) => {
    res.render('file-upload', { title: 'File Management', user: req.user });
});


router.get('/imapac', (req, res) => {
    res.render('imapac', { title: 'IMAP Account Management', user: req.user });
});

module.exports = router;

