// Resolves .env from the backend directory rather than the working directory, so
// `node app.js`, `node backend/app.js` and pm2 all read the same file. See
// config/loadEnv.js.
require('./loadEnv');

const MIN_SECRET_LENGTH = 32;
const KEY_HEX_LENGTH = 64;


const APP_NAME = 'Opterite';


const FREEMAIL_SENDER_DOMAINS = [
  'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk',
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'proton.me', 'protonmail.com'
];

const isProduction = process.env.NODE_ENV === 'production';

const errors = [];
const warnings = [];


const PLACEHOLDER_PATTERNS = [
  'your-super-secret',
  'change-this',
  'changeme',
  'replace-me',
  'example'
];

function looksLikePlaceholder(value) {
  const lower = String(value).toLowerCase();
  return PLACEHOLDER_PATTERNS.some(p => lower.includes(p));
}

function required(name, { minLength = 0 } = {}) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    errors.push(`${name} is required but not set.`);
    return undefined;
  }

  if (minLength && value.length < minLength) {
    errors.push(`${name} must be at least ${minLength} characters (got ${value.length}).`);
    return value;
  }

  return value;
}


function requiredSecret(name) {
  const value = required(name, { minLength: MIN_SECRET_LENGTH });
  if (!value) return undefined;

  if (looksLikePlaceholder(value)) {
    const message = `${name} still contains a placeholder value. Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`;
    if (isProduction) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  return value;
}


function optionalSecret(name) {
  const value = process.env[name];
  if (!value || !value.trim()) return undefined;

  if (value.length < MIN_SECRET_LENGTH) {
    errors.push(`${name} is set but shorter than ${MIN_SECRET_LENGTH} characters. Remove it or use a strong value.`);
    return value;
  }

  if (looksLikePlaceholder(value)) {
    const message = `${name} is set to a placeholder value.`;
    if (isProduction) errors.push(message);
    else warnings.push(message);
  }

  return value;
}

function requiredInProduction(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    const message = `${name} is not set; login OTP emails cannot be delivered.`;
    if (isProduction) {
      errors.push(`${name} is required in production.`);
    } else {
      warnings.push(message);
    }
    return undefined;
  }

  return value;
}


function parseAuthorizedUsers(raw) {
  if (!raw || !raw.trim()) {
    errors.push('AUTHORIZED_USERS is required (format: "email:Name,email2:Name Two").');
    return [];
  }

  const users = [];

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(':');
    const email = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim().toLowerCase();
    const name = separator === -1 ? '' : trimmed.slice(separator + 1).trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push(`AUTHORIZED_USERS contains an invalid email: "${trimmed}".`);
      continue;
    }

    users.push({ email, name: name || email });
  }

  if (users.length === 0) {
    errors.push('AUTHORIZED_USERS did not yield any valid users; nobody would be able to log in.');
  }

  return users;
}

function parseEncryptionKey(raw) {
  if (!raw || !raw.trim()) {
    errors.push(
      'CREDENTIAL_ENCRYPTION_KEY is required (64 hex chars). Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    return undefined;
  }

  const value = raw.trim();

  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    errors.push(`CREDENTIAL_ENCRYPTION_KEY must be exactly ${KEY_HEX_LENGTH} hexadecimal characters (32 bytes).`);
    return undefined;
  }

  return Buffer.from(value, 'hex');
}


function parsePositiveIntOrZero(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    warnings.push(`${name}="${raw}" is not a non-negative integer; falling back to ${fallback}.`);
    return fallback;
  }

  return parsed;
}

function parsePositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warnings.push(`${name}="${raw}" is not a positive number; falling back to ${fallback}.`);
    return fallback;
  }

  return Math.floor(parsed);
}


/**
 * Integer within an inclusive range.
 *
 * Used for the retention settings, where a silently-accepted absurd value is
 * dangerous in a specific way: DB_CLEANUP_DAYS=0 would mean "delete everything
 * written up to this instant" on the next sweep. Out-of-range values fall back
 * to the default and warn rather than being clamped, so a typo is visible in the
 * logs instead of quietly becoming a different retention policy.
 */
function parseIntInRange(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);

  if (!Number.isInteger(parsed)) {
    warnings.push(`${name}="${raw}" is not an integer; falling back to ${fallback}.`);
    return fallback;
  }

  if (parsed < min || parsed > max) {
    warnings.push(
      `${name}=${parsed} is outside the supported range ${min}–${max}; falling back to ${fallback}.`
    );
    return fallback;
  }

  return parsed;
}

function parseBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const normalized = String(raw).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;

  warnings.push(`${name}="${raw}" is not a boolean; falling back to ${fallback}.`);
  return fallback;
}


/**
 * Normalises a browser origin to the form the CORS check compares against:
 * scheme + host + optional port, no trailing slash, no path.
 *
 * Returns undefined for anything that is not a parseable absolute URL, so a
 * typo in CORS_ORIGINS is reported instead of silently allowing nothing.
 */
function normalizeOrigin(raw) {
  const value = String(raw || '').trim();
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}


/**
 * Origins permitted to call this API with credentials.
 *
 * This exists because the frontend is no longer served by this process. The
 * React app runs on its own origin (Vite on :5173 in development, a static host
 * or a reverse-proxy path in production) and every request it makes carries the
 * auth cookie, so the browser requires an explicit, non-wildcard
 * Access-Control-Allow-Origin plus Access-Control-Allow-Credentials.
 *
 * Outside production the Vite dev server origins are allowed by default, purely
 * so `npm run dev` works with no extra configuration. Production has no
 * defaults: if CORS_ORIGINS is unset there, cross-origin browser access is
 * simply off, which is the correct posture for a deployment that serves the
 * built SPA from the same origin as the API.
 */
function parseCorsOrigins(raw) {
  const configured = [];

  for (const entry of String(raw || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const normalized = normalizeOrigin(trimmed);
    if (!normalized) {
      errors.push(`CORS_ORIGINS contains an invalid origin: "${trimmed}" (expected e.g. https://app.example.com).`);
      continue;
    }

    if (!configured.includes(normalized)) configured.push(normalized);
  }

  if (configured.length > 0) return configured;

  if (isProduction) return [];

  return [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173'
  ];
}


/**
 * SameSite policy for the auth cookie.
 *
 * Was hard-coded to 'strict', which is right while the frontend and the API
 * share an origin and is still right when they differ only by port or
 * subdomain — SameSite is evaluated on the registrable domain, so
 * localhost:5173 -> localhost:3000 and app.example.com -> api.example.com are
 * both same-site and a Strict cookie is sent.
 *
 * It is wrong only when the SPA is genuinely cross-site from the API
 * (spa.vercel.app -> api.example.com), where the browser will neither store the
 * Set-Cookie from POST /login nor attach the cookie to later requests. That
 * deployment needs 'none', which the spec only permits on a Secure cookie —
 * enforced below rather than left to produce a cookie the browser discards
 * without explanation.
 */
function parseCookieSameSite(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'strict';

  if (['strict', 'lax', 'none'].includes(value)) return value;

  warnings.push(`COOKIE_SAMESITE="${raw}" is not one of strict|lax|none; falling back to strict.`);
  return 'strict';
}

const env = {
  isProduction,
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parsePositiveInt('PORT', 3000),

  redisUrl: required('REDIS_URL'),
  mongoUri: required('MONGODB_URI'),

  jwtSecret: requiredSecret('JWT_SECRET'),




  sessionSecret: optionalSecret('SESSION_SECRET'),
  credentialEncryptionKey: parseEncryptionKey(process.env.CREDENTIAL_ENCRYPTION_KEY),

  authorizedUsers: parseAuthorizedUsers(process.env.AUTHORIZED_USERS),

  appName: APP_NAME,


  brevo: {
    apiKey: requiredInProduction('BREVO_API_KEY'),
    senderEmail: requiredInProduction('SMTP_FROM_EMAIL'),
    senderName: (process.env.BREVO_SENDER_NAME || '').trim() || APP_NAME
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL,
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    }
  },

  maxUploadBytes: parsePositiveInt('MAX_UPLOAD_MB', 25) * 1024 * 1024,
  maxRequestBodyBytes: parsePositiveInt('MAX_REQUEST_BODY_MB', 10) * 1024 * 1024,
  workerConcurrency: parsePositiveInt('WORKER_CONCURRENCY', 20),

  /**
   * Retention policy for disposable data (campaign logs, per-recipient send
   * outcomes, inbox-placement tests, spent recipient files).
   *
   * `retentionDays` is the only value that decides what gets deleted, and it has
   * no literal anywhere else in the codebase — utils/dbCleanup.js and the TTL
   * index on ImapTestResult both derive their cutoff from it.
   *
   * `intervalHours` is deliberately a separate knob and much shorter than the
   * retention window. Sweeping only once per retention period would let a full
   * period of data pile up and then delete it in one burst; sweeping every few
   * hours keeps each run small enough to stay invisible to production traffic.
   * Changing retention does not change how often the sweep runs.
   *
   * Operator config (emailconfigs, testemailaccounts, imapcredentials) is never
   * age-deleted and is not covered by any of these settings.
   */
  dbCleanup: {
    enabled: parseBoolean('DB_CLEANUP_ENABLED', true),

    // 1 day minimum: a 0 would make the cutoff "now" and wipe live campaigns.
    retentionDays: parseIntInRange('DB_CLEANUP_DAYS', 3, { min: 1, max: 3650 }),

    intervalHours: parseIntInRange('DB_CLEANUP_INTERVAL_HOURS', 6, { min: 1, max: 720 }),

    // Documents per deleteMany. Small enough that each round trip holds locks
    // briefly, large enough that a big backlog still drains.
    batchSize: parseIntInRange('DB_CLEANUP_BATCH_SIZE', 1000, { min: 100, max: 10000 }),

    // Per-collection ceiling for one run. A first sweep over a long-neglected
    // collection stops here and resumes next interval instead of running for
    // hours; it also bounds how long the distributed lock is held.
    maxDeletesPerRun: parseIntInRange('DB_CLEANUP_MAX_DELETES_PER_RUN', 250000, { min: 1000, max: 5000000 }),

    // Spent recipient files are the only cleanup target that also unlinks from
    // disk, so it gets its own off switch.
    includeUploadedFiles: parseBoolean('DB_CLEANUP_UPLOADED_FILES', true)
  },


  trustProxy: process.env.TRUST_PROXY === undefined
    ? (isProduction ? 1 : 0)
    : parsePositiveIntOrZero('TRUST_PROXY', isProduction ? 1 : 0),

  /**
   * Browser origins allowed to call this API with credentials — the React SPA.
   * See parseCorsOrigins() for why production has no default.
   */
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),

  /**
   * Where the SPA is served from, used only to hand control back to it after a
   * flow that has to leave the SPA and return through this server.
   *
   * Google OAuth is the only such flow: it is a top-level browser redirect, so
   * the callback cannot answer with JSON — it has to redirect the browser
  * somewhere, and with a separate frontend that somewhere is no longer a route
  * on this server. Empty means "same origin".
   */
  frontendUrl: normalizeOrigin(process.env.FRONTEND_URL) || ''
};


env.cookieSameSite = parseCookieSameSite(process.env.COOKIE_SAMESITE);

// SameSite=None is only honoured on a Secure cookie. Forcing it here rather than
// warning: the alternative is a cookie every browser silently drops, which
// presents as "login succeeds but the next request is unauthenticated".
env.cookieSecure = isProduction || env.cookieSameSite === 'none';

if (env.cookieSameSite === 'none' && !isProduction) {
  warnings.push(
    'COOKIE_SAMESITE=none forces a Secure cookie, which browsers only accept over HTTPS ' +
    '(localhost is exempt in Chrome and Edge, but not in Safari). Use strict or lax for plain-HTTP development.'
  );
}

if (isProduction && env.corsOrigins.length > 0 && env.cookieSameSite === 'strict') {
  const sameSiteRisk = env.corsOrigins.some(origin => {
    if (!env.frontendUrl) return false;
    return origin !== env.frontendUrl;
  });

  if (sameSiteRisk || !env.frontendUrl) {
    warnings.push(
      'CORS_ORIGINS is set while COOKIE_SAMESITE=strict. That is correct when the SPA and this API ' +
      'share a registrable domain (app.example.com -> api.example.com). If they do not, set ' +
      'COOKIE_SAMESITE=none or the auth cookie will never be sent.'
    );
  }
}


// Derived once so the day → seconds/ms conversion exists in exactly one place.
// The TTL index and the sweep cutoff must agree, or the two mechanisms would
// disagree about what "expired" means.
env.dbCleanup.retentionSeconds = env.dbCleanup.retentionDays * 24 * 60 * 60;
env.dbCleanup.retentionMs = env.dbCleanup.retentionSeconds * 1000;
env.dbCleanup.intervalMs = env.dbCleanup.intervalHours * 60 * 60 * 1000;

if (isProduction && env.google.enabled && env.google.callbackUrl?.startsWith('http://')) {
  warnings.push('GOOGLE_CALLBACK_URL uses http:// in production; OAuth redirects should be https://.');
}



if (env.brevo.apiKey && looksLikePlaceholder(env.brevo.apiKey)) {
  const message = 'BREVO_API_KEY still contains a placeholder value. Copy the real key from Brevo → SMTP & API → API keys.';
  if (isProduction) errors.push(message);
  else warnings.push(message);
}

if (env.brevo.senderEmail) {
  const senderDomain = env.brevo.senderEmail.split('@')[1]?.trim().toLowerCase();

  if (!senderDomain) {
    errors.push(`SMTP_FROM_EMAIL ("${env.brevo.senderEmail}") is not a valid email address.`);
  } else if (FREEMAIL_SENDER_DOMAINS.includes(senderDomain)) {
    warnings.push(
      `SMTP_FROM_EMAIL uses the free-mail domain "${senderDomain}". Brevo only accepts it if that exact address is verified under Senders, and it can never be SPF/DKIM-aligned for ${senderDomain}, so expect spam-foldering or rejection. Prefer a domain you control and have authenticated in Brevo.`
    );
  }
}

for (const warning of warnings) {
  console.warn(`⚠️  Config: ${warning}`);
}

if (errors.length > 0) {
  console.error('\n❌ Invalid configuration — refusing to start:\n');
  for (const error of errors) {
    console.error(`   • ${error}`);
  }
  console.error('\nSee .env.example for the full list of required variables.\n');
  throw new Error(`Invalid environment configuration (${errors.length} problem${errors.length === 1 ? '' : 's'}).`);
}

module.exports = env;
