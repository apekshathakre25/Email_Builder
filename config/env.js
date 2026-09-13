require('dotenv').config({ quiet: true });

const MIN_SECRET_LENGTH = 32;
const KEY_HEX_LENGTH = 64;


const APP_NAME = 'Bulk Email Sender';


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


  trustProxy: process.env.TRUST_PROXY === undefined
    ? (isProduction ? 1 : 0)
    : parsePositiveIntOrZero('TRUST_PROXY', isProduction ? 1 : 0)
};


env.cookieSecure = isProduction;

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
