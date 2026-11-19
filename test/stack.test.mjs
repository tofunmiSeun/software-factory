// Stacked-PR mode (planning.nextStageTrigger "stack") against a scratch repo, a local bare remote and a fake `gh`.
// Run: node --test test/stack.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'scripts', 'factory.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-stack-'));
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
  GIT_EDITOR: 'true',
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
const commit = (wt, file, content, msg) => {
  fs.writeFileSync(path.join(wt, file), content);
  sh(wt, 'git', 'add', '.');
  sh(wt, 'git', 'commit', '-qm', msg);
};
const body = path.join(tmp, 'body.md');
fs.writeFileSync(body, 'Stage body');

const bare = path.join(tmp, 'remote.git');
const userRepo = path.join(tmp, 'stk');
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, `[url "${bare}"]\n\tinsteadOf = https://github.com/acme/stk.git\n[init]\n\tdefaultBranch = main\n`);
sh(tmp, 'git', 'init', '--bare', '-q', bare);
sh(tmp, 'git', 'clone', '-q', 'https://github.com/acme/stk.git', userRepo);
commit(userRepo, 'README.md', '# stk\n', 'init');
sh(userRepo, 'git', 'push', '-q', 'origin', 'main');
sh(userRepo, 'git', 'remote', 'set-head', 'origin', 'main');

let feature;
let wt1;
let wt2;
let wt3;
let s1;
let s2;

test('set up a three-stage feature in stack mode', () => {
  ok('project:create', userRepo);
  ok('config:set', 'stk', 'planning.nextStageTrigger', 'stack');
  ok('config:set', 'stk', 'planning.maxStackDepth', '2');
  feature = ok('feature:create', 'stk', '--title', 'Stacked', '--issue', 'x').id;
  const dir = path.join(home, 'projects/stk/features', feature);
  fs.writeFileSync(path.join(dir, 'stages.json'), JSON.stringify([{ title: 'One' }, { title: 'Two' }, { title: 'Three' }]));
  ok('stages:load', 'stk', feature);
  ok('feature:status', 'stk', feature, 'building');
});

test('a stage cannot start before its predecessor has an open PR', () => {
  wt1 = ok('stage:start', 'stk', feature).worktree;
  const r = cli('stage:start', 'stk', feature, '2');
  assert.equal(r.code, 1);
  assert.match(r.err, /open its PR before starting stage 2/);
});

test('stage 2 branches from stage 1 and its PR targets stage 1\'s branch', () => {
  commit(wt1, 'a.txt', 'a\n', 'feat: a');
  s1 = ok('stage:pr', 'stk', feature, '1', '--title', 'one', '--body-file', body);
  assert.equal(gh().prs[0].base, 'main');
  assert.equal(ok('feature:get', 'stk', feature).status, 'building', 'stage 2 can start, so the feature keeps building');

  const r = ok('stage:start', 'stk', feature);
  assert.equal(r.stage.n, 2);
  assert.equal(r.stage.parent, 1);
  wt2 = r.worktree;
  assert.equal(r.stage.baseSha, sh(wt1, 'git', 'rev-parse', 'HEAD'));
  assert.ok(fs.existsSync(path.join(wt2, 'a.txt')), 'stage 2 sees stage 1\'s work');

  commit(wt2, 'b.txt', 'one\n', 'feat: b');
  s2 = ok('stage:pr', 'stk', feature, '2', '--title', 'two', '--body-file', body);
  assert.equal(gh().prs[1].base, s1.branch);
  assert.match(gh().prs[1].body, /Stacked\*\* on PR #1/);
});

test('the depth cap blocks stage 3 while two PRs are open; next lists both syncs', () => {
  const r = cli('stage:start', 'stk', feature, '3');
  assert.equal(r.code, 1);
  assert.match(r.err, /already open/);
  assert.equal(ok('feature:get', 'stk', feature).status, 'awaiting_merge');
  const next = ok('next', 'stk').filter((n) => n.feature === feature);
  assert.deepEqual(next.map((n) => `${n.action}:${n.stage}`), ['sync-pr:1', 'sync-pr:2']);
});

test('stage:restack carries a fix in stage 1 down to stage 2 and force-pushes it', () => {
  commit(wt1, 'a2.txt', 'fix\n', 'fix: review feedback');
  ok('stage:pr', 'stk', feature, '1', '--title', 'one', '--body-file', body);
  const r = ok('stage:restack', 'stk', feature);
  assert.deepEqual(r.results.map((x) => `${x.stage}:${x.result}`), ['2:restacked']);
  assert.ok(fs.existsSync(path.join(wt2, 'a2.txt')));
  assert.equal(sh(wt2, 'git', 'rev-parse', 'HEAD'), sh(bare, 'git', 'rev-parse', s2.branch), 'rebased branch is on the remote');
  assert.equal(spawnSync('git', ['-C', wt2, 'merge-base', '--is-ancestor', sh(wt1, 'git', 'rev-parse', 'HEAD'), 'HEAD'], { env }).status, 0, 'stage 2 sits on stage 1\'s new tip');
  assert.deepEqual(ok('stage:restack', 'stk', feature).results.map((x) => x.result), ['up-to-date']);
});

test('after a squash merge of stage 1, stage 2 is rebased onto main and retargeted', () => {
  sh(userRepo, 'git', 'fetch', '-q', 'origin');
  sh(userRepo, 'git', 'merge', '--squash', `origin/${s1.branch}`);
  sh(userRepo, 'git', 'commit', '-qm', 'one (squashed)');
  sh(userRepo, 'git', 'push', '-q', 'origin', 'main');
  setGh((db) => {
    db.prs[0].state = 'MERGED';
    db.prs[0].mergedAt = new Date().toISOString();
  });
  const r = ok('stage:sync', 'stk', feature);
  assert.equal(r.result, 'merged');
  assert.equal(r.stage, 1);
  assert.deepEqual(r.restacked.map((x) => `${x.stage}:${x.result}:${x.retargeted}`), ['2:restacked:true']);
  assert.equal(r.nextStage, 3);
  assert.equal(r.featureStatus, 'building');
  assert.equal(gh().prs[1].base, 'main');
  assert.equal(sh(wt2, 'git', 'rev-list', '--count', 'origin/main..HEAD'), '1', 'only stage 2\'s own commit remains');
  const stage2 = ok('feature:get', 'stk', feature).stages[1];
  assert.equal(stage2.parent, null);
  const next = ok('next', 'stk').filter((n) => n.feature === feature).map((n) => `${n.action}:${n.stage}`);
  assert.deepEqual(next, ['sync-pr:2', 'build-stage:3']);
});

test('a restack conflict stops the stack for a human, and a hand-resolved branch is accepted', () => {
  const r3 = ok('stage:start', 'stk', feature, '3');
  assert.equal(r3.stage.parent, 2);
  wt3 = r3.worktree;
  commit(wt3, 'b.txt', 'three\n', 'feat: three edits b');
  ok('stage:pr', 'stk', feature, '3', '--title', 'three', '--body-file', body);
  assert.equal(gh().prs[2].base, s2.branch);

  commit(wt2, 'b.txt', 'uno\n', 'fix: stage 2 edits b too');
  ok('stage:pr', 'stk', feature, '2', '--title', 'two', '--body-file', body);
  const tip3 = sh(wt3, 'git', 'rev-parse', 'HEAD');
  const parentSha = ok('feature:get', 'stk', feature).stages[2].parentSha;
  const r = ok('stage:restack', 'stk', feature);
  assert.deepEqual(r.results.map((x) => `${x.stage}:${x.result}`), ['3:conflict']);
  assert.equal(r.featureStatus, 'needs_human');
  assert.equal(sh(wt3, 'git', 'rev-parse', 'HEAD'), tip3, 'rebase aborted, branch untouched');
  assert.equal(sh(wt3, 'git', 'status', '--porcelain'), '');
  assert.equal(ok('next', 'stk').find((n) => n.feature === feature && n.kind === 'human').action, 'unblock');

  // a human resolves it by hand in the worktree
  const tip2 = sh(wt2, 'git', 'rev-parse', 'HEAD');
  assert.equal(spawnSync('git', ['-C', wt3, 'rebase', '--onto', tip2, parentSha], { env }).status, 1);
  fs.writeFileSync(path.join(wt3, 'b.txt'), 'uno three\n');
  sh(wt3, 'git', 'add', '.');
  sh(wt3, 'git', 'rebase', '--continue');
  const fixed = ok('stage:restack', 'stk', feature);
  assert.deepEqual(fixed.results.map((x) => `${x.stage}:${x.result}`), ['3:restacked']);
  assert.notEqual(fixed.featureStatus, 'needs_human');
  assert.equal(sh(wt3, 'git', 'rev-parse', 'HEAD'), sh(bare, 'git', 'rev-parse', ok('feature:get', 'stk', feature).stages[2].branch));
});

test('restack never overwrites commits someone else pushed to a stage branch', () => {
  const b3 = ok('feature:get', 'stk', feature).stages[2].branch;
  sh(userRepo, 'git', 'fetch', '-q', 'origin');
  sh(userRepo, 'git', 'checkout', '-q', '-B', 'foreign', `origin/${b3}`);
  commit(userRepo, 'reviewer.txt', 'suggestion\n', 'review: suggested change pushed by a human');
  sh(userRepo, 'git', 'push', '-q', 'origin', `foreign:${b3}`);
  sh(userRepo, 'git', 'checkout', '-q', 'main');
  const remoteTip = sh(bare, 'git', 'rev-parse', b3);

  commit(wt2, 'c.txt', 'x\n', 'fix: another stage 2 change');
  ok('stage:pr', 'stk', feature, '2', '--title', 'two', '--body-file', body);
  const r = ok('stage:restack', 'stk', feature);
  assert.equal(r.results[0].result, 'conflict');
  assert.match(r.results[0].detail, /not overwriting/);
  assert.equal(sh(bare, 'git', 'rev-parse', b3), remoteTip, 'the human\'s commit is still on the remote');
});

test('merge mode is unchanged: stage:restack refuses', () => {
  ok('config:set', 'stk', 'planning.nextStageTrigger', 'merge');
  assert.match(cli('stage:restack', 'stk', feature).err, /only applies/);
});
