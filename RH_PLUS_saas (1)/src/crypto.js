'use strict';
/* Chiffrement & sécurité : 
   - mots de passe : scrypt (sel aléatoire, comparaison à temps constant) ;
   - sessions : jetons signés HMAC-SHA256 avec expiration ;
   - codes 2FA : aléatoires, jamais stockés en clair (empreinte SHA-256) ;
   - données sensibles : AES-256-GCM (chiffrement authentifié) avec clé maître stockée hors base de données. */
const fs = require('fs');
const crypto = require('crypto');
const cfg = require('./config');

function loadOrCreateKey(path, bytes) {
  if (bytes === 32 && process.env.RHPLUS_MASTER_KEY) {
    const k = Buffer.from(process.env.RHPLUS_MASTER_KEY, 'hex');
    if (k.length !== 32) throw new Error('RHPLUS_MASTER_KEY doit être une clé hexadécimale de 64 caractères (32 octets).');
    return k;
  }
  if (fs.existsSync(path)) return fs.readFileSync(path);
  const key = crypto.randomBytes(bytes);
  fs.writeFileSync(path, key, { mode: 0o600 });
  return key;
}

const MASTER_KEY = loadOrCreateKey(cfg.MASTER_KEY_FILE, 32);
const SESSION_KEY = loadOrCreateKey(cfg.JWT_SECRET_FILE, 48);

/* ---------------------- Mots de passe ---------------------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(plain, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(plain), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/* ---------------------- Jetons de session ---------------------- */
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signToken(payload, ttlMs = cfg.SESSION_TTL_HOURS * 3600 * 1000) {
  const body = Object.assign({}, payload, { exp: Date.now() + ttlMs });
  const data = b64u(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SESSION_KEY).update(data).digest('base64url');
  return data + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_KEY).update(data).digest('base64url');
  const a = Buffer.from(sig || ''); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

/* ---------------------- Chiffrement des données ---------------------- */
function encryptField(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join(':');
}

function decryptField(blob) {
  if (!blob) return null;
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1' || !iv || !tag || !ct) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return { iv: b64u(iv), tag: b64u(cipher.getAuthTag()), ciphertext: ct };
}

function decryptBuffer(row) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(row.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(row.tag, 'base64url'));
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
}

/* ---------------------- Divers ---------------------- */
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const randomCode = (digits = 6) => String(crypto.randomInt(10 ** (digits - 1), 10 ** digits - 1));
const randomId = (prefix) => prefix + '_' + crypto.randomBytes(8).toString('hex');

module.exports = {
  hashPassword, verifyPassword, signToken, verifyToken,
  encryptField, decryptField, encryptBuffer, decryptBuffer,
  sha256, randomCode, randomId, MASTER_KEY,
};
