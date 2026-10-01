'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const env = require('../config/env');
const { authenticateToken } = require('../middleware/auth');
const patternsRouter = require('../routes/patterns');

let server;
let baseUrl;

function buildTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use('/', authenticateToken, patternsRouter);
  return app;
}

function getPatterns(headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${baseUrl}/api/patterns`, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
        });
      });
    });
    request.on('error', reject);
  });
}

test.before(async () => {
  const app = buildTestApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('GET /api/patterns requires authentication', async () => {
  const response = await getPatterns({ Accept: 'application/json' });

  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
  assert.equal(response.body.message, 'Authentication required');
});

test('GET /api/patterns returns public metadata only for authenticated users', async () => {
  const token = jwt.sign(
    { email: 'tester@example.com', name: 'Tester' },
    env.jwtSecret,
    { expiresIn: '5m' }
  );
  const response = await getPatterns({
    Accept: 'application/json',
    Cookie: `auth_token=${token}`
  });

  assert.equal(response.status, 200);
  assert.match(response.headers['cache-control'], /^private/);
  assert.deepEqual(response.body.patterns.map(({ id, name }) => ({ id, name })), [
    { id: 'pattern-1', name: 'Pattern 1' },
    { id: 'pattern-2', name: 'Pattern 2' },
    { id: 'pattern-3', name: 'Pattern 3' }
  ]);

  for (const pattern of response.body.patterns) {
    assert.deepEqual(Object.keys(pattern).sort(), ['description', 'id', 'name']);
  }

  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /mailOptions|messageId|baseBoundary|headers|\{\{|\[\[/i);
});
