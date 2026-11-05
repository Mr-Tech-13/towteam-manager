const pageSizes = new Set([10, 25, 50, 100]);

function publicNode(row) {
  let details = {};
  try { details = JSON.parse(row.statusJson || '{}'); } catch { /* Ignore invalid legacy status. */ }
  return {
    id: row.id, nodeId: row.nodeId, name: row.name, baseUrl: row.baseUrl, version: row.version,
    releaseChannel: row.releaseChannel, status: row.status, lastSeenAt: row.lastSeenAt,
    lastError: row.lastError, createdAt: row.createdAt, details
  };
}

function escapedLike(value) {
  return `%${String(value || '').trim().replace(/[\\%_]/g, '\\$&')}%`;
}

export function listNodesPage(db, { query = '', page = 1, pageSize = 25 } = {}) {
  const size = pageSizes.has(Number(pageSize)) ? Number(pageSize) : 25;
  const requestedPage = Math.max(1, Math.floor(Number(page) || 1));
  const search = String(query || '').trim().slice(0, 200);
  const where = search ? `WHERE name LIKE @search ESCAPE '\\' COLLATE NOCASE
    OR baseUrl LIKE @search ESCAPE '\\' COLLATE NOCASE
    OR nodeId LIKE @search ESCAPE '\\' COLLATE NOCASE
    OR version LIKE @search ESCAPE '\\' COLLATE NOCASE
    OR releaseChannel LIKE @search ESCAPE '\\' COLLATE NOCASE
    OR status LIKE @search ESCAPE '\\' COLLATE NOCASE` : '';
  const params = search ? { search: escapedLike(search) } : {};
  const total = db.prepare(`SELECT COUNT(*) AS count FROM nodes ${where}`).get(params).count;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(requestedPage, totalPages);
  const rows = db.prepare(`SELECT * FROM nodes ${where}
    ORDER BY name COLLATE NOCASE, id LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset: (currentPage - 1) * size });
  return { nodes: rows.map(publicNode), page: currentPage, pageSize: size, total, totalPages, query: search };
}

export { publicNode };
