import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import packageInfo from './package.json' with { type: 'json' };

const execFileAsync = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const currentVersion = packageInfo.version;
let updateInProgress = false;

async function runGit(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function remoteVersion(run) {
  try { return JSON.parse(await run(['show', '@{u}:package.json'])).version || null; }
  catch { return null; }
}

function keys(contents) {
  const result = new Set();
  for (const line of String(contents).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) result.add(match[1]);
  }
  return result;
}

export function mergeEnvironment({ directory = root, timestamp = new Date() } = {}) {
  const environmentPath = path.join(directory, '.env');
  const templatePath = path.join(directory, '.env.example');
  if (!fs.existsSync(environmentPath) || !fs.existsSync(templatePath)) return { changed: false, added: [] };
  const existing = fs.readFileSync(environmentPath, 'utf8');
  const existingKeys = keys(existing);
  const added = [];
  const lines = [];
  for (const line of fs.readFileSync(templatePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || existingKeys.has(match[1])) continue;
    existingKeys.add(match[1]); added.push(match[1]); lines.push(line);
  }
  if (!added.length) return { changed: false, added: [] };
  const slug = timestamp.toISOString().replace(/[:.]/g, '-');
  const backup = `${environmentPath}.pre-update-${slug}`;
  const temporary = `${environmentPath}.tmp-${process.pid}`;
  fs.copyFileSync(environmentPath, backup, fs.constants.COPYFILE_EXCL);
  try {
    const separator = existing.endsWith('\n') || !existing ? '' : '\n';
    fs.writeFileSync(temporary, `${existing}${separator}\n# Added automatically during manager update ${timestamp.toISOString()}\n${lines.join('\n')}\n`, { mode: fs.statSync(environmentPath).mode });
    fs.renameSync(temporary, environmentPath);
  } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  return { changed: true, added, backup: path.basename(backup) };
}

export async function checkManagerUpdates({ run = runGit, enabled = process.env.MANAGER_UPDATE_ENABLED === 'true', repository = fs.existsSync(path.join(root, '.git')), fetch = true } = {}) {
  if (!enabled) return { enabled: false, canUpdate: false, updateAvailable: false, currentVersion, message: 'Manager updates are disabled. Set MANAGER_UPDATE_ENABLED=true in a supervised deployment.' };
  if (!repository) return { enabled: true, canUpdate: false, updateAvailable: false, currentVersion, message: 'The manager must be deployed as its own Git checkout to update itself.' };
  if (fetch) await run(['fetch', '--prune']);
  const [branch, upstream, currentCommit, upstreamCommit, counts, changes, latestCommit, nextVersion] = await Promise.all([
    run(['branch', '--show-current']), run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    run(['rev-parse', 'HEAD']), run(['rev-parse', '@{u}']), run(['rev-list', '--left-right', '--count', 'HEAD...@{u}']),
    run(['status', '--porcelain', '--untracked-files=no']), run(['log', '-1', '--format=%h %s', '@{u}']), remoteVersion(run)
  ]);
  const [ahead = 0, behind = 0] = counts.split(/\s+/).map(Number);
  const dirty = Boolean(changes);
  const updateAvailable = behind > 0;
  return {
    enabled: true, currentVersion, remoteVersion: nextVersion, branch, upstream, currentCommit, upstreamCommit,
    ahead, behind, dirty, latestCommit, updateAvailable,
    canUpdate: updateAvailable && ahead === 0 && !dirty && !updateInProgress,
    updateInProgress,
    message: dirty ? 'Tracked local changes must be committed or reverted before updating.'
      : ahead > 0 ? 'This checkout has local commits and cannot update automatically.'
        : updateAvailable ? `${behind} update commit${behind === 1 ? ' is' : 's are'} available.` : 'TowTeam Manager is up to date.'
  };
}

export async function installManagerUpdate({ run = runGit, enabled, repository, merge = mergeEnvironment } = {}) {
  if (updateInProgress) throw new Error('A manager update is already in progress.');
  const status = await checkManagerUpdates({ run, enabled, repository });
  if (!status.enabled || !status.canUpdate) throw new Error(status.message);
  updateInProgress = true;
  try {
    await run(['pull', '--ff-only']);
    let environment;
    try { environment = merge(); }
    catch (error) { environment = { changed: false, added: [], error: error.message }; }
    return {
      updated: true, restartRequired: true, previousCommit: status.currentCommit,
      currentCommit: await run(['rev-parse', 'HEAD']), remoteVersion: status.remoteVersion, environment
    };
  } finally { updateInProgress = false; }
}

export function restartManager() {
  const timer = setTimeout(() => process.exit(0), 500);
  timer.unref();
}
