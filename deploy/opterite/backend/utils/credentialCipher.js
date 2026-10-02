const crypto = require('crypto');
const env = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1';
const IV_LENGTH = 12;
const KEY = env.credentialEncryptionKey;

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

function encrypt(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') {
    return plaintext;
  }

  const value = String(plaintext);

  // Guard against double-encrypting an already-stored value.
  if (isEncrypted(value)) {
    return value;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    PREFIX,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url')
  ].join(':');
}

function decrypt(stored) {
  if (stored === undefined || stored === null || stored === '') {
    return stored;
  }

  const value = String(stored);

  if (!isEncrypted(value)) {
    return value; // legacy plaintext
  }

  const parts = value.split(':');
  if (parts.length !== 5) {
    throw new Error('Malformed encrypted credential: unexpected segment count.');
  }

  const [, , ivPart, tagPart, dataPart] = parts;

  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

function tryDecrypt(stored) {
  try {
    return { ok: true, value: decrypt(stored) };
  } catch (err) {
    return { ok: false, value: null, error: err.message };
  }
}

module.exports = { encrypt, decrypt, tryDecrypt, isEncrypted };
