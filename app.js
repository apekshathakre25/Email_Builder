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
      imgSrc: ["'self'", 'data:'],
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

app.use(compression());




app.use(bodyParser.urlencoded({ extended: true, limit: env.maxRequestBodyBytes }));
app.use(bodyParser.json({ limit: env.maxRequestBodyBytes }));
app.use(cookieParser());



app.use(express.static(path.join(__dirname, 'public')));
app.use(globalLimiter);


app.use(passport.initialize());


connectMongoDB();


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));



app.get('/healthz', (req, res) => {


  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});


app.get('/', redirectIfAuthenticated, (req, res) => {
  res.render('login', {
    title: 'Login',

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
