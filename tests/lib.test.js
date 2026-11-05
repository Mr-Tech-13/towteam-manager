import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJob, decrypt, encrypt, encryptionKey, normalizeNodeUrl, passwordHash, signedJob, tokenHash, verifyPassword } from '../lib.js';
import crypto from 'node:crypto';

test('normalizes safe node origins and rejects credential-bearing URLs', () => {
  assert.equal(normalizeNodeUrl('https://tow.example.com/'), 'https://tow.example.com');
  assert.equal(normalizeNodeUrl('http://10.0.0.2:8080/base/'), 'http://10.0.0.2:8080/base');
  for (const value of ['file:///tmp/node', 'https://user:pass@example.com', 'https://example.com?a=1']) assert.throws(() => normalizeNodeUrl(value));
});

test('encrypts stored node credentials with authenticated encryption', () => {
  const key = encryptionKey('a'.repeat(64));
  const encrypted = encrypt('node-secret', key);
  assert.notEqual(encrypted, 'node-secret');
  assert.equal(decrypt(encrypted, key), 'node-secret');
  const parts = encrypted.split('.');
  const ciphertext = Buffer.from(parts[2], 'base64url');
  ciphertext[0] ^= 1;
  parts[2] = ciphertext.toString('base64url');
  assert.throws(() => decrypt(parts.join('.'), key));
});

test('signs jobs exactly as TowTeam nodes verify them', () => {
  const token = 'node-token-value';
  const job = signedJob('backup', token);
  const expected = crypto.createHmac('sha256', tokenHash(token)).update(canonicalJob(job)).digest('hex');
  assert.equal(job.signature, expected);
});

test('hashes and verifies administrator passwords', () => {
  const stored = passwordHash('a sufficiently long password');
  assert.equal(verifyPassword('a sufficiently long password', stored), true);
  assert.equal(verifyPassword('wrong password', stored), false);
});
