const env = require('./config/env');
const compression = require('compression');
const logger = require('./utils/logger');

if (process.env.NODE_ENV === 'production') {

  const originalLog = console.log;
  console.log = (...args) => {

  };
  console.info = () => {};
  console.debug = () => {};

}

const express = require('express');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { globalLimiter, sendLimiter, monitoringLimiter } = require('./middleware/rateLimit');
const sendEmailsRouter = require('./routes/sendemails');
const appConfigRouter = require('./routes/appConfig');
const patternsRouter = require('./routes/patterns');
const campaignQueueRouter = require('./routes/campaignQueue');
const systemHealthRouter = require('./routes/system-health');
const imapRouter = require('./routes/imap');
const authRouter = require('./routes/auth');
const mongoose = require('mongoose');
const connectMongoDB = require('./config/mongodb');
const { startCleanupScheduler, stopCleanupScheduler } = require('./utils/dbCleanup');
const { authenticateToken } = require('./middleware/auth');
const passport = require('passport');

const app = express();
const PORT = env.port;

const fs = require("fs");


if (fs.existsSync("/var/www/certbot/.well-known/acme-challenge")) {
  app.use(
    "/.well-known/acme-challenge",
    express.static("/var/www/certbot/.well-known/acme-challenge")
  );
}





app.set('trust proxy', env.trustProxy);


app.disable('x-powered-by');


app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com'],







      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      // Remote images are required by the Message/HTML preview: email templates
      // reference images on the sender's CDN, and a srcdoc iframe inherits this
      // policy, so 'self' alone renders every remote <img> as a broken image.
      // The preview frame ships its own tighter policy (see html-preview.js);
      // this only widens the image sources the page is permitted to fetch.
      imgSrc: ["'self'", 'data:', 'https:', 'http:'],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],

      upgradeInsecureRequests: env.isProduction ? [] : null
    }
  },


  hsts: env.isProduction
    ? { maxAge: 15552000, includeSubDomains: true, preload: false }
    : false,
  referrerPolicy: { policy: 'same-origin' },
  crossOriginEmbedderPolicy: false
}));

/**
 * Cross-origin access for the React frontend.
 *
 * Mounted here — after helmet, before every rate limiter — for two reasons:
 *
 *   1. A CORS preflight is an OPTIONS request the browser sends on its own. It
 *      carries no cookie and does no work, so it must not draw down the same
 *      bucket a real request needs. Answering it above the limiters also keeps
 *      it away from the 404 handler, which renders HTML and would turn a
 *      preflight into an opaque failure with no CORS headers at all.
 *
 *   2. `credentials: true` is mandatory rather than optional. Auth is a single
 *      httpOnly cookie (config/cookies.js), so without it the browser would
 *      neither store the Set-Cookie from POST /login nor attach the cookie to
 *      any later request. That also rules out a wildcard origin: the spec
 *      forbids `Access-Control-Allow-Origin: *` on a credentialed request, which
 *      is why the origin is an explicit allowlist and is echoed back per request.
 *
 * With no CORS_ORIGINS configured in production this is effectively inert: the
 * allowlist is empty, so no cross-origin browser request is permitted and the
 * deployment is expected to serve the built SPA from this origin. Same-origin
 * requests never consult CORS at all.
 */
const corsOptions = {
  origin(origin, callback) {
    // No Origin header: same-origin navigation, curl, and health checks need no
    // cross-origin authorisation.
    if (!origin) return callback(null, true);

    if (env.corsOrigins.includes(origin)) return callback(null, true);

    // Refused by omission, not by throwing. Returning `false` sends the response
    // without CORS headers and lets the browser enforce the block, which is the
    // outcome we want; an error here would be surfaced by the error handler as a
    // 500 and would obscure a simple misconfiguration.
    if (env.corsOrigins.length > 0) {
      console.warn(`[CORS] Refused origin ${origin}. Allowed: ${env.corsOrigins.join(', ') || '(none)'}`);
    }
    return callback(null, false);
  },
  credentials: true,

  // Content-Disposition carries the filename for every CSV and original-file
  // download. Response headers are not readable cross-origin unless they are
  // named here, and without it the download helper silently falls back to a
  // generated filename.
  exposedHeaders: ['Content-Disposition', 'Content-Type', 'Retry-After'],

  // Cache the preflight so a polling client is not preflighting on every call.
  maxAge: 600,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

app.use(compression());




app.use(bodyParser.urlencoded({ extended: true, limit: env.maxRequestBodyBytes }));
app.use(bodyParser.json({ limit: env.maxRequestBodyBytes }));
app.use(cookieParser());



// Dedicated rate-limit buckets, mounted ahead of the global backstop so these
// paths draw from their own allowance instead of a shared one.
//
// This ordering is the fix for the stalled-campaign incident: monitoring traffic
// used to exhaust the same bucket POST /send-email needed, so heavy /status
// polling produced 429s on send and sending stopped until the window rolled
// over. Separate buckets make that impossible — /status can only ever starve
// /status.
//
// globalLimiter skips exactly these paths (DEDICATED_LIMITER_PATHS in
// middleware/rateLimit.js), so every request is still counted by one limiter and
// nothing is left unprotected.
app.use('/send-email', sendLimiter);
app.use('/status', monitoringLimiter);
app.use('/api/system-health', monitoringLimiter);

app.use(globalLimiter);


app.use(passport.initialize());


connectMongoDB();


// Retention sweep for disposable data (campaign logs, per-recipient outcomes,
// inbox tests, spent recipient files). Driven entirely by DB_CLEANUP_DAYS.
//
// Lives in the web process rather than the worker because the workers are
// throughput-critical and far more numerous. It waits for the MongoDB handshake
// internally, and coordinates through a Redis lock so only one of the PM2
// cluster instances actually sweeps.
startCleanupScheduler();


app.get('/healthz', (req, res) => {


  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});


// Bootstrap configuration for the React frontend: server-owned values that the
// SPA needs before or during authenticated use (authorized users, upload limit,
// and validation bounds).
//
// Mounted before authenticated API routes so it is reachable regardless of auth state.
app.use(appConfigRouter);

app.use('/', authRouter);

app.use('/', authenticateToken, patternsRouter);
app.use('/', authenticateToken, sendEmailsRouter);
// Sequences one operator's campaigns so two tabs cannot send at once. Mounted after
// sendEmailsRouter because it imports from it, and behind authenticateToken because
// the lane is scoped to req.user.email.
app.use('/', authenticateToken, campaignQueueRouter);
app.use('/', authenticateToken, systemHealthRouter);
app.use('/imap', authenticateToken, imapRouter);


app.get('/ssl-test', (req, res) => {
  res.send('ssl-ok');
});


app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});


app.use((err, req, res, next) => {


  if (err.type === 'entity.too.large' || err.status === 413 || err.code === 'LIMIT_FILE_SIZE') {
    console.warn(`Rejected oversized request on ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.status(413).json({
      success: false,
      error: 'Request too large.',
      message: `The upload or request body exceeded the configured limit (${Math.round(env.maxRequestBodyBytes / (1024 * 1024))}MB body, ${Math.round(env.maxUploadBytes / (1024 * 1024))}MB per file).`
    });
  }

  if (err.code === 'UNSUPPORTED_FILE_TYPE' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    console.warn(`Rejected upload on ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.status(400).json({ success: false, error: err.message });
  }

  console.error('Unhandled error:', err);


  res.status(500).json({
    success: false,
    error: 'Internal server error',
    ...(env.isProduction ? {} : { message: err.message })
  });
});



const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);



  if (typeof process.send === 'function') {
    process.send('ready');
  }
});


server.keepAliveTimeout = 130000;
server.headersTimeout   = 135000;

server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
    socket.destroy();
    return;
  }
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});


let shuttingDown = false;


async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`📴 Received ${signal}, draining connections…`);

  // Stop scheduling new sweeps. An in-flight sweep is left to finish against the
  // still-open Mongo connection; its Redis lock expires on its own if the
  // process dies mid-run, so the next boot is not blocked.
  stopCleanupScheduler();

  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out; forcing exit.');
    process.exit(1);
  }, 25000);
  forceExit.unref();

  server.close(async () => {
    try {
      await mongoose.connection.close();
      console.log('✅ Server shut down cleanly');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err.message);
      process.exit(1);
    }
  });
}


process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));


process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);

  shutdown('uncaughtException');
});

module.exports = server;
