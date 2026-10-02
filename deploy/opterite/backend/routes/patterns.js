'use strict';

const express = require('express');
const { listInboxPatternMetadata } = require('../config/inboxPatterns');

const router = express.Router();

router.get('/api/patterns', (req, res) => {
  res.set('Cache-Control', 'private, max-age=60');
  res.json({ patterns: listInboxPatternMetadata() });
});

module.exports = router;
