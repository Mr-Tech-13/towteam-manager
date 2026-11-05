import crypto from 'node:crypto';

export function normalizeNodeUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error('Enter a valid node URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Node URL must be an HTTP or HTTPS origin without credentials, query, or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function canonicalJob(job) {
  return JSON.stringify({ jobId: job.jobId, action: job.action, payload: job.payload || {}, timestamp: job.timestamp });
}

export function signedJob(action, token, payload = {}) {
  const job = { jobId: crypto.randomUUID(), action, payload, timestamp: new Date().toISOString() };
  job.signature = crypto.createHmac('sha256', tokenHash(token)).update(canonicalJob(job)).digest('hex');
  return job;
}

export function encryptionKey(value) {
  if (!/^[0-9a-f]{64}$/i.test(String(value || ''))) throw new Error('MANAGER_SECRET_KEY must contain exactly 64 hexadecimal characters.');
  return Buffer.from(value, 'hex');
}

export function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decrypt(value, key) {
  const [iv, tag, encrypted] = String(value || '').split('.').map(part => Buffer.from(part, 'base64url'));
  if (!iv?.length || !tag?.length || !encrypted?.length) throw new Error('Stored node credential is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function passwordHash(password, salt = crypto.randomBytes(16)) {
  return `${salt.toString('hex')}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
