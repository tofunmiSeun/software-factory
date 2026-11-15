// End-to-end tests for scripts/factory.mjs against a scratch repo with a local bare remote
// and a fake `gh`. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'scripts', 'factory.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
const home = path.join(tmp, 'factory');
const bin = path.join(tmp, 'bin');
const ghState = path.join(tmp, 'gh.json');
fs.mkdirSync(home);
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node ${JSON.stringify(path.join(HERE, 'fake-gh.mjs'))} "$@"\n`, { mode: 0o755 });

const env = {
  ...process.env,
  FACTORY_HOME: home,
  GH_STUB_STATE: ghState,
  PATH: `${bin}:${process.env.PATH}`,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
};
const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8' }).trim();
function cli(...args) {
  const r = spawnSync('node', [CLI, ...args], { env, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* text output */
  }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
const ok = (...args) => {
  const r = cli(...args);
  assert.equal(r.code, 0, `${args.join(' ')} failed: ${r.err}`);
  return r.json ?? r.out;
};
const gh = () => JSON.parse(fs.readFileSync(ghState, 'utf8'));
const setGh = (mut) => {
  const db = gh();
  mut(db);
  fs.writeFileSync(ghState, JSON.stringify(db));
};

// Bare "GitHub" remote with one commit on main; the user's clone points at a github.com URL
// that git rewrites to the bare repo, so owner/repo detection and pushes both work offline.
const bare = path.join(tmp, 'remote.git');
const userRepo = path.join(tmp, 'my-app');
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, `[url "${bare}"]\n\tinsteadOf = https://github.com/acme/my-app.git\n[init]\n\tdefaultBranch = main\n`);
sh(tmp, 'git', 'init', '--bare', '-q', bare);
sh(tmp, 'git', 'clone', '-q', 'https://github.com/acme/my-app.git', userRepo);
fs.writeFileSync(path.join(userRepo, 'README.md'), '# my app\n');
sh(userRepo, 'git', 'add', '.');
sh(userRepo, 'git', 'commit', '-qm', 'init');
sh(userRepo, 'git', 'push', '-q', 'origin', 'main');
sh(userRepo, 'git', 'remote', 'set-head', 'origin', 'main');

test('project:create detects remote, owner/repo and base branch', () => {
  const r = ok('project:create', userRepo);
  assert.equal(r.project, 'my-app');
  assert.equal(r.config.repo.slug, 'acme/my-app');
  assert.equal(r.config.repo.host, 'github.com');
  assert.equal(r.config.repo.baseBranch, 'main');
  assert.equal(r.config.issues.source, 'manual');
  assert.ok(fs.existsSync(path.join(home, 'projects/my-app/checkout/README.md')), 'read-only checkout created');
  assert.equal(cli('project:create', userRepo).code, 1, 'refuses to overwrite without --force');
});

test('config:set updates nested keys and protects detected repo fields', () => {
  ok('config:set', 'my-app', 'commands.test', 'npm test');
  ok('config:set', 'my-app', 'review.maxRounds', '3');
  const c = ok('project:get', 'my-app');
  assert.equal(c.commands.test, 'npm test');
  assert.equal(c.review.maxRounds, 3);
  assert.equal(cli('config:set', 'my-app', 'repo.slug', 'evil/repo').code, 1);
});

let feature;
test('feature:create writes issue and initial state', () => {
  const r = ok('feature:create', 'my-app', '--title', 'Add dark mode!', '--issue', 'Users want a dark theme.');
  feature = r.id;
  assert.equal(feature, '001-add-dark-mode');
  assert.equal(r.state.status, 'spec_drafting');
  assert.match(fs.readFileSync(path.join(r.dir, 'issue.md'), 'utf8'), /dark theme/);
  assert.equal(ok('feature:create', 'my-app', '--title', 'Second', '--issue', 'x').id, '002-second');
});

test('rejects path traversal in names', () => {
  assert.equal(cli('feature:get', 'my-app', '../../etc').code, 1);
  assert.equal(cli('project:get', '../x').code, 1);
});

test('gate transitions and feedback are recorded', () => {
  ok('feature:status', 'my-app', feature, 'awaiting_spec_approval');
  ok('feature:feedback', 'my-app', feature, '--gate', 'spec', '--text', 'Also cover system preference');
  assert.equal(cli('feature:status', 'my-app', feature, 'bogus').code, 1);
  const s = ok('feature:get', 'my-app', feature);
  assert.equal(s.feedback.length, 1);
  assert.equal(ok('next', 'my-app')[0].kind, 'human');
});

test('stages load from stages.json', () => {
  const dir = path.join(home, 'projects/my-app/features', feature);
  fs.writeFileSync(path.join(dir, 'stages.json'), JSON.stringify([
    { title: 'Theme tokens', summary: 'Add CSS variables' },
    { title: 'Toggle UI', summary: 'Settings toggle' },
  ]));
  const stages = ok('stages:load', 'my-app', feature);
  assert.equal(stages.length, 2);
  assert.equal(stages[0].status, 'pending');
});

let wt;
test('stage:start creates a worktree on a fresh branch and blocks later stages until merge', () => {
  const r = ok('stage:start', 'my-app', feature);
  wt = r.worktree;
  assert.equal(r.stage.n, 1);
  assert.equal(r.branch, 'factory/001-add-dark-mode/s1-theme-tokens');
  assert.ok(fs.existsSync(path.join(wt, 'README.md')));
  assert.equal(sh(wt, 'git', 'rev-parse', '--abbrev-ref', 'HEAD'), r.branch);
  assert.equal(sh(userRepo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', "user's checkout untouched");
  assert.equal(ok('stage:start', 'my-app', feature).resumed, true, 'second call resumes');
  const blocked = cli('stage:start', 'my-app', feature, '2');
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /not merged yet/);
  assert.equal(ok('next', 'my-app').find((n) => n.feature === feature).action, 'build-stage');
});

test('stage:round enforces the build/review limit of 3', () => {
  const rounds = [1, 2, 3, 4].map(() => ok('stage:round', 'my-app', feature, '1'));
  assert.deepEqual(rounds.map((r) => r.allowed), [true, true, true, false]);
  assert.equal(ok('stage:round', 'my-app', feature, '1', '--kind', 'pr').round, 1, 'PR rounds counted separately');
});

test('stage:pr refuses an empty branch, then pushes and opens a PR', () => {
  const body = path.join(tmp, 'body.md');
  fs.writeFileSync(body, 'Adds theme tokens.');
  assert.match(cli('stage:pr', 'my-app', feature, '1', '--title', 'x', '--body-file', body).err, /no commits/);

  fs.writeFileSync(path.join(wt, 'theme.css'), ':root { --bg: #000; }\n');
  sh(wt, 'git', 'add', '.');
  sh(wt, 'git', 'commit', '-qm', 'feat: theme tokens');
  const stage = ok('stage:pr', 'my-app', feature, '1', '--title', 'feat: theme tokens', '--body-file', body);
  assert.equal(stage.status, 'pr_open');
  assert.equal(stage.pr.number, 1);
  assert.equal(gh().prs[0].base, 'main');
  assert.match(gh().prs[0].body, /software-factory/);
  assert.ok(sh(bare, 'git', 'branch', '--list', 'factory/*').includes('s1-theme-tokens'), 'branch pushed');
  assert.equal(ok('feature:get', 'my-app', feature).status, 'awaiting_merge');
});

test('stage:sync reports only new human feedback', () => {
  const mine = () => ok('watch:check', 'my-app').items.filter((i) => i.feature === feature);
  assert.deepEqual(mine(), [], 'open PR with no feedback is not work');
  const later = new Date(Date.now() + 60_000).toISOString();
  setGh((db) => {
    db.prs[0].comments.push({ author: { login: 'me' }, createdAt: later, body: 'Please rename --bg to --color-bg' });
    db.prs[0].comments.push({ author: { login: 'me' }, createdAt: later, body: 'Done. <!-- software-factory -->' });
    db.prs[0].inline.push({ user: { login: 'me' }, created_at: later, path: 'theme.css', line: 1, body: 'nit: add light value' });
  });
  const w = ok('watch:check', 'my-app');
  assert.equal(w.work, true);
  assert.deepEqual(mine().map((i) => i.reason), ['review']);
  assert.match(mine()[0].detail, /2 new review item\(s\) from me/);
  const r = ok('stage:sync', 'my-app', feature);
  assert.equal(r.result, 'open');
  assert.equal(r.newFeedback.length, 2);
  assert.deepEqual(r.newFeedback.map((x) => x.kind).sort(), ['comment', 'inline']);
  ok('stage:update', 'my-app', feature, '1', '--json', JSON.stringify({ lastFeedbackAt: r.latestFeedbackAt }));
  assert.equal(ok('stage:sync', 'my-app', feature).newFeedback.length, 0, 'acknowledged feedback not repeated');
  assert.deepEqual(mine(), [], 'acknowledged feedback is not work');
});

test('identity: unpushed commits are re-authored on push; comments are signed and ignored as feedback', () => {
  ok('config:set', 'my-app', 'identity.name', 'Software Factory');
  ok('config:set', 'my-app', 'identity.email', 'me+factory@example.com');
  fs.writeFileSync(path.join(wt, 'theme.css'), ':root { --bg: #111; }\n');
  sh(wt, 'git', 'add', '.');
  sh(wt, 'git', 'commit', '-qm', 'fix: darker bg');
  const body = path.join(tmp, 'body.md');
  assert.equal(ok('stage:pr', 'my-app', feature, '1', '--title', 'feat: theme tokens', '--body-file', body).reauthored, 1);
  const log = sh(bare, 'git', 'log', '--format=%an <%ae> | %cn | %s', 'factory/001-add-dark-mode/s1-theme-tokens', '-2').split('\n');
  assert.deepEqual(log, ['Software Factory <me+factory@example.com> | Software Factory | fix: darker bg', 'Test <test@example.com> | Test | feat: theme tokens'], 'already-pushed commit untouched');
  assert.equal(ok('stage:pr', 'my-app', feature, '1', '--title', 'feat: theme tokens', '--body-file', body).reauthored, 0, 'nothing to redo');

  const reply = path.join(tmp, 'reply.md');
  fs.writeFileSync(reply, 'Renamed the token.');
  ok('stage:comment', 'my-app', feature, '1', '--body-file', reply);
  const c = gh().prs[0].comments.at(-1).body;
  assert.match(c, /^\*\*🤖 Software Factory\*\*\n\nRenamed the token\.\n\n<!-- software-factory -->\n$/);
  assert.deepEqual(ok('stage:sync', 'my-app', feature).newFeedback.filter((x) => x.body === c), [], 'own comment is not feedback');
});

test('run lock: one run per project; stale or force overrides', () => {
  assert.equal(ok('run:lock', 'my-app', '--by', 'scheduled').acquired, true);
  const second = ok('run:lock', 'my-app');
  assert.equal(second.acquired, false);
  assert.equal(second.heldBy, 'scheduled');
  assert.equal(ok('watch:check', 'my-app').running, true);
  assert.equal(ok('run:lock', 'my-app', '--force').acquired, true);
  ok('run:unlock', 'my-app');
  fs.writeFileSync(path.join(home, 'projects/my-app/run.lock'), JSON.stringify({ at: '2020-01-01T00:00:00Z', by: 'crashed' }));
  assert.equal(ok('run:lock', 'my-app').acquired, true, 'stale lock ignored');
  ok('run:unlock', 'my-app');
  assert.equal(ok('watch:check', 'my-app').running, false);
});

test('stage:sync on merge cleans up and moves to the next stage, then finishes', () => {
  setGh((db) => {
    db.prs[0].state = 'MERGED';
    db.prs[0].mergedAt = new Date().toISOString();
  });
  assert.deepEqual(ok('watch:check', 'my-app').items.filter((i) => i.feature === feature).map((i) => i.reason), ['merged']);
  const r = ok('stage:sync', 'my-app', feature);
  assert.equal(r.result, 'merged');
  assert.equal(r.nextStage, 2);
  assert.equal(r.worktree, 'removed');
  assert.ok(!fs.existsSync(wt));
  const n = ok('next', 'my-app').find((x) => x.feature === feature);
  assert.equal(n.action, 'build-stage');
  assert.equal(n.stage, 2);

  const s2 = ok('stage:start', 'my-app', feature);
  assert.equal(s2.stage.n, 2);
  fs.writeFileSync(path.join(s2.worktree, 'toggle.js'), 'export {}\n');
  sh(s2.worktree, 'git', 'add', '.');
  sh(s2.worktree, 'git', 'commit', '-qm', 'feat: toggle');
  const body = path.join(tmp, 'body2.md');
  fs.writeFileSync(body, 'Toggle');
  ok('stage:pr', 'my-app', feature, '2', '--title', 'feat: toggle', '--body-file', body);
  setGh((db) => {
    db.prs[1].state = 'MERGED';
    db.prs[1].mergedAt = new Date().toISOString();
  });
  const done = ok('stage:sync', 'my-app', feature);
  assert.equal(done.featureStatus, 'done');
  assert.equal(done.nextStage, null);
});

test('status and events summarise everything', () => {
  const text = ok('status');
  assert.match(text, /my-app {2}\(acme\/my-app\)/);
  assert.match(text, /001-add-dark-mode {2}done/);
  const events = fs.readFileSync(path.join(home, 'projects/my-app/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'stage.merged'));
});

test('project:create errors clearly without a remote', () => {
  const lonely = path.join(tmp, 'lonely');
  sh(tmp, 'git', 'init', '-q', lonely);
  const r = cli('project:create', lonely);
  assert.equal(r.code, 1);
  assert.match(r.err, /no git remote/);
});
