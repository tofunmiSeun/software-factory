#!/usr/bin/env node
// Software Factory state CLI.
// All factory state lives in files under projects/<project>/ (gitignored).
// Claude Code (the orchestrator) calls this script for every state change so
// transitions, worktrees and PR handling stay deterministic.
//
// Usage: node scripts/factory.mjs <command> [args] [--flags]
// Run with no command to see the full list.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.FACTORY_HOME ? path.resolve(process.env.FACTORY_HOME) : ROOT;
const PROJECTS = path.join(HOME, 'projects');
const PR_MARKER = '<!-- software-factory -->';

export const FEATURE_STATUSES = [
  'spec_drafting',
  'awaiting_spec_approval',
  'planning',
  'awaiting_plan_approval',
  'building',
  'awaiting_merge',
  'needs_human',
  'done',
  'cancelled',
];
export const STAGE_STATUSES = ['pending', 'building', 'reviewing', 'pr_open', 'needs_human', 'merged', 'closed'];

// ---------- small helpers ----------

class FactoryError extends Error {}
const die = (msg) => {
  throw new FactoryError(msg);
};
const now = () => new Date().toISOString();
const out = (value) => process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    die(`${cmd} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}
function tryRun(cmd, args, opts = {}) {
  try {
    return run(cmd, args, opts);
  } catch {
    return null;
  }
}
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]);
const tryGit = (cwd, ...args) => tryRun('git', ['-C', cwd, ...args]);

export function slugify(text, max = 40) {
  return (
    String(text)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, max)
      .replace(/-$/, '') || 'item'
  );
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function setDotted(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
}
function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
const SAFE_NAME = /^[A-Za-z0-9][\w.-]*$/;
function checkName(kind, name) {
  if (!name || !SAFE_NAME.test(name)) die(`invalid ${kind} name: ${name ?? '(missing)'}`);
  return name;
}

// ---------- remotes ----------

export function parseRemote(url) {
  let host = null;
  let repoPath = null;
  if (/^[a-z][\w+.-]*:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      host = u.hostname || null;
      repoPath = u.pathname.replace(/^\/+/, '');
    } catch {
      /* fall through */
    }
  } else {
    const m = url.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (m) {
      host = m[1];
      repoPath = m[2];
    }
  }
  if (!host || !repoPath) return { host: null, slug: null };
  return { host, slug: repoPath.replace(/\.git$/, '').replace(/\/+$/, '') };
}

function detectBaseBranch(repo, remote) {
  const sym = tryGit(repo, 'symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`);
  if (sym) return sym.replace(new RegExp(`^${remote}/`), '');
  const ls = tryGit(repo, 'ls-remote', '--symref', remote, 'HEAD');
  const m = ls && ls.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
  if (m) return m[1];
  for (const b of ['main', 'master', 'trunk', 'develop']) {
    if (tryGit(repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${b}`)) return b;
  }
  return tryGit(repo, 'rev-parse', '--abbrev-ref', 'HEAD') || 'main';
}

// ---------- paths & loaders ----------

const projectDir = (p) => path.join(PROJECTS, checkName('project', p));
const featureDir = (p, f) => path.join(projectDir(p), 'features', checkName('feature', f));
const configFile = (p) => path.join(projectDir(p), 'config.json');
const stateFile = (p, f) => path.join(featureDir(p, f), 'state.json');

function loadConfig(p) {
  const file = configFile(p);
  if (!fs.existsSync(file)) die(`unknown project "${p}". Run /factory-init first. Known: ${listProjects().join(', ') || 'none'}`);
  return readJSON(file);
}
function loadState(p, f) {
  const file = stateFile(p, f);
  if (!fs.existsSync(file)) die(`unknown feature "${f}" in project "${p}"`);
  return readJSON(file);
}
function saveState(p, f, state) {
  state.updatedAt = now();
  writeJSON(stateFile(p, f), state);
}
function listProjects() {
  if (!fs.existsSync(PROJECTS)) return [];
  return fs
    .readdirSync(PROJECTS)
    .filter((d) => fs.existsSync(path.join(PROJECTS, d, 'config.json')))
    .sort();
}
function listFeatures(p) {
  const dir = path.join(projectDir(p), 'features');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'state.json')))
    .sort();
}
function getStage(state, n) {
  const stage = state.stages.find((s) => s.n === Number(n));
  if (!stage) die(`stage ${n} not found (feature has ${state.stages.length} stages)`);
  return stage;
}

function logEvent(p, f, type, message, data) {
  const line = { at: now(), project: p, feature: f || null, type, message };
  if (data !== undefined) line.data = data;
  fs.mkdirSync(projectDir(p), { recursive: true });
  fs.appendFileSync(path.join(projectDir(p), 'events.jsonl'), JSON.stringify(line) + '\n');
}

// Factory-wide defaults for new projects (e.g. the commit identity), kept in projects/defaults.json
// so personal details stay out of the repo. Each top-level object is merged over the built-in default.
function withDefaults(config) {
  const file = path.join(PROJECTS, 'defaults.json');
  if (!fs.existsSync(file)) return config;
  for (const [k, v] of Object.entries(readJSON(file))) {
    config[k] = v && typeof v === 'object' && !Array.isArray(v) && config[k] && typeof config[k] === 'object' ? { ...config[k], ...v } : v;
  }
  return config;
}

function defaultConfig({ name, repoPath, remote, remoteUrl, host, slug, baseBranch }) {
  return withDefaults({
    name,
    createdAt: now(),
    repo: { path: repoPath, remote, remoteUrl, host, slug, baseBranch },
    issues: { source: 'manual' },
    commands: { install: null, build: null, test: null, lint: null, typecheck: null, run: null },
    conventions: { docs: [], branchPrefix: 'factory/', commitStyle: null, prTemplate: null },
    review: {
      lenses: ['ux', 'security', 'readability', 'simplicity'],
      maxRounds: 3,
      passCriteria: 'No blocking findings in any lens; configured test and lint commands pass.',
    },
    planning: { prSize: 'small: one reviewable concern per PR', nextStageTrigger: 'merge' },
    gates: { spec: true, plan: true },
    prFeedback: { mode: 'builder-reads-pr' },
    prWatch: { enabled: false, intervalMinutes: 15, taskId: null },
    // Name/email on the factory's commits, and the signature on its PR comments. gh still acts as your login.
    identity: { name: null, email: null, signature: '🤖 Software Factory' },
    offLimits: [],
    notes: '',
    setupComplete: false,
  });
}

// ---------- commands ----------

const commands = {};

commands['project:create'] = ({ positional: [repoArg], flags }) => {
  if (!repoArg) die('usage: project:create <repo-path> [--name <slug>] [--remote <name>] [--force]');
  const input = path.resolve(repoArg.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  if (!fs.existsSync(input)) die(`path does not exist: ${input}`);
  const repoPath = tryGit(input, 'rev-parse', '--show-toplevel');
  if (!repoPath) die(`not a git repository: ${input}`);

  const remotes = (tryGit(repoPath, 'remote') || '').split('\n').filter(Boolean);
  if (!remotes.length) die(`${repoPath} has no git remote; the factory needs one to open pull requests`);
  const remote = flags.remote || (remotes.includes('origin') ? 'origin' : remotes[0]);
  if (!remotes.includes(remote)) die(`remote "${remote}" not found (have: ${remotes.join(', ')})`);
  // Raw configured URL (not insteadOf-expanded) so owner/repo reflects what the user set up.
  const remoteUrl = git(repoPath, 'config', '--get', `remote.${remote}.url`);
  const { host, slug } = parseRemote(remoteUrl);

  const name = checkName('project', flags.name || slugify(path.basename(repoPath)));
  const dir = projectDir(name);
  if (fs.existsSync(configFile(name)) && !flags.force) die(`project "${name}" already exists (use --force to re-detect)`);

  const fetched = tryGit(repoPath, 'fetch', '--quiet', remote) !== null;
  const baseBranch = flags.base || detectBaseBranch(repoPath, remote);

  const config = fs.existsSync(configFile(name))
    ? { ...readJSON(configFile(name)) }
    : defaultConfig({ name, repoPath, remote, remoteUrl, host, slug, baseBranch });
  config.repo = { path: repoPath, remote, remoteUrl, host, slug, baseBranch };

  fs.mkdirSync(path.join(dir, 'features'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'worktrees'), { recursive: true });
  writeJSON(configFile(name), config);
  const checkout = ensureCheckout(name, config);
  logEvent(name, null, 'project.created', `Project created for ${repoPath}`);
  out({ project: name, config, checkout, fetched });
};

// A read-only, detached checkout of <remote>/<base> that agents read for context.
// It lives inside the factory folder so Claude Code can read it without extra permissions,
// and it never touches the user's own working copy.
function ensureCheckout(p, config) {
  const checkout = path.join(projectDir(p), 'checkout');
  const { path: repo, remote, baseBranch } = config.repo;
  const ref = tryGit(repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${baseBranch}`)
    ? `${remote}/${baseBranch}`
    : baseBranch;
  if (!fs.existsSync(path.join(checkout, '.git'))) {
    tryGit(repo, 'worktree', 'prune');
    git(repo, 'worktree', 'add', '--detach', checkout, ref);
  } else {
    git(checkout, 'checkout', '--quiet', '--force', '--detach', ref);
  }
  return { path: checkout, ref, sha: git(checkout, 'rev-parse', 'HEAD') };
}

commands['project:refresh'] = ({ positional: [p] }) => {
  const config = loadConfig(p);
  tryGit(config.repo.path, 'fetch', '--quiet', config.repo.remote);
  out(ensureCheckout(p, config));
};

commands['project:list'] = () => out(listProjects());

commands['project:get'] = ({ positional: [p] }) => out(loadConfig(p));

commands['config:set'] = ({ positional: [p, key, ...rest] }) => {
  if (!key || !rest.length) die('usage: config:set <project> <dotted.key> <json-or-string value>');
  const config = loadConfig(p);
  if (key.startsWith('repo.') && !['repo.baseBranch', 'repo.remote'].includes(key)) die('repo.* is detected; re-run project:create --force instead');
  setDotted(config, key, parseValue(rest.join(' ')));
  writeJSON(configFile(p), config);
  out(config);
};

commands['feature:create'] = ({ positional: [p], flags }) => {
  const config = loadConfig(p);
  if (!flags.title) die('usage: feature:create <project> --title "<title>" (--issue "<text>" | --issue-file <path>)');
  let issue = typeof flags.issue === 'string' ? flags.issue : '';
  if (flags['issue-file']) issue = fs.readFileSync(path.resolve(flags['issue-file']), 'utf8');
  if (!issue.trim()) die('issue text is empty');

  const existing = listFeatures(p);
  const next = existing.reduce((max, id) => Math.max(max, parseInt(id, 10) || 0), 0) + 1;
  const id = `${String(next).padStart(3, '0')}-${slugify(flags.title, 40)}`;
  const dir = featureDir(p, id);
  fs.mkdirSync(path.join(dir, 'stages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'issue.md'), `# ${flags.title}\n\nSource: ${config.issues.source}\n\n${issue.trim()}\n`);
  const state = {
    id,
    project: p,
    title: flags.title,
    source: config.issues.source,
    status: 'spec_drafting',
    createdAt: now(),
    updatedAt: now(),
    currentStage: null,
    feedback: [],
    history: [{ at: now(), status: 'spec_drafting' }],
    stages: [],
  };
  saveState(p, id, state);
  logEvent(p, id, 'feature.created', flags.title);
  out({ id, dir, state });
};

commands['feature:list'] = ({ positional: [p] }) => {
  loadConfig(p);
  out(listFeatures(p).map((f) => {
    const s = loadState(p, f);
    return { id: f, title: s.title, status: s.status, currentStage: s.currentStage, stages: s.stages.length };
  }));
};

commands['feature:get'] = ({ positional: [p, f] }) => out(loadState(p, f));

commands['feature:status'] = ({ positional: [p, f, status], flags }) => {
  if (!FEATURE_STATUSES.includes(status)) die(`status must be one of: ${FEATURE_STATUSES.join(', ')}`);
  const state = loadState(p, f);
  const from = state.status;
  state.status = status;
  const entry = { at: now(), status };
  if (typeof flags.note === 'string') entry.note = flags.note;
  state.history.push(entry);
  saveState(p, f, state);
  logEvent(p, f, 'feature.status', `${from} → ${status}${entry.note ? `: ${entry.note}` : ''}`);
  out(state);
};

commands['feature:feedback'] = ({ positional: [p, f], flags }) => {
  const gate = flags.gate;
  if (!['spec', 'plan', 'stage', 'pr'].includes(gate)) die('--gate must be spec, plan, stage or pr');
  if (typeof flags.text !== 'string' || !flags.text.trim()) die('--text is required');
  const state = loadState(p, f);
  state.feedback.push({ at: now(), gate, text: flags.text.trim() });
  saveState(p, f, state);
  logEvent(p, f, 'feedback', `${gate}: ${flags.text.trim().slice(0, 140)}`);
  out(state.feedback);
};

commands['stages:load'] = ({ positional: [p, f] }) => {
  const state = loadState(p, f);
  const file = path.join(featureDir(p, f), 'stages.json');
  if (!fs.existsSync(file)) die(`missing ${file}; the work-planner must write it`);
  const raw = readJSON(file);
  const list = Array.isArray(raw) ? raw : raw.stages;
  if (!Array.isArray(list) || !list.length) die('stages.json must be a non-empty array of {title, summary}');
  if (state.stages.some((s) => s.status !== 'pending')) die('cannot reload stages: work has already started');
  state.stages = list.map((s, i) => {
    if (!s.title) die(`stage ${i + 1} is missing a title`);
    return {
      n: i + 1,
      title: s.title,
      summary: s.summary || '',
      status: 'pending',
      rounds: 0,
      prRounds: 0,
      branch: null,
      worktree: null,
      pr: null,
      lastFeedbackAt: null,
    };
  });
  state.currentStage = null;
  saveState(p, f, state);
  logEvent(p, f, 'plan.loaded', `${state.stages.length} stage(s)`);
  out(state.stages);
};

commands['stage:update'] = ({ positional: [p, f, n], flags }) => {
  if (typeof flags.json !== 'string') die("usage: stage:update <project> <feature> <n> --json '{...}'");
  const patch = JSON.parse(flags.json);
  if (patch.status && !STAGE_STATUSES.includes(patch.status)) die(`stage status must be one of: ${STAGE_STATUSES.join(', ')}`);
  const state = loadState(p, f);
  const stage = getStage(state, n);
  Object.assign(stage, patch);
  saveState(p, f, state);
  if (patch.status) logEvent(p, f, 'stage.status', `stage ${n} → ${patch.status}`);
  out(stage);
};

// Create (or resume) the worktree + branch for a stage, branched from the latest <remote>/<base>.
commands['stage:start'] = ({ positional: [p, f, nArg] }) => {
  const config = loadConfig(p);
  const state = loadState(p, f);
  if (!state.stages.length) die('no stages yet; load the plan first');
  const stage = nArg
    ? getStage(state, nArg)
    : state.stages.find((s) => ['building', 'reviewing'].includes(s.status)) || state.stages.find((s) => s.status === 'pending');
  if (!stage) die('no pending stage left');
  const earlierOpen = state.stages.find((s) => s.n < stage.n && !['merged', 'closed'].includes(s.status));
  if (earlierOpen && config.planning.nextStageTrigger === 'merge')
    die(`stage ${earlierOpen.n} is not merged yet (status ${earlierOpen.status}); next stage starts after merge`);

  const { path: repo, remote, baseBranch } = config.repo;
  const wt = path.join(projectDir(p), 'worktrees', `${f}-s${stage.n}`);
  const branch = stage.branch || `${config.conventions.branchPrefix || ''}${f}/s${stage.n}-${slugify(stage.title, 30)}`;
  let resumed = false;
  if (fs.existsSync(path.join(wt, '.git'))) {
    resumed = true;
  } else {
    tryGit(repo, 'fetch', '--quiet', remote, baseBranch);
    tryGit(repo, 'worktree', 'prune');
    const base = tryGit(repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${baseBranch}`)
      ? `${remote}/${baseBranch}`
      : baseBranch;
    if (tryGit(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) git(repo, 'worktree', 'add', wt, branch);
    else git(repo, 'worktree', 'add', '--no-track', '-b', branch, wt, base);
    stage.baseSha = git(wt, 'rev-parse', 'HEAD');
  }
  Object.assign(stage, { branch, worktree: wt, status: stage.status === 'pending' ? 'building' : stage.status });
  stage.startedAt ||= now();
  state.currentStage = stage.n;
  // Re-opening the worktree of a stage whose PR is already open (to address PR feedback)
  // keeps the feature in awaiting_merge.
  if (stage.status !== 'pr_open' && state.status !== 'building') {
    state.status = 'building';
    state.history.push({ at: now(), status: 'building', note: `stage ${stage.n}` });
  }
  saveState(p, f, state);
  logEvent(p, f, 'stage.started', `stage ${stage.n}: ${stage.title}${resumed ? ' (resumed)' : ''}`);
  out({ stage, worktree: wt, branch, resumed });
};

// Count a build round. kind=review counts build↔review loops, kind=pr counts PR-feedback fix rounds.
commands['stage:round'] = ({ positional: [p, f, n], flags }) => {
  const config = loadConfig(p);
  const state = loadState(p, f);
  const stage = getStage(state, n);
  const field = flags.kind === 'pr' ? 'prRounds' : 'rounds';
  const max = Number(config.review.maxRounds) || 3;
  if ((stage[field] || 0) >= max) {
    out({ allowed: false, round: stage[field], max, kind: field });
    return;
  }
  stage[field] = (stage[field] || 0) + 1;
  saveState(p, f, state);
  logEvent(p, f, 'stage.round', `stage ${n} ${field === 'rounds' ? 'build/review' : 'PR feedback'} round ${stage[field]}/${max}`);
  out({ allowed: true, round: stage[field], max, kind: field });
};

function requireGitHub(config) {
  if (config.repo.host !== 'github.com' && !process.env.FACTORY_ALLOW_ANY_HOST)
    die(`PR automation currently supports GitHub only (remote host: ${config.repo.host ?? 'unknown'})`);
  if (!config.repo.slug) die('could not work out owner/repo from the remote URL');
}

// The factory's commit identity, if configured. Env vars win over git config and over any GIT_AUTHOR_* already set.
function identityEnv(config) {
  const { name, email } = config.identity || {};
  if (!name || !email) return null;
  return { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

// Re-author the stage's commits that are not on the remote yet, so the builder's commits carry the factory identity.
// Pushed commits are never rewritten (that would need a force-push).
function applyIdentity(config, stage) {
  const env = identityEnv(config);
  if (!env) return 0;
  const { remote } = config.repo;
  tryGit(stage.worktree, 'fetch', '--quiet', remote, `+refs/heads/${stage.branch}:refs/remotes/${remote}/${stage.branch}`);
  const pushed = tryGit(stage.worktree, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${stage.branch}`);
  const upstream = pushed ? `${remote}/${stage.branch}` : stage.baseSha;
  if (!upstream) return 0;
  const authors = (tryGit(stage.worktree, 'log', '--format=%an%x00%ae%x00%cn%x00%ce', `${upstream}..HEAD`) || '').split('\n').filter(Boolean);
  const want = `${env.GIT_AUTHOR_NAME}\0${env.GIT_AUTHOR_EMAIL}`;
  if (authors.every((a) => a === `${want}\0${want}`)) return 0;
  if (tryGit(stage.worktree, 'status', '--porcelain')) die('worktree has uncommitted changes; commit them before opening the PR');
  try {
    run('git', ['-C', stage.worktree, 'rebase', '--quiet', '--no-autosquash', '--exec', 'git commit --quiet --amend --no-edit --no-verify --reset-author', upstream], { env });
  } catch (err) {
    tryGit(stage.worktree, 'rebase', '--abort');
    throw err;
  }
  return authors.length;
}

// Push the stage branch and open (or reuse) its pull request.
commands['stage:pr'] = ({ positional: [p, f, n], flags }) => {
  const config = loadConfig(p);
  requireGitHub(config);
  const state = loadState(p, f);
  const stage = getStage(state, n);
  if (!stage.worktree || !fs.existsSync(stage.worktree)) die('stage has no worktree');
  if (typeof flags.title !== 'string' || typeof flags['body-file'] !== 'string') die('usage: stage:pr <project> <feature> <n> --title "<title>" --body-file <path>');
  const ahead = git(stage.worktree, 'rev-list', '--count', `${stage.baseSha || `${config.repo.remote}/${config.repo.baseBranch}`}..HEAD`);
  if (Number(ahead) === 0) die('branch has no commits to open a PR with');

  const reauthored = applyIdentity(config, stage);
  git(stage.worktree, 'push', '--quiet', '-u', config.repo.remote, `HEAD:refs/heads/${stage.branch}`);
  const repoArgs = ['--repo', config.repo.slug];
  let pr = JSON.parse(tryRun('gh', ['pr', 'view', stage.branch, ...repoArgs, '--json', 'number,url,state']) || 'null');
  if (!pr || pr.state !== 'OPEN') {
    const body = fs.readFileSync(path.resolve(flags['body-file']), 'utf8');
    const bodyFile = path.join(featureDir(p, f), 'stages', String(n), 'pr-body.md');
    fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
    const sig = config.identity?.signature ? `\n\n---\n_${config.identity.signature}_` : '';
    fs.writeFileSync(bodyFile, `${body.trim()}${sig}\n\n${PR_MARKER}\n`);
    run('gh', ['pr', 'create', ...repoArgs, '--base', config.repo.baseBranch, '--head', stage.branch, '--title', flags.title, '--body-file', bodyFile], { cwd: stage.worktree });
    pr = JSON.parse(run('gh', ['pr', 'view', stage.branch, ...repoArgs, '--json', 'number,url,state']));
  }
  stage.pr = { number: pr.number, url: pr.url, openedAt: stage.pr?.openedAt || now() };
  stage.status = 'pr_open';
  stage.lastFeedbackAt ||= now();
  state.status = 'awaiting_merge';
  state.history.push({ at: now(), status: 'awaiting_merge', note: `stage ${n} PR #${pr.number}` });
  saveState(p, f, state);
  logEvent(p, f, 'stage.pr', `stage ${n} PR #${pr.number} ${pr.url}`);
  out({ ...stage, reauthored });
};

// Post a factory comment on a stage's PR: signature on top, marker at the end so the factory ignores it later.
commands['stage:comment'] = ({ positional: [p, f, n], flags }) => {
  const config = loadConfig(p);
  requireGitHub(config);
  const stage = getStage(loadState(p, f), n);
  if (!stage.pr) die(`stage ${stage.n} has no PR`);
  if (typeof flags['body-file'] !== 'string') die('usage: stage:comment <project> <feature> <n> --body-file <path>');
  const body = fs.readFileSync(path.resolve(flags['body-file']), 'utf8').replaceAll(PR_MARKER, '').trim();
  if (!body) die('comment body is empty');
  const sig = config.identity?.signature ? `**${config.identity.signature}**\n\n` : '';
  const file = path.join(featureDir(p, f), 'stages', String(stage.n), `comment-${Date.now()}.md`);
  fs.writeFileSync(file, `${sig}${body}\n\n${PR_MARKER}\n`);
  run('gh', ['pr', 'comment', String(stage.pr.number), '--repo', config.repo.slug, '--body-file', file]);
  logEvent(p, f, 'stage.comment', `stage ${stage.n} PR #${stage.pr.number}: comment posted`);
  out({ posted: true, pr: stage.pr.number, file });
};

// Capture screenshots of a stage's UI and publish them to the factory-screenshots branch.
// Reads stages/<n>/screenshots.json (written by the builder):
//   { "serve": "npm run dev -- --port 5199 --strictPort", "cwd": "business-ui", "port": 5199,
//     "shots": [{ "name": "landing", "path": "/" }] }
// Prints markdown for the PR body. Each shot is taken at desktop and mobile width with headless Chrome.
const SCREENSHOT_BRANCH = 'factory-screenshots';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
commands['stage:screenshots'] = ({ positional: [p, f, n] }) => {
  const config = loadConfig(p);
  requireGitHub(config);
  const state = loadState(p, f);
  const stage = getStage(state, n);
  if (!stage.worktree || !fs.existsSync(stage.worktree)) die('stage has no worktree');
  const specFile = path.join(featureDir(p, f), 'stages', String(n), 'screenshots.json');
  if (!fs.existsSync(specFile)) die(`no ${specFile}; the builder writes this when a stage changes the frontend`);
  if (!fs.existsSync(CHROME)) die(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
  const spec = readJSON(specFile);
  const port = Number(spec.port);
  if (!spec.serve || !port || !Array.isArray(spec.shots) || !spec.shots.length) die('screenshots.json needs serve, port and shots[]');
  const cwd = path.resolve(stage.worktree, spec.cwd || '.');
  if (!cwd.startsWith(path.resolve(stage.worktree))) die('screenshots.json cwd must stay inside the worktree');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-shots-'));
  const server = spawn('sh', ['-c', spec.serve], { cwd, detached: true, stdio: 'ignore' });
  const files = [];
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = tryRun('curl', ['-s', '-o', '/dev/null', '--max-time', '2', `http://localhost:${port}/`]) !== null;
      if (!up) execFileSync('sleep', ['1']);
    }
    if (!up) die(`dev server did not come up on port ${port} within 60s`);
    for (const shot of spec.shots) {
      const target = `http://localhost:${port}${shot.path || '/'}`;
      const chrome = (size, file, url) =>
        run(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=5000', `--window-size=${size}`, `--screenshot=${file}`, url]);
      const desktop = `${slugify(shot.name)}-desktop.png`;
      chrome('1280,800', path.join(tmp, desktop), target);
      files.push({ name: desktop, shot: shot.name, label: 'desktop' });
      // Headless Chrome has a minimum window width, so a 390px window renders a wider layout.
      // Render the page in a real 390px-wide iframe instead, then centre-crop to it (sips ignores --cropOffset, so the 800px window puts the iframe at x=205).
      const mobile = `${slugify(shot.name)}-mobile.png`;
      const wrapper = path.join(tmp, 'mobile.html');
      fs.writeFileSync(wrapper, `<!doctype html><body style="margin:0;background:#fff"><iframe src="${target}" style="border:0;width:390px;height:844px;display:block;margin-left:205px"></iframe>`);
      chrome('800,844', path.join(tmp, mobile), `file://${wrapper}`);
      run('sips', ['-c', '844', '390', path.join(tmp, mobile)]);
      files.push({ name: mobile, shot: shot.name, label: 'mobile' });
    }
  } finally {
    try { process.kill(-server.pid); } catch {}
  }

  // Publish to an orphan branch (never force-pushed; history is only appended to).
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet');
  git(repo, 'remote', 'add', 'origin', config.repo.remoteUrl);
  if (tryGit(repo, 'fetch', '--quiet', '--depth', '1', 'origin', SCREENSHOT_BRANCH) !== null) git(repo, 'checkout', '--quiet', '-B', SCREENSHOT_BRANCH, 'FETCH_HEAD');
  else git(repo, 'checkout', '--quiet', '--orphan', SCREENSHOT_BRANCH);
  const dir = `${f}/s${n}/${Date.now()}`;
  fs.mkdirSync(path.join(repo, dir), { recursive: true });
  for (const x of files) fs.copyFileSync(path.join(tmp, x.name), path.join(repo, dir, x.name));
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=software-factory', '-c', 'user.email=software-factory@users.noreply.github.com', 'commit', '--quiet', '-m', `screenshots for ${f} stage ${n}`);
  git(repo, 'push', '--quiet', 'origin', `HEAD:refs/heads/${SCREENSHOT_BRANCH}`);

  const url = (x) => `https://github.com/${config.repo.slug}/blob/${SCREENSHOT_BRANCH}/${dir}/${x.name}?raw=true`;
  const md = ['## Screenshots', ''];
  for (const shot of spec.shots) {
    md.push(`**${shot.name}** (\`${shot.path || '/'}\`)`, '');
    md.push('| Desktop | Mobile |', '|---|---|');
    const [d, m] = ['desktop', 'mobile'].map((l) => files.find((x) => x.shot === shot.name && x.label === l));
    md.push(`| <img src="${url(d)}" width="520"> | <img src="${url(m)}" width="180"> |`, '');
  }
  const mdFile = path.join(featureDir(p, f), 'stages', String(n), 'screenshots.md');
  fs.writeFileSync(mdFile, md.join('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
  logEvent(p, f, 'stage.screenshots', `stage ${n}: ${files.length} screenshots`);
  out({ markdownFile: mdFile, count: files.length });
};

// Read a stage's PR and the human feedback on it newer than lastFeedbackAt (the factory's own comments excluded).
// Read-only: shared by stage:sync (which acts on it) and watch:check (which only reports it).
function prActivity(config, stage) {
  const pr = JSON.parse(
    run('gh', ['pr', 'view', String(stage.pr.number), '--repo', config.repo.slug, '--json', 'state,mergedAt,reviewDecision,reviews,comments,url'])
  );
  const feedback = [];
  if (pr.state !== 'OPEN') return { pr, feedback };
  const since = stage.lastFeedbackAt ? Date.parse(stage.lastFeedbackAt) : 0;
  const notOurs = (body) => !String(body || '').includes(PR_MARKER);
  for (const r of pr.reviews || []) {
    const at = r.submittedAt;
    if (Date.parse(at) > since && notOurs(r.body) && (r.body?.trim() || r.state === 'CHANGES_REQUESTED'))
      feedback.push({ kind: 'review', state: r.state, author: r.author?.login, at, body: r.body });
  }
  for (const c of pr.comments || []) {
    if (Date.parse(c.createdAt) > since && notOurs(c.body)) feedback.push({ kind: 'comment', author: c.author?.login, at: c.createdAt, body: c.body });
  }
  const inline = JSON.parse(tryRun('gh', ['api', `repos/${config.repo.slug}/pulls/${stage.pr.number}/comments`, '--paginate']) || '[]');
  for (const c of inline) {
    if (Date.parse(c.created_at) > since && notOurs(c.body))
      feedback.push({ kind: 'inline', author: c.user?.login, at: c.created_at, path: c.path, line: c.line ?? c.original_line, body: c.body });
  }
  feedback.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { pr, feedback };
}

// Check a stage's PR. Merged → clean up and move to the next stage (or finish).
// Open → report review feedback newer than lastFeedbackAt, excluding the factory's own comments.
commands['stage:sync'] = ({ positional: [p, f, nArg] }) => {
  const config = loadConfig(p);
  requireGitHub(config);
  const state = loadState(p, f);
  const stage = getStage(state, nArg ?? state.currentStage);
  if (!stage.pr) die(`stage ${stage.n} has no PR`);
  const { pr, feedback } = prActivity(config, stage);

  if (pr.state === 'MERGED') {
    stage.status = 'merged';
    stage.mergedAt = pr.mergedAt;
    let cleanup = 'removed';
    if (stage.worktree && fs.existsSync(stage.worktree)) {
      if (tryGit(config.repo.path, 'worktree', 'remove', stage.worktree) === null) cleanup = `left in place (uncommitted changes?) at ${stage.worktree}`;
    }
    const next = state.stages.find((s) => s.status === 'pending');
    if (next) {
      state.status = 'building';
      state.currentStage = next.n;
      state.history.push({ at: now(), status: 'building', note: `stage ${stage.n} merged; next stage ${next.n}` });
    } else {
      state.status = 'done';
      state.history.push({ at: now(), status: 'done', note: 'all stages merged' });
    }
    saveState(p, f, state);
    tryGit(config.repo.path, 'fetch', '--quiet', config.repo.remote);
    try {
      ensureCheckout(p, config);
    } catch {
      /* non-fatal */
    }
    logEvent(p, f, 'stage.merged', `stage ${stage.n} merged${next ? `; next: stage ${next.n}` : '; feature done'}`);
    out({ result: 'merged', stage: stage.n, worktree: cleanup, nextStage: next ? next.n : null, featureStatus: state.status });
    return;
  }

  if (pr.state === 'CLOSED') {
    stage.status = 'closed';
    state.status = 'needs_human';
    state.history.push({ at: now(), status: 'needs_human', note: `stage ${stage.n} PR closed without merge` });
    saveState(p, f, state);
    logEvent(p, f, 'stage.closed', `stage ${stage.n} PR closed without merge`);
    out({ result: 'closed', stage: stage.n, featureStatus: state.status });
    return;
  }

  out({
    result: 'open',
    stage: stage.n,
    url: pr.url,
    reviewDecision: pr.reviewDecision || null,
    newFeedback: feedback,
    latestFeedbackAt: feedback.length ? feedback.at(-1).at : stage.lastFeedbackAt,
    marker: PR_MARKER,
  });
};

// Cheap pre-check for the scheduled PR watcher: is there anything for /factory-next to do?
// Never changes state, so it is safe to run every few minutes. Human gates don't count as work.
commands['watch:check'] = ({ positional: [only] }) => {
  const items = [];
  for (const p of only ? [only] : listProjects()) {
    const config = loadConfig(p);
    for (const f of listFeatures(p)) {
      const state = loadState(p, f);
      const next = nextAction(config, state);
      if (next.kind === 'agent') items.push({ project: p, feature: f, reason: next.action, detail: next.detail });
      if (next.kind !== 'github') continue;
      const stage = state.stages.find((s) => s.n === state.currentStage);
      if (!stage?.pr) continue;
      let activity;
      try {
        requireGitHub(config);
        activity = prActivity(config, stage);
      } catch (err) {
        items.push({ project: p, feature: f, reason: 'error', detail: `PR #${stage.pr.number}: ${err.message}` });
        continue;
      }
      const { pr, feedback } = activity;
      if (pr.state === 'MERGED') items.push({ project: p, feature: f, reason: 'merged', detail: `PR #${stage.pr.number} merged` });
      else if (pr.state === 'CLOSED') items.push({ project: p, feature: f, reason: 'closed', detail: `PR #${stage.pr.number} closed without merge` });
      else if (feedback.length)
        items.push({ project: p, feature: f, reason: 'review', detail: `PR #${stage.pr.number}: ${feedback.length} new review item(s) from ${[...new Set(feedback.map((x) => x.author).filter(Boolean))].join(', ') || 'someone'}` });
    }
  }
  const lock = only ? readLock(only) : null;
  out({ work: items.some((i) => i.reason !== 'error'), running: !!lock, items });
};

// One /factory-next run per project at a time, so a scheduled run never overlaps a manual one or a slow previous run.
// A lock older than LOCK_TTL is treated as left behind by a crashed run.
const LOCK_TTL_MS = 3 * 60 * 60 * 1000;
const lockFile = (p) => path.join(projectDir(p), 'run.lock');
function readLock(p) {
  const file = lockFile(p);
  if (!fs.existsSync(file)) return null;
  try {
    const lock = readJSON(file);
    return Date.now() - Date.parse(lock.at) < LOCK_TTL_MS ? lock : null;
  } catch {
    return null;
  }
}
commands['run:lock'] = ({ positional: [p], flags }) => {
  loadConfig(p);
  const held = readLock(p);
  if (held && !flags.force) return out({ acquired: false, heldBy: held.by, since: held.at });
  const lock = { at: now(), by: typeof flags.by === 'string' ? flags.by : 'factory-next' };
  writeJSON(lockFile(p), lock);
  out({ acquired: true, ...lock });
};
commands['run:unlock'] = ({ positional: [p] }) => {
  loadConfig(p);
  fs.rmSync(lockFile(p), { force: true });
  out({ released: true });
};

commands['event'] = ({ positional: [p, f, type, ...msg] }) => {
  loadConfig(p);
  if (!type) die('usage: event <project> <feature|-> <type> <message>');
  logEvent(p, f === '-' ? null : f, type, msg.join(' '));
  out({ ok: true });
};

// What should happen next for every active feature. kind: agent (factory acts), human (waiting on you), github (waiting on PR).
export function nextAction(config, state) {
  const stage = state.currentStage ? state.stages.find((s) => s.n === state.currentStage) : null;
  switch (state.status) {
    case 'spec_drafting':
      return { kind: 'agent', action: 'draft-spec', detail: 'Spec builder is drafting the spec' };
    case 'awaiting_spec_approval':
      return { kind: 'human', action: 'approve-spec', detail: `Review spec.md, then /factory-approve ${config.name} ${state.id} [feedback]` };
    case 'planning':
      return { kind: 'agent', action: 'plan', detail: 'Work planner is breaking the spec into stages' };
    case 'awaiting_plan_approval':
      return { kind: 'human', action: 'approve-plan', detail: `Review plan.md, then /factory-approve ${config.name} ${state.id} [feedback]` };
    case 'building': {
      const target = stage && ['building', 'reviewing', 'pending'].includes(stage.status) ? stage : state.stages.find((s) => ['building', 'reviewing', 'pending'].includes(s.status));
      if (!target) return { kind: 'agent', action: 'plan', detail: 'No buildable stage; check plan' };
      return { kind: 'agent', action: 'build-stage', stage: target.n, detail: `Building and reviewing stage ${target.n}: ${target.title}` };
    }
    case 'awaiting_merge':
      return { kind: 'github', action: 'sync-pr', stage: stage?.n, detail: `Waiting for review and merge of PR #${stage?.pr?.number ?? '?'}` };
    case 'needs_human': {
      const last = [...state.history].reverse().find((h) => h.status === 'needs_human');
      return { kind: 'human', action: 'unblock', detail: `${last?.note || 'Needs attention'} — /factory-approve ${config.name} ${state.id} <instructions>` };
    }
    default:
      return { kind: 'none', action: 'none', detail: state.status };
  }
}

commands['next'] = ({ positional: [only] }) => {
  const result = [];
  for (const p of only ? [only] : listProjects()) {
    const config = loadConfig(p);
    for (const f of listFeatures(p)) {
      const state = loadState(p, f);
      if (['done', 'cancelled'].includes(state.status)) continue;
      result.push({ project: p, feature: f, title: state.title, status: state.status, ...nextAction(config, state) });
    }
  }
  out(result);
};

commands['status'] = ({ flags }) => {
  const projects = listProjects().map((p) => {
    const config = loadConfig(p);
    return {
      project: p,
      repo: config.repo.slug || config.repo.path,
      setupComplete: !!config.setupComplete,
      features: listFeatures(p).map((f) => {
        const s = loadState(p, f);
        return {
          id: f,
          title: s.title,
          status: s.status,
          stages: s.stages.map((st) => `${st.n}:${st.status}${st.pr ? `#${st.pr.number}` : ''}`).join(' '),
          next: nextAction(config, s).detail,
        };
      }),
    };
  });
  if (flags.json) return out(projects);
  if (!projects.length) return out('No projects yet. Run /factory-init <path-to-repo>.');
  const lines = [];
  for (const pr of projects) {
    lines.push(`${pr.project}  (${pr.repo})${pr.setupComplete ? '' : '  [setup incomplete]'}`);
    if (!pr.features.length) lines.push('  no features');
    for (const f of pr.features) {
      lines.push(`  ${f.id}  ${f.status}${f.stages ? `  [${f.stages}]` : ''}`);
      if (!['done', 'cancelled'].includes(f.status)) lines.push(`      next: ${f.next}`);
    }
  }
  out(lines.join('\n'));
};

function usage() {
  return `Software Factory state CLI

  project:create <repo-path> [--name slug] [--remote name] [--base branch] [--force]
  project:refresh <project>              update the read-only checkout to latest base
  project:list | project:get <project>
  config:set <project> <dotted.key> <value>

  feature:create <project> --title "<title>" (--issue "<text>" | --issue-file <path>)
  feature:list <project> | feature:get <project> <feature>
  feature:status <project> <feature> <status> [--note "<why>"]
  feature:feedback <project> <feature> --gate spec|plan|stage|pr --text "<feedback>"

  stages:load <project> <feature>        read features/<id>/stages.json into state
  stage:start <project> <feature> [n]    create/resume worktree + branch for a stage
  stage:round <project> <feature> <n> [--kind review|pr]
  stage:update <project> <feature> <n> --json '{...}'
  stage:screenshots <project> <feature> <n>   capture + publish UI screenshots, writes stages/<n>/screenshots.md
  stage:pr <project> <feature> <n> --title "<title>" --body-file <path>
  stage:sync <project> <feature> [n]     check PR: merged / closed / new feedback
  stage:comment <project> <feature> <n> --body-file <path>   reply on the PR (adds signature + marker)

  event <project> <feature|-> <type> <message>
  next [project]                         next action for every active feature
  watch:check [project]                  anything for /factory-next to do? (checks PRs, changes nothing)
  run:lock <project> [--by who] [--force] | run:unlock <project>
  status [--json]`;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    out(usage());
    return 0;
  }
  const handler = commands[cmd];
  if (!handler) {
    process.stderr.write(`unknown command: ${cmd}\n\n${usage()}\n`);
    return 1;
  }
  try {
    await handler(parseArgs(rest));
    return 0;
  } catch (err) {
    if (err instanceof FactoryError || err instanceof SyntaxError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
