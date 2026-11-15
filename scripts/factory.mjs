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
import { execFileSync } from 'node:child_process';
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

function defaultConfig({ name, repoPath, remote, remoteUrl, host, slug, baseBranch }) {
  return {
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
    offLimits: [],
    notes: '',
    setupComplete: false,
  };
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

  git(stage.worktree, 'push', '--quiet', '-u', config.repo.remote, `HEAD:refs/heads/${stage.branch}`);
  const repoArgs = ['--repo', config.repo.slug];
  let pr = JSON.parse(tryRun('gh', ['pr', 'view', stage.branch, ...repoArgs, '--json', 'number,url,state']) || 'null');
  if (!pr || pr.state !== 'OPEN') {
    const body = fs.readFileSync(path.resolve(flags['body-file']), 'utf8');
    const bodyFile = path.join(featureDir(p, f), 'stages', String(n), 'pr-body.md');
    fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
    fs.writeFileSync(bodyFile, `${body.trim()}\n\n${PR_MARKER}\n`);
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
  out(stage);
};

// Check a stage's PR. Merged → clean up and move to the next stage (or finish).
// Open → report review feedback newer than lastFeedbackAt, excluding the factory's own comments.
commands['stage:sync'] = ({ positional: [p, f, nArg] }) => {
  const config = loadConfig(p);
  requireGitHub(config);
  const state = loadState(p, f);
  const stage = getStage(state, nArg ?? state.currentStage);
  if (!stage.pr) die(`stage ${stage.n} has no PR`);
  const pr = JSON.parse(
    run('gh', ['pr', 'view', String(stage.pr.number), '--repo', config.repo.slug, '--json', 'state,mergedAt,reviewDecision,reviews,comments,url'])
  );

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

  const since = stage.lastFeedbackAt ? Date.parse(stage.lastFeedbackAt) : 0;
  const notOurs = (body) => !String(body || '').includes(PR_MARKER);
  const feedback = [];
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
  stage:pr <project> <feature> <n> --title "<title>" --body-file <path>
  stage:sync <project> <feature> [n]     check PR: merged / closed / new feedback

  event <project> <feature|-> <type> <message>
  next [project]                         next action for every active feature
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
