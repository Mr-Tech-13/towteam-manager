const state = { nodes: [], nodePage: 1, nodePageSize: 25, nodeTotalPages: 1, nodeTotal: 0, nodeQuery: '', auditPage: 1, auditTotalPages: 1 };
const $ = selector => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status}).`);
  return body;
}

function toast(message, error = false) {
  const target = $('#toast');
  target.textContent = message;
  target.className = `${error ? 'error-toast ' : ''}show`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { target.className = ''; }, 3500);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Never';
}

function fact(label, value) {
  const item = element('div', 'fact');
  item.append(element('span', '', label), element('strong', '', value || 'Unknown'));
  return item;
}

async function runAction(node, action) {
  const destructive = action === 'install-update' || action === 'restart';
  if (destructive && !confirm(`${action === 'restart' ? 'Restart' : 'Update'} ${node.name}? Active users may be disconnected.`)) return;
  try {
    toast(`${action.replaceAll('-', ' ')} requested for ${node.name}.`);
    const result = await api(`/nodes/${node.id}/jobs`, { method: 'POST', body: JSON.stringify({ action }) });
    const detail = result.result?.message || result.result?.filename || result.status || 'Completed';
    toast(`${node.name}: ${detail}`);
    if (['install-update', 'restart'].includes(action)) setTimeout(() => refreshOne(node.id), 5000);
    else await refreshOne(node.id);
  } catch (error) { toast(error.message, true); }
}

function renderNodes() {
  const grid = $('#node-grid');
  grid.replaceChildren();
  $('#empty').hidden = state.nodes.length > 0;
  $('#empty').textContent = state.nodeQuery ? 'No nodes match this search.' : 'No nodes enrolled yet.';
  for (const node of state.nodes) {
    const card = element('article', 'panel node-card');
    const head = element('div', 'node-head');
    const title = element('div');
    title.append(element('h3', '', node.name), element('div', 'node-url', node.baseUrl));
    head.append(title, element('span', `status ${node.status}`, node.status));
    const facts = element('div', 'facts');
    facts.append(fact('Version', node.version), fact('Release channel', node.releaseChannel), fact('Node ID', node.nodeId?.slice(0, 13)), fact('Last seen', formatTime(node.lastSeenAt)));
    const actions = element('div', 'actions');
    for (const [action, label] of [['check-update', 'Check update'], ['backup', 'Backup'], ['install-update', 'Update'], ['restart', 'Restart']]) {
      const button = element('button', action === 'install-update' ? 'primary' : '', label);
      button.addEventListener('click', () => runAction(node, action));
      actions.append(button);
    }
    const refresh = element('button', '', 'Refresh');
    refresh.addEventListener('click', () => refreshOne(node.id));
    actions.append(refresh);
    const remove = element('button', 'danger', 'Remove');
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove ${node.name} from this manager? The credential on the node should also be revoked by its Local Administrator.`)) return;
      try { await api(`/nodes/${node.id}`, { method: 'DELETE' }); await loadNodes(state.nodePage); toast(`${node.name} removed.`); }
      catch (error) { toast(error.message, true); }
    });
    actions.append(remove);
    card.append(head, facts);
    if (node.lastError) card.append(element('div', 'node-error', node.lastError));
    card.append(actions);
    grid.append(card);
  }
  $('#node-page').textContent = `${state.nodeTotal} node${state.nodeTotal === 1 ? '' : 's'} · Page ${state.nodePage} of ${state.nodeTotalPages}`;
  $('#node-prev').disabled = state.nodePage <= 1;
  $('#node-next').disabled = state.nodePage >= state.nodeTotalPages;
}

async function loadNodes(page = state.nodePage) {
  const params = new URLSearchParams({ paginated: 'true', q: state.nodeQuery, page, pageSize: state.nodePageSize });
  const result = await api(`/nodes?${params}`);
  state.nodes = result.nodes;
  state.nodePage = result.page;
  state.nodePageSize = result.pageSize;
  state.nodeTotal = result.total;
  state.nodeTotalPages = result.totalPages;
  renderNodes();
}

async function refreshOne(id) {
  try {
    const updated = await api(`/nodes/${id}/refresh`, { method: 'POST', body: '{}' });
    state.nodes = state.nodes.map(node => node.id === id ? updated : node);
    renderNodes();
  } catch (error) { toast(error.message, true); }
}

async function loadAudit() {
  const pageSize = $('#audit-size').value;
  const result = await api(`/audit?page=${state.auditPage}&pageSize=${pageSize}`);
  state.auditPage = result.page;
  state.auditTotalPages = result.totalPages;
  const body = $('#audit-body');
  body.replaceChildren();
  for (const log of result.logs) {
    const row = document.createElement('tr');
    const details = document.createElement('pre');
    details.textContent = JSON.stringify(log.details || {});
    for (const value of [formatTime(log.createdAt), log.username || 'System', log.nodeName || '-', log.action]) row.append(element('td', '', value));
    const detailsCell = document.createElement('td'); detailsCell.append(details); row.append(detailsCell); body.append(row);
  }
  $('#audit-page').textContent = `Page ${result.page} of ${result.totalPages}`;
  $('#audit-prev').disabled = result.page <= 1;
  $('#audit-next').disabled = result.page >= result.totalPages;
}

async function loadManagerUpdate() {
  const check = $('#manager-check-update');
  const install = $('#manager-install-update');
  check.disabled = true; install.disabled = true;
  try {
    const status = await api('/updates');
    $('#manager-current-version').textContent = status.currentVersion || 'Unknown';
    $('#manager-remote-version').textContent = status.remoteVersion || 'Unknown';
    $('#manager-update-status').textContent = status.message;
    $('#manager-latest-commit').textContent = status.latestCommit || '';
    install.disabled = !status.canUpdate;
  } catch (error) {
    $('#manager-update-status').textContent = error.message;
  } finally { check.disabled = false; }
}

async function installManagerUpdate() {
  if (!confirm('Update TowTeam Manager now? The manager will restart and this page will briefly disconnect.')) return;
  const button = $('#manager-install-update'); button.disabled = true;
  try {
    const result = await api('/updates/install', { method: 'POST', body: '{}' });
    $('#manager-update-status').textContent = result.updated ? 'Update installed. Waiting for the manager to restart...' : 'No update installed.';
    setTimeout(() => location.reload(), 6000);
  } catch (error) { $('#manager-update-status').textContent = error.message; }
}

let bulkPollTimer;
function showBulkProgress(job) {
  const panel = $('#bulk-progress');
  panel.hidden = false;
  const finished = ['completed', 'completed_with_errors', 'failed', 'interrupted'].includes(job.status);
  const failures = job.failures?.length ? ` Failed: ${job.failures.map(item => item.nodeName).join(', ')}.` : '';
  panel.textContent = finished
    ? `Update all finished: ${job.succeeded} succeeded, ${job.failed} failed out of ${job.total}.${failures}`
    : `Updating all nodes: ${job.completed} of ${job.total} finished (${job.succeeded} succeeded, ${job.failed} failed).`;
  $('#bulk-update').disabled = !finished;
  return finished;
}

async function pollBulkJob(jobId) {
  clearTimeout(bulkPollTimer);
  try {
    const job = await api(`/bulk-jobs/${jobId}`);
    if (showBulkProgress(job)) {
      await loadNodes(state.nodePage);
      return;
    }
    bulkPollTimer = setTimeout(() => pollBulkJob(jobId), 1500);
  } catch (error) {
    $('#bulk-progress').hidden = false;
    $('#bulk-progress').textContent = `Unable to read bulk update progress: ${error.message}`;
    $('#bulk-update').disabled = false;
  }
}

async function resumeBulkJob() {
  try {
    const active = await api('/bulk-jobs/active');
    if (active) { showBulkProgress(active); await pollBulkJob(active.id); }
  } catch (error) { toast(error.message, true); }
}

async function startBulkUpdate() {
  if (!confirm('Update every enrolled node? This ignores the current search and may temporarily disconnect active users at each station.')) return;
  const button = $('#bulk-update'); button.disabled = true;
  try {
    const job = await api('/nodes/bulk-update', { method: 'POST', body: '{}' });
    showBulkProgress(job);
    await pollBulkJob(job.id);
  } catch (error) {
    button.disabled = false;
    toast(error.message, true);
  }
}

async function start(showError = false) {
  try {
    const health = await api('/health');
    document.querySelectorAll('.version-label').forEach(label => { label.textContent = `v${health.version}`; });
    const me = await api('/me');
    $('#manager-name').textContent = me.managerName;
    $('#login').hidden = true;
    $('#app').hidden = false;
    await loadNodes();
    await resumeBulkJob();
  } catch (error) {
    $('#login').hidden = false;
    $('#app').hidden = true;
    if (showError) $('#login-error').textContent = error.message;
  }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#login-error').textContent = '';
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try { await api('/login', { method: 'POST', body: JSON.stringify(data) }); form.reset(); await start(true); }
  catch (error) { $('#login-error').textContent = error.message; }
});
$('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST', body: '{}' }); location.reload(); });
$('#show-enroll').addEventListener('click', () => $('#enroll-dialog').showModal());
$('#cancel-enroll').addEventListener('click', () => $('#enroll-dialog').close());
$('#enroll-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#enroll-error').textContent = '';
  const form = event.currentTarget;
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try {
    await api('/nodes/enroll', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset(); $('#enroll-dialog').close(); state.nodeQuery = ''; $('#node-search').value = ''; await loadNodes(1); toast('Node enrolled.');
  } catch (error) { $('#enroll-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('#refresh-all').addEventListener('click', async () => {
  const button = $('#refresh-all'); button.disabled = true;
  await Promise.all(state.nodes.map(node => refreshOne(node.id)));
  button.disabled = false;
});
$('#bulk-update').addEventListener('click', startBulkUpdate);
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', async () => {
  document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab));
  const view = tab.dataset.view;
  $('#nodes-view').hidden = view !== 'nodes';
  $('#audit-view').hidden = view !== 'audit';
  $('#manager-view').hidden = view !== 'manager';
  if (view === 'audit') await loadAudit();
  if (view === 'manager') await loadManagerUpdate();
}));
$('#audit-size').addEventListener('change', () => { state.auditPage = 1; loadAudit(); });
$('#audit-prev').addEventListener('click', () => { state.auditPage -= 1; loadAudit(); });
$('#audit-next').addEventListener('click', () => { state.auditPage += 1; loadAudit(); });
let nodeSearchTimer;
$('#node-search').addEventListener('input', event => {
  clearTimeout(nodeSearchTimer);
  state.nodeQuery = event.target.value;
  nodeSearchTimer = setTimeout(() => loadNodes(1).catch(error => toast(error.message, true)), 300);
});
$('#node-page-size').addEventListener('change', event => {
  state.nodePageSize = Number(event.target.value);
  loadNodes(1).catch(error => toast(error.message, true));
});
$('#node-prev').addEventListener('click', () => loadNodes(state.nodePage - 1).catch(error => toast(error.message, true)));
$('#node-next').addEventListener('click', () => loadNodes(state.nodePage + 1).catch(error => toast(error.message, true)));
$('#manager-check-update').addEventListener('click', loadManagerUpdate);
$('#manager-install-update').addEventListener('click', installManagerUpdate);
start();
