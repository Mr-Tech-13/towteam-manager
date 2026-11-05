import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { listNodesPage } from '../nodeStore.js';

function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE nodes (
    id INTEGER PRIMARY KEY, nodeId TEXT NOT NULL, name TEXT NOT NULL, baseUrl TEXT NOT NULL,
    credentialId TEXT NOT NULL, encryptedToken TEXT NOT NULL, version TEXT, releaseChannel TEXT,
    status TEXT NOT NULL, statusJson TEXT, lastSeenAt TEXT, lastError TEXT, createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`);
  const insert = db.prepare(`INSERT INTO nodes
    (nodeId, name, baseUrl, credentialId, encryptedToken, version, releaseChannel, status, statusJson, createdAt, updatedAt)
    VALUES (@nodeId, @name, @baseUrl, 'credential', 'token', @version, @releaseChannel, @status, '{}', '2026-11-05', '2026-11-05')`);
  for (let index = 1; index <= 31; index += 1) insert.run({
    nodeId: `node-${index}`, name: index === 4 ? 'MCO 100% Ops' : `Station ${String(index).padStart(2, '0')}`,
    baseUrl: `https://station-${index}.example.com`, version: index === 7 ? '4.0.0-preview' : '4.0.0',
    releaseChannel: index === 7 ? 'preview' : 'stable', status: index % 2 ? 'online' : 'offline'
  });
  return db;
}

test('node search covers identity, URL, version, channel, and status', () => {
  const db = database();
  try {
    assert.equal(listNodesPage(db, { query: 'mco 100%' }).total, 1);
    assert.equal(listNodesPage(db, { query: 'STATION-7.EXAMPLE' }).nodes[0].nodeId, 'node-7');
    assert.equal(listNodesPage(db, { query: 'node-12' }).total, 1);
    assert.equal(listNodesPage(db, { query: 'preview' }).total, 1);
    assert.equal(listNodesPage(db, { query: 'offline' }).total, 15);
  } finally { db.close(); }
});

test('node pagination defaults to 25 and clamps pages after filtering', () => {
  const db = database();
  try {
    const first = listNodesPage(db);
    assert.equal(first.nodes.length, 25); assert.equal(first.total, 31); assert.equal(first.totalPages, 2);
    const second = listNodesPage(db, { page: 2 });
    assert.equal(second.nodes.length, 6); assert.equal(second.page, 2);
    const clamped = listNodesPage(db, { query: 'node-1', page: 99, pageSize: 10 });
    assert.equal(clamped.page, clamped.totalPages);
  } finally { db.close(); }
});
