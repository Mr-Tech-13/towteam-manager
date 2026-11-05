import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkManagerUpdates, installManagerUpdate, mergeEnvironment } from '../updates.js';

function runner(overrides = {}) {
  const calls = [];
  const values = {
    'fetch --prune': '', 'branch --show-current': 'main',
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main',
    'rev-parse HEAD': 'local', 'rev-parse @{u}': 'remote',
    'rev-list --left-right --count HEAD...@{u}': '0\t1',
    'status --porcelain --untracked-files=no': '',
    'log -1 --format=%h %s @{u}': 'abc123 Manager release',
    'show @{u}:package.json': JSON.stringify({ version: '0.0.2' }),
    'pull --ff-only': 'Updating local..remote', ...overrides
  };
  return { calls, run: async args => { const key = args.join(' '); calls.push(key); if (!(key in values)) throw new Error(`Unexpected command: ${key}`); return values[key]; } };
}

test('manager update check requires opt-in and a standalone repository', async () => {
  assert.equal((await checkManagerUpdates({ enabled: false })).enabled, false);
  const status = await checkManagerUpdates({ enabled: true, repository: false });
  assert.equal(status.canUpdate, false);
  assert.match(status.message, /own Git checkout/i);
});

test('manager update check allows only clean fast-forward releases', async () => {
  const clean = runner();
  const status = await checkManagerUpdates({ run: clean.run, enabled: true, repository: true });
  assert.equal(status.canUpdate, true); assert.equal(status.remoteVersion, '0.0.2');
  const dirty = runner({ 'status --porcelain --untracked-files=no': ' M server.js' });
  assert.equal((await checkManagerUpdates({ run: dirty.run, enabled: true, repository: true })).canUpdate, false);
});

test('manager environment merge preserves existing values and appends new keys', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-env-'));
  try {
    fs.writeFileSync(path.join(directory, '.env'), 'PORT=9000\nSECRET=private\n');
    fs.writeFileSync(path.join(directory, '.env.example'), 'PORT=8090\nSECRET=example\nNEW_OPTION=true\n');
    const result = mergeEnvironment({ directory, timestamp: new Date('2026-11-05T12:00:00Z') });
    assert.deepEqual(result.added, ['NEW_OPTION']);
    const contents = fs.readFileSync(path.join(directory, '.env'), 'utf8');
    assert.match(contents, /PORT=9000/); assert.match(contents, /SECRET=private/); assert.match(contents, /NEW_OPTION=true/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('manager install pulls fast-forward and requests a supervisor restart', async () => {
  const mock = runner({ 'rev-parse HEAD': 'remote' });
  const result = await installManagerUpdate({ run: mock.run, enabled: true, repository: true, merge: () => ({ changed: false, added: [] }) });
  assert.equal(result.updated, true); assert.equal(result.restartRequired, true); assert.ok(mock.calls.includes('pull --ff-only'));
});
