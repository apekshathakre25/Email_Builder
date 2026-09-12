// Must come first: validates all required configuration and throws before any
// component gets a chance to start with a missing or placeholder secret.
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
const path = require('path');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { globalLimiter } = require('./middleware/rateLimit');
const sendEmailsRouter = require('./routes/sendemails');
const systemHealthRouter = require('./routes/system-health');
const imapRouter = require('./routes/imap');
const authRouter = require('./routes/auth');
const apiRouter = require('./routes/api');
const mongoose = require('mongoose');
const connectMongoDB = require('./config/mongodb');
const { authenticateToken, redirectIfAuthenticated } = require('./middleware/auth');
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


// Behind nginx/a load balancer, req.ip and req.protocol are only correct once
// Express is told how many proxy hops to trust. Rate limiting and Secure
// cookies both depend on this being right.
app.set('trust proxy', env.trustProxy);

// Remove the default "X-Powered-By: Express" version disclosure.
app.disable('x-powered-by');

/**
 * Security headers.
 *
 * The CSP allows the CDNs the templates actually load (Google Fonts, cdnjs for
 * Font Awesome, the Tailwind play CDN) and permits inline script/style because
 * the EJS views contain inline <script> and <style> blocks plus inline event
 * handlers. Dropping 'unsafe-inline' would be a genuine improvement but requires
 * extracting all inline code to files first, so it is deliberately left as a
 * follow-up rather than silently breaking the UI.
 */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],   // clickjacking protection
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      // Only meaningful over HTTPS; omitted locally so dev pages still load.
      upgradeInsecureRequests: env.isProduction ? [] : null
    }
  },
  // HSTS is only sent in production: pinning localhost to HTTPS would make
  // local development unreachable in that browser afterwards.
  hsts: env.isProduction
    ? { maxAge: 15552000, includeSubDomains: true, preload: false }
    : false,
  referrerPolicy: { policy: 'same-origin' },
  crossOriginEmbedderPolicy: false // would block the third-party CDN assets
}));

app.use(compression());

// Was 500mb, which made it trivial to exhaust memory. Sized via
// MAX_REQUEST_BODY_MB (default 10mb) — ample for an HTML email plus headers,
// while recipient lists arrive as file uploads with their own limit.
app.use(bodyParser.urlencoded({ extended: true, limit: env.maxRequestBodyBytes }));
app.use(bodyParser.json({ limit: env.maxRequestBodyBytes }));
app.use(cookieParser());

// Rate limiting is applied before the routes but after static assets, so CSS
// and JS requests don't consume a user's request budget.
app.use(express.static(path.join(__dirname, 'public')));
app.use(globalLimiter);


app.use(passport.initialize());


connectMongoDB();


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));


app.get('/', redirectIfAuthenticated, (req, res) => {
  res.render('login', {
    title: 'Login',
    // Only the fields the template needs; keeps the allowlist in config.
    authorizedUsers: env.authorizedUsers.map(({ email, name }) => ({ email, name }))
  });
});


app.use('/', authRouter);


app.get('/interface', authenticateToken, (req, res) => {
  res.render('index', { title: 'Bulk Email Sender', user: req.user });
});
app.use('/', authenticateToken, sendEmailsRouter);
app.use('/', authenticateToken, systemHealthRouter);
app.use('/imap', authenticateToken, imapRouter);
app.use('/', authenticateToken, apiRouter);


app.get('/ssl-test', (req, res) => {
  res.send('ssl-ok');
});


app.use((req, res) => {
  res.status(404).render('404');
});


app.use((err, req, res, next) => {
  // Oversized bodies and rejected uploads are client errors, not server faults.
  // Returning 500 for them hid the real cause from whoever was uploading.
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

  // Never leak stack traces or internal messages to clients in production.
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    ...(env.isProduction ? {} : { message: err.message })
  });
});

// Bind to 0.0.0.0 (not the default localhost) so Render's proxy can reach the
// container from outside; localhost-only binds fail their port health check.
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);

  // Tells PM2 (wait_ready: true) that this worker is accepting connections, so
  // a reload only cycles the next instance once this one is actually serving.
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

/**
 * Stops accepting new connections, lets in-flight requests finish, then closes
 * MongoDB. Without this, a PM2 reload or container stop severed live requests.
 *
 * The timer is a backstop: if a long-lived connection refuses to drain we exit
 * anyway rather than hanging until the supervisor SIGKILLs us.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`📴 Received ${signal}, draining connections…`);

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

// PM2 sends SIGINT on stop/reload; SIGTERM comes from Docker and most others.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * A rejection that reaches this point means a code path is missing error
 * handling. Log it rather than letting Node terminate the process silently.
 */
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // State is unreliable after this point — let PM2 restart us.
  shutdown('uncaughtException');
});

module.exports = server;