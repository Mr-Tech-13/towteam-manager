import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { processWithConcurrency } from './bulkOperations.js';
import { decrypt, encrypt, encryptionKey, normalizeNodeUrl, passwordHash, signedJob, verifyPassword } from './lib.js';
import { listNodesPage, publicNode } from './nodeStore.js';
import { checkManagerUpdates, installManagerUpdate, restartManager } from './updates.js';
import packageInfo from './package.json' with { type: 'json' };

const { version: managerVersion } = packageInfo;

const root = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(process.env.DATABASE_URL || path.join(root, 'data', 'manager.sqlite'));
const dataDirectory = path.dirname(dbPath);
fs.mkdirSync(dataDirectory, { recursive: true });
const db = new Database(dbPath);
fs.chmodSync(dbPath, 0o600);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    passwordHash TEXT NOT NULL, createdAt TEXT NOT NULL, lastLoginAt TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    tokenHash TEXT PRIMARY KEY, userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nodeId TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    baseUrl TEXT NOT NULL UNIQUE, credentialId TEXT NOT NULL, encryptedToken TEXT NOT NULL,
    version TEXT, releaseChannel TEXT, status TEXT NOT NULL DEFAULT 'unknown', statusJson TEXT,
    lastSeenAt TEXT, lastError TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auditLogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL, nodeId INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    details TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bulkJobs (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, status TEXT NOT NULL,
    total INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
    succeeded INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    createdBy INTEGER REFERENCES users(id) ON DELETE SET NULL,
    createdAt TEXT NOT NULL, completedAt TEXT
  );
  CREATE TABLE IF NOT EXISTS bulkJobItems (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bulkJobId TEXT NOT NULL REFERENCES bulkJobs(id) ON DELETE CASCADE,
    nodeId INTEGER REFERENCES nodes(id) ON DELETE SET NULL, nodeName TEXT NOT NULL,
    status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '{}', startedAt TEXT, completedAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_manager_audit_created ON auditLogs(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_manager_bulk_items_job ON bulkJobItems(bulkJobId, id);
`);
db.prepare("UPDATE bulkJobs SET status = 'interrupted', completedAt = ? WHERE status IN ('queued', 'running')").run(new Date().toISOString());

const now = () => new Date().toISOString();
function privateValue(fileName, generate) {
  const filePath = path.join(dataDirectory, fileName);
  if (fs.existsSync(filePath)) return { value: fs.readFileSync(filePath, 'utf8').trim(), filePath, generated: false };
  const value = generate();
  fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600, flag: 'wx' });
  return { value, filePath, generated: true };
}

const configuredSecret = String(process.env.MANAGER_SECRET_KEY || '').trim();
const secretSource = /^[0-9a-f]{64}$/i.test(configuredSecret)
  ? { value: configuredSecret, generated: false }
  : privateValue('manager-secret.key', () => crypto.randomBytes(32).toString('hex'));
const secretKey = encryptionKey(secretSource.value);
const adminUsername = String(process.env.MANAGER_ADMIN_USERNAME || 'admin').trim();
const existingAdmin = db.prepare('SELECT id FROM users LIMIT 1').get();
if (!existingAdmin) {
  const configuredPassword = String(process.env.MANAGER_ADMIN_PASSWORD || '');
  const isPlaceholder = !configuredPassword || configuredPassword.startsWith('replace-with-');
  if (!isPlaceholder && configuredPassword.length < 12) {
    throw new Error('MANAGER_ADMIN_PASSWORD must be at least 12 characters. Remove it to generate a private first-run password.');
  }
  const passwordSource = isPlaceholder
    ? privateValue('initial-admin-password.txt', () => crypto.randomBytes(24).toString('base64url'))
    : { value: configuredPassword, generated: false };
  const initialPassword = passwordSource.value;
  db.prepare('INSERT INTO users (username, passwordHash, createdAt) VALUES (?, ?, ?)').run(adminUsername, passwordHash(initialPassword), now());
  console.warn(passwordSource.generated
    ? `Created TowTeam Manager administrator '${adminUsername}'. Initial password saved to ${passwordSource.filePath}.`
    : `Created TowTeam Manager administrator '${adminUsername}'.`);
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function audit(userId, action, nodeId = null, details = {}) {
  db.prepare('INSERT INTO auditLogs (userId, action, nodeId, details, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(userId, action, nodeId, JSON.stringify(details), now());
}
function requestOriginAllowed(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  const configured = String(process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return origin === configured;
}
async function nodeRequest(node, route, options = {}) {
  const token = decrypt(node.encryptedToken, secretKey);
  const response = await fetch(`${node.baseUrl}/api/node-management${route}`, {
    ...options,
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Node returned HTTP ${response.status}.`);
  return { body, token };
}
async function dispatchNodeJob(node, action) {
  const token = decrypt(node.encryptedToken, secretKey);
  const job = signedJob(action, token);
  const { body } = await nodeRequest(node, '/jobs', { method: 'POST', body: JSON.stringify(job) });
  return { jobId: job.jobId, response: body };
}
async function refreshNode(row) {
  try {
    const { body } = await nodeRequest(row, '/status');
    db.prepare(`UPDATE nodes SET name = ?, version = ?, releaseChannel = ?, status = 'online',
      statusJson = ?, lastSeenAt = ?, lastError = NULL, updatedAt = ? WHERE id = ?`)
      .run(body.nodeName || row.name, body.version || '', body.releaseChannel || '', JSON.stringify(body), now(), now(), row.id);
  } catch (error) {
    db.prepare("UPDATE nodes SET status = 'offline', lastError = ?, updatedAt = ? WHERE id = ?")
      .run(String(error.message).slice(0, 500), now(), row.id);
  }
  return publicNode(db.prepare('SELECT * FROM nodes WHERE id = ?').get(row.id));
}

async function runBulkUpdate(jobId, nodes, userId) {
  db.prepare("UPDATE bulkJobs SET status = 'running' WHERE id = ?").run(jobId);
  const concurrency = Math.max(1, Math.min(Number(process.env.BULK_UPDATE_CONCURRENCY) || 3, 10));
  try {
    await processWithConcurrency(nodes, concurrency, async node => {
      db.prepare(`UPDATE bulkJobItems SET status = 'running', startedAt = ?
        WHERE bulkJobId = ? AND nodeId = ?`).run(now(), jobId, node.id);
      let status = 'completed';
      let result;
      try {
        const dispatched = await dispatchNodeJob(node, 'install-update');
        result = { jobId: dispatched.jobId, status: dispatched.response.status, result: dispatched.response.result };
      } catch (error) {
        status = 'failed';
        result = { error: String(error.message || error).slice(0, 1000) };
      }
      db.transaction(() => {
        db.prepare(`UPDATE bulkJobItems SET status = ?, result = ?, completedAt = ?
          WHERE bulkJobId = ? AND nodeId = ?`).run(status, JSON.stringify(result || {}), now(), jobId, node.id);
        db.prepare(`UPDATE bulkJobs SET completed = completed + 1,
          succeeded = succeeded + ?, failed = failed + ? WHERE id = ?`)
          .run(status === 'completed' ? 1 : 0, status === 'failed' ? 1 : 0, jobId);
      })();
    });
    const totals = db.prepare('SELECT total, completed, succeeded, failed FROM bulkJobs WHERE id = ?').get(jobId);
    db.prepare("UPDATE bulkJobs SET status = ?, completedAt = ? WHERE id = ?")
      .run(totals.failed ? 'completed_with_errors' : 'completed', now(), jobId);
    audit(userId, 'bulk.install-update.complete', null, { jobId, ...totals });
  } catch (error) {
    db.prepare("UPDATE bulkJobs SET status = 'failed', completedAt = ? WHERE id = ?").run(now(), jobId);
    audit(userId, 'bulk.install-update.failed', null, { jobId, error: error.message });
  }
}

const app = express();
if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0') app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.use(helmet({ contentSecurityPolicy: { directives: { scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'] } } }));
app.use(express.json({ limit: '64kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !requestOriginAllowed(req)) return res.status(403).json({ error: 'Request origin is not allowed.' });
  next();
});

const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
app.post('/api/login', loginLimit, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(req.body?.username || '').trim());
  if (!user || !verifyPassword(req.body?.password, user.passwordHash)) return res.status(401).json({ error: 'Invalid username or password.' });
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(now());
  db.prepare('INSERT INTO sessions (tokenHash, userId, expiresAt, createdAt) VALUES (?, ?, ?, ?)').run(hash(token), user.id, expiresAt, now());
  db.prepare('UPDATE users SET lastLoginAt = ? WHERE id = ?').run(now(), user.id);
  audit(user.id, 'auth.login');
  res.cookie('towteam_manager_session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.PUBLIC_ORIGIN?.startsWith('https://'), maxAge: 12 * 60 * 60_000, path: '/' });
  res.json({ username: user.username });
});
app.get('/api/health', (_req, res) => res.json({ ok: true, name: process.env.MANAGER_NAME || 'TowTeam Manager', version: managerVersion }));

function requireAuth(req, res, next) {
  const token = String(req.get('cookie') || '').split(';').map(value => value.trim()).find(value => value.startsWith('towteam_manager_session='))?.split('=')[1];
  const session = token && db.prepare(`SELECT users.id, users.username FROM sessions
    JOIN users ON users.id = sessions.userId WHERE sessions.tokenHash = ? AND sessions.expiresAt > ?`).get(hash(token), now());
  if (!session) return res.status(401).json({ error: 'Authentication required.' });
  req.user = session;
  req.sessionHash = hash(token);
  next();
}

app.use('/api', requireAuth);
app.get('/api/me', (req, res) => res.json({ username: req.user.username, managerName: process.env.MANAGER_NAME || 'TowTeam Manager', version: managerVersion }));
app.post('/api/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(req.sessionHash);
  res.clearCookie('towteam_manager_session', { path: '/' });
  res.status(204).end();
});
app.get('/api/nodes', (req, res) => {
  if (req.query.paginated === 'true') {
    return res.json(listNodesPage(db, { query: req.query.q, page: req.query.page, pageSize: req.query.pageSize }));
  }
  res.json(db.prepare('SELECT * FROM nodes ORDER BY name COLLATE NOCASE').all().map(publicNode));
});
app.get('/api/updates', async (req, res) => {
  try { res.json(await checkManagerUpdates()); }
  catch (error) { res.status(500).json({ error: error.message || 'Unable to check for manager updates.' }); }
});
app.post('/api/updates/install', async (req, res) => {
  try {
    const result = await installManagerUpdate();
    audit(req.user.id, 'manager.update', null, result);
    if (result.restartRequired) res.once('finish', restartManager);
    res.json(result);
  } catch (error) { res.status(409).json({ error: error.message || 'Unable to install manager update.' }); }
});
app.post('/api/nodes/enroll', async (req, res) => {
  try {
    const baseUrl = normalizeNodeUrl(req.body?.baseUrl);
    const enrollmentKey = String(req.body?.enrollmentKey || '').trim();
    if (!enrollmentKey || enrollmentKey.length > 256) throw new Error('Enter the one-time enrollment key.');
    const response = await fetch(`${baseUrl}/api/node-management/enroll`, {
      method: 'POST', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentKey, label: process.env.MANAGER_NAME || 'TowTeam Manager' })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Node returned HTTP ${response.status}.`);
    const timestamp = now();
    const result = db.prepare(`INSERT INTO nodes
      (nodeId, name, baseUrl, credentialId, encryptedToken, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?)`)
      .run(body.nodeId, String(req.body?.name || body.nodeName || 'TowTeam').trim().slice(0, 80), baseUrl, body.credentialId, encrypt(body.token, secretKey), timestamp, timestamp);
    audit(req.user.id, 'node.enroll', result.lastInsertRowid, { nodeId: body.nodeId, baseUrl });
    res.status(201).json(await refreshNode(db.prepare('SELECT * FROM nodes WHERE id = ?').get(result.lastInsertRowid)));
  } catch (error) {
    const status = /UNIQUE constraint/.test(error.message) ? 409 : 400;
    res.status(status).json({ error: status === 409 ? 'This node or URL is already enrolled.' : error.message });
  }
});
app.post('/api/nodes/:id/refresh', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found.' });
  const result = await refreshNode(node);
  audit(req.user.id, 'node.refresh', node.id, { status: result.status });
  res.json(result);
});
app.post('/api/nodes/:id/jobs', async (req, res) => {
  const allowed = new Set(['status', 'check-update', 'install-update', 'restart', 'backup']);
  const action = String(req.body?.action || '');
  if (!allowed.has(action)) return res.status(400).json({ error: 'Unsupported management action.' });
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found.' });
  try {
    const { jobId, response } = await dispatchNodeJob(node, action);
    audit(req.user.id, `job.${action}`, node.id, { jobId, result: response.result || response.status });
    res.json(response);
  } catch (error) {
    audit(req.user.id, `job.${action}.failed`, node.id, { error: error.message });
    res.status(409).json({ error: error.message });
  }
});
app.post('/api/nodes/bulk-update', (req, res) => {
  const active = db.prepare("SELECT id FROM bulkJobs WHERE status IN ('queued', 'running') LIMIT 1").get();
  if (active) return res.status(409).json({ error: 'A bulk node operation is already running.', jobId: active.id });
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY name COLLATE NOCASE').all();
  if (!nodes.length) return res.status(400).json({ error: 'No nodes are enrolled.' });
  const jobId = crypto.randomUUID();
  const timestamp = now();
  db.transaction(() => {
    db.prepare(`INSERT INTO bulkJobs (id, action, status, total, createdBy, createdAt)
      VALUES (?, 'install-update', 'queued', ?, ?, ?)`).run(jobId, nodes.length, req.user.id, timestamp);
    const insertItem = db.prepare(`INSERT INTO bulkJobItems (bulkJobId, nodeId, nodeName, status)
      VALUES (?, ?, ?, 'queued')`);
    for (const node of nodes) insertItem.run(jobId, node.id, node.name);
  })();
  audit(req.user.id, 'bulk.install-update.start', null, { jobId, total: nodes.length });
  res.status(202).json({ id: jobId, status: 'queued', total: nodes.length, completed: 0, succeeded: 0, failed: 0 });
  setImmediate(() => runBulkUpdate(jobId, nodes, req.user.id));
});
app.get('/api/bulk-jobs/active', (_req, res) => {
  const job = db.prepare("SELECT * FROM bulkJobs WHERE status IN ('queued', 'running') ORDER BY createdAt DESC LIMIT 1").get();
  if (!job) return res.status(204).end();
  res.json(job);
});
app.get('/api/bulk-jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM bulkJobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Bulk job not found.' });
  const failures = db.prepare(`SELECT nodeName, result FROM bulkJobItems
    WHERE bulkJobId = ? AND status = 'failed' ORDER BY id LIMIT 100`).all(job.id)
    .map(item => ({ nodeName: item.nodeName, ...JSON.parse(item.result || '{}') }));
  res.json({ ...job, failures });
});
app.delete('/api/nodes/:id', (req, res) => {
  const node = db.prepare('SELECT id, nodeId, baseUrl FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found.' });
  audit(req.user.id, 'node.remove', node.id, { nodeId: node.nodeId, baseUrl: node.baseUrl });
  db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
  res.status(204).end();
});
app.get('/api/audit', (req, res) => {
  const pageSize = [10, 25, 50, 100].includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 25;
  const page = Math.max(1, Number(req.query.page) || 1);
  const total = db.prepare('SELECT COUNT(*) count FROM auditLogs').get().count;
  const logs = db.prepare(`SELECT auditLogs.*, users.username, nodes.name AS nodeName FROM auditLogs
    LEFT JOIN users ON users.id = auditLogs.userId LEFT JOIN nodes ON nodes.id = auditLogs.nodeId
    ORDER BY auditLogs.id DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize).map(row => ({ ...row, details: JSON.parse(row.details || '{}') }));
  res.json({ logs, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

app.use(express.static(path.join(root, 'public'), { index: false }));
app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'public', 'index.html')));
const port = Number(process.env.PORT || 8090);
app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`TowTeam Manager listening on port ${port}`));
