import { normalizeLanguage, translate } from './i18n.js';

const languageKey = 'towteam-manager-language';
const state = { nodes: [], nodePage: 1, nodePageSize: 25, nodeTotalPages: 1, nodeTotal: 0, nodeQuery: '', auditPage: 1, auditTotalPages: 1, language: normalizeLanguage(localStorage.getItem(languageKey) || navigator.language?.slice(0, 2)) };
const $ = selector => document.querySelector(selector);
const t = (key, values) => translate(state.language, key, values);

function applyLanguage() {
  document.documentElement.lang = state.language;
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-i18n-initial]:not([data-loaded="true"])').forEach(node => { node.textContent = t(node.dataset.i18nInitial); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(node => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  document.querySelectorAll('.language-selector').forEach(select => { select.value = state.language; select.setAttribute('aria-label', t('language')); });
  if (!$('#nodes-view').hidden) renderNodes();
  if (!$('#audit-view').hidden && $('#audit-body').children.length) void loadAudit();
}

function changeLanguage(language) {
  state.language = normalizeLanguage(language);
  localStorage.setItem(languageKey, state.language);
  applyLanguage();
}

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
  return value ? new Intl.DateTimeFormat(state.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : t('never');
}

function fact(label, value) {
  const item = element('div', 'fact');
  item.append(element('span', '', label), element('strong', '', value || t('unknown')));
  return item;
}

async function runAction(node, action) {
  const destructive = action === 'install-update' || action === 'restart';
  if (destructive && !confirm(t('destructiveConfirm', { action: t(action === 'restart' ? 'restart' : 'update'), name: node.name }))) return;
  try {
    const actionLabel = action === 'install-update' ? t('update') : action === 'check-update' ? t('checkUpdate') : t(action);
    toast(t('requestedFor', { action: actionLabel, name: node.name }));
    const result = await api(`/nodes/${node.id}/jobs`, { method: 'POST', body: JSON.stringify({ action }) });
    const detail = result.result?.message || result.result?.filename || result.status || t('completed');
    toast(`${node.name}: ${detail}`);
    if (['install-update', 'restart'].includes(action)) setTimeout(() => refreshOne(node.id), 5000);
    else await refreshOne(node.id);
  } catch (error) { toast(error.message, true); }
}

function renderNodes() {
  const grid = $('#node-grid');
  grid.replaceChildren();
  $('#empty').hidden = state.nodes.length > 0;
  $('#empty').textContent = state.nodeQuery ? t('noNodeMatches') : t('noNodes');
  for (const node of state.nodes) {
    const card = element('article', 'panel node-card');
    const head = element('div', 'node-head');
    const title = element('div');
    title.append(element('h3', '', node.name), element('div', 'node-url', node.baseUrl));
    const statusKey = `status${node.status?.[0]?.toUpperCase() || 'U'}${node.status?.slice(1) || 'nknown'}`;
    head.append(title, element('span', `status ${node.status}`, t(statusKey)));
    const facts = element('div', 'facts');
    facts.append(fact(t('version'), node.version), fact(t('releaseChannel'), node.releaseChannel), fact(t('nodeId'), node.nodeId?.slice(0, 13)), fact(t('lastSeen'), formatTime(node.lastSeenAt)));
    const actions = element('div', 'actions');
    for (const [action, label] of [['check-update', t('checkUpdate')], ['backup', t('backup')], ['install-update', t('update')], ['restart', t('restart')]]) {
      const button = element('button', action === 'install-update' ? 'primary' : '', label);
      button.addEventListener('click', () => runAction(node, action));
      actions.append(button);
    }
    const refresh = element('button', '', t('refresh'));
    refresh.addEventListener('click', () => refreshOne(node.id));
    actions.append(refresh);
    const remove = element('button', 'danger', t('remove'));
    remove.addEventListener('click', async () => {
      if (!confirm(t('removeConfirm', { name: node.name }))) return;
      try { await api(`/nodes/${node.id}`, { method: 'DELETE' }); await loadNodes(state.nodePage); toast(t('removed', { name: node.name })); }
      catch (error) { toast(error.message, true); }
    });
    actions.append(remove);
    card.append(head, facts);
    if (node.lastError) card.append(element('div', 'node-error', node.lastError));
    card.append(actions);
    grid.append(card);
  }
  $('#node-page').textContent = `${state.nodeTotal} ${t(state.nodeTotal === 1 ? 'nodeSingular' : 'nodePlural')} · ${t('page')} ${state.nodePage} ${t('of')} ${state.nodeTotalPages}`;
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
    for (const value of [formatTime(log.createdAt), log.username || t('system'), log.nodeName || '-', log.action]) row.append(element('td', '', value));
    const detailsCell = document.createElement('td'); detailsCell.append(details); row.append(detailsCell); body.append(row);
  }
  $('#audit-page').textContent = `${t('page')} ${result.page} ${t('of')} ${result.totalPages}`;
  $('#audit-prev').disabled = result.page <= 1;
  $('#audit-next').disabled = result.page >= result.totalPages;
}

async function loadManagerUpdate() {
  const check = $('#manager-check-update');
  const install = $('#manager-install-update');
  check.disabled = true; install.disabled = true;
  try {
    const status = await api('/updates');
    $('#manager-current-version').dataset.loaded = 'true';
    $('#manager-remote-version').dataset.loaded = 'true';
    $('#manager-update-status').dataset.loaded = 'true';
    $('#manager-current-version').textContent = status.currentVersion || t('unknown');
    $('#manager-remote-version').textContent = status.remoteVersion || t('unknown');
    $('#manager-update-status').textContent = status.message;
    $('#manager-latest-commit').textContent = status.latestCommit || '';
    install.disabled = !status.canUpdate;
  } catch (error) {
    $('#manager-update-status').dataset.loaded = 'true';
    $('#manager-update-status').textContent = error.message;
  } finally { check.disabled = false; }
}

async function installManagerUpdate() {
  if (!confirm(t('updateManagerConfirm'))) return;
  const button = $('#manager-install-update'); button.disabled = true;
  try {
    const result = await api('/updates/install', { method: 'POST', body: '{}' });
    $('#manager-update-status').textContent = result.updated ? t('updateInstalled') : t('noUpdateInstalled');
    setTimeout(() => location.reload(), 6000);
  } catch (error) { $('#manager-update-status').textContent = error.message; }
}

let bulkPollTimer;
function showBulkProgress(job) {
  const panel = $('#bulk-progress');
  panel.hidden = false;
  const finished = ['completed', 'completed_with_errors', 'failed', 'interrupted'].includes(job.status);
  const failures = job.failures?.length ? ` ${t('failedNodes', { names: job.failures.map(item => item.nodeName).join(', ') })}` : '';
  panel.textContent = finished
    ? `${t('bulkFinished', job)}${failures}`
    : t('bulkRunning', job);
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
    $('#bulk-progress').textContent = t('bulkReadError', { message: error.message });
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
  if (!confirm(t('bulkConfirm'))) return;
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
    form.reset(); $('#enroll-dialog').close(); state.nodeQuery = ''; $('#node-search').value = ''; await loadNodes(1); toast(t('nodeEnrolled'));
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
document.querySelectorAll('.language-selector').forEach(select => select.addEventListener('change', event => changeLanguage(event.target.value)));
applyLanguage();
start();
