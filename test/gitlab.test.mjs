// End-to-end tests for GitLab projects: merge requests through a fake `glab api`,
// against a scratch repo whose gitlab.com remote git rewrites to a local bare repo. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'scripts', 'factory.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-gitlab-test-'));
const home = path.join(tmp, 'factory');
const bin = path.join(tmp, 'bin');
const glabState = path.join(tmp, 'glab.json');
fs.mkdirSync(home);
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'glab'), `#!/bin/sh\nexec node ${JSON.stringify(path.join(HERE, 'fake-glab.mjs'))} "$@"\n`, { mode: 0o755 });
// gh must never be called for a GitLab project.
fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "gh called for a GitLab project" >&2\nexit 1\n', { mode: 0o755 });

const env = {
  ...process.env,
  FACTORY_HOME: home,
  GLAB_STUB_STATE: glabState,
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
const glab = () => JSON.parse(fs.readFileSync(glabState, 'utf8'));
const setGlab = (mut) => {
  const db = glab();
  mut(db);
  fs.writeFileSync(glabState, JSON.stringify(db));
};

// A GitLab repo in a subgroup (acme/web/app) and a self-hosted one, both backed by local bare repos.
const bare = path.join(tmp, 'remote.git');
const selfBare = path.join(tmp, 'self.git');
const userRepo = path.join(tmp, 'app');
const selfRepo = path.join(tmp, 'internal');
fs.writeFileSync(
  env.GIT_CONFIG_GLOBAL,
  `[url "${bare}"]\n\tinsteadOf = https://gitlab.com/acme/web/app.git\n[url "${selfBare}"]\n\tinsteadOf = https://code.example.com/team/internal.git\n[init]\n\tdefaultBranch = main\n`
);
for (const [b, url, dir] of [[bare, 'https://gitlab.com/acme/web/app.git', userRepo], [selfBare, 'https://code.example.com/team/internal.git', selfRepo]]) {
  sh(tmp, 'git', 'init', '--bare', '-q', b);
  sh(tmp, 'git', 'clone', '-q', url, dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# app\n');
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', 'commit', '-qm', 'init');
  sh(dir, 'git', 'push', '-q', 'origin', 'main');
  sh(dir, 'git', 'remote', 'set-head', 'origin', 'main');
}

test('project:create recognises gitlab.com, including subgroup paths', () => {
  const r = ok('project:create', userRepo);
  assert.equal(r.config.repo.host, 'gitlab.com');
  assert.equal(r.config.repo.slug, 'acme/web/app');
  assert.equal(r.config.repo.forge, 'gitlab');
  assert.equal(r.config.repo.baseBranch, 'main');
});

test('a self-hosted GitLab needs --forge, which a later re-detect keeps', () => {
  assert.equal(ok('project:create', selfRepo).config.repo.forge, null);
  assert.equal(cli('project:create', selfRepo, '--force', '--forge', 'bitbucket').code, 1);
  assert.equal(ok('project:create', selfRepo, '--force', '--forge', 'gitlab').config.repo.forge, 'gitlab');
  assert.equal(ok('project:create', selfRepo, '--force').config.repo.forge, 'gitlab');
});

const feature = '001-add-search';
let wt;
test('stage:pr pushes the branch and opens a merge request', () => {
  ok('feature:create', 'app', '--title', 'Add search', '--issue', 'Users want to search.');
  fs.writeFileSync(path.join(home, 'projects/app/features', feature, 'stages.json'), JSON.stringify([{ title: 'Search box', summary: 'Input + results' }]));
  ok('stages:load', 'app', feature);
  ok('config:set', 'app', 'conventions.branchPrefix', 'tofunmi-factory/');
  wt = ok('stage:start', 'app', feature).worktree;
  fs.writeFileSync(path.join(wt, 'search.js'), 'export {}\n');
  sh(wt, 'git', 'add', '.');
  sh(wt, 'git', 'commit', '-qm', 'feat: search box');
  const body = path.join(tmp, 'body.md');
  fs.writeFileSync(body, 'Adds a search box.');

  const stage = ok('stage:pr', 'app', feature, '1', '--title', 'feat: search box', '--body-file', body);
  assert.equal(stage.status, 'pr_open');
  assert.deepEqual([stage.pr.number, stage.pr.ref, stage.pr.url], [1, 'MR !1', 'https://gitlab.com/acme/web/app/-/merge_requests/1']);
  const mr = glab().mrs[0];
  assert.equal(mr.source_branch, 'tofunmi-factory/001-add-search/s1-search-box');
  assert.equal(mr.target_branch, 'main');
  assert.equal(mr.title, 'feat: search box');
  assert.match(mr.description, /Adds a search box\.[\s\S]*<!-- software-factory -->/);
  const create = glab().calls.find((c) => c.method === 'POST');
  assert.equal(create.endpoint, 'projects/acme%2Fweb%2Fapp/merge_requests', 'project path is URL-encoded');
  assert.equal(create.hostname, 'gitlab.com');
  assert.ok(sh(bare, 'git', 'branch', '--list', 'tofunmi-factory/*').includes('s1-search-box'), 'branch pushed');

  assert.equal(ok('stage:pr', 'app', feature, '1', '--title', 'feat: search box', '--body-file', body).pr.number, 1, 'reuses the open MR');
  assert.equal(glab().mrs.length, 1);
  const f = ok('feature:get', 'app', feature);
  assert.equal(f.status, 'awaiting_merge');
  assert.match(f.history.at(-1).note, /MR !1/);
  assert.match(ok('next', 'app')[0].detail, /MR !1/);
});

test('stage:sync reports new human notes, inline ones with path and line, and skips system and factory notes', () => {
  const later = new Date(Date.now() + 60_000).toISOString();
  setGlab((db) => {
    db.mrs[0].notes.push(
      { id: 1, body: 'Please debounce the input', author: { username: 'reviewer' }, created_at: later, system: false, type: null },
      { id: 2, body: 'nit: name this query', author: { username: 'reviewer' }, created_at: later, system: false, type: 'DiffNote', position: { new_path: 'search.js', new_line: 1 } },
      { id: 3, body: 'added 1 commit', author: { username: 'reviewer' }, created_at: later, system: true, type: null },
      { id: 4, body: 'Done. <!-- software-factory -->', author: { username: 'me' }, created_at: later, system: false, type: null }
    );
  });
  const w = ok('watch:check', 'app').items;
  assert.deepEqual(w.map((i) => i.reason), ['review']);
  assert.match(w[0].detail, /^MR !1: 2 new review item\(s\) from reviewer$/);

  const r = ok('stage:sync', 'app', feature);
  assert.equal(r.result, 'open');
  assert.deepEqual(r.newFeedback.map((x) => [x.kind, x.author, x.path ?? null, x.line ?? null]), [
    ['comment', 'reviewer', null, null],
    ['inline', 'reviewer', 'search.js', 1],
  ]);
  ok('stage:update', 'app', feature, '1', '--json', JSON.stringify({ lastFeedbackAt: r.latestFeedbackAt }));
  assert.equal(ok('stage:sync', 'app', feature).newFeedback.length, 0, 'acknowledged feedback not repeated');
});

test('stage:comment posts a signed note that is not read back as feedback', () => {
  const reply = path.join(tmp, 'reply.md');
  fs.writeFileSync(reply, 'Debounced the input.');
  ok('stage:comment', 'app', feature, '1', '--body-file', reply);
  const note = glab().mrs[0].notes.at(-1);
  assert.match(note.body, /^\*\*🤖 Software Factory\*\*\n\nDebounced the input\.\n\n<!-- software-factory -->\n$/);
  assert.equal(glab().calls.at(-1).endpoint, 'projects/acme%2Fweb%2Fapp/merge_requests/1/notes');
  assert.deepEqual(ok('stage:sync', 'app', feature).newFeedback, []);
});

test('a merged MR finishes the feature; status shows !n', () => {
  setGlab((db) => {
    db.mrs[0].state = 'merged';
    db.mrs[0].merged_at = new Date().toISOString();
  });
  assert.deepEqual(ok('watch:check', 'app').items.map((i) => [i.reason, i.detail]), [['merged', 'MR !1 merged']]);
  const r = ok('stage:sync', 'app', feature);
  assert.equal(r.result, 'merged');
  assert.equal(r.featureStatus, 'done');
  assert.ok(!fs.existsSync(wt), 'worktree removed');
  assert.match(ok('status'), /001-add-search {2}done {2}\[1:merged!1\]/);
});

test('a closed MR needs a human', () => {
  ok('feature:create', 'app', '--title', 'Add filters', '--issue', 'x');
  const f2 = '002-add-filters';
  fs.writeFileSync(path.join(home, 'projects/app/features', f2, 'stages.json'), JSON.stringify([{ title: 'Filters' }]));
  ok('stages:load', 'app', f2);
  const w = ok('stage:start', 'app', f2).worktree;
  fs.writeFileSync(path.join(w, 'filters.js'), 'export {}\n');
  sh(w, 'git', 'add', '.');
  sh(w, 'git', 'commit', '-qm', 'feat: filters');
  const body = path.join(tmp, 'body2.md');
  fs.writeFileSync(body, 'Filters');
  assert.equal(ok('stage:pr', 'app', f2, '1', '--title', 'feat: filters', '--body-file', body).pr.ref, 'MR !2');
  setGlab((db) => {
    db.mrs[1].state = 'closed';
  });
  assert.equal(ok('stage:sync', 'app', f2).featureStatus, 'needs_human');
});

test('an unknown host is refused with a clear message', () => {
  ok('feature:create', 'internal', '--title', 'X', '--issue', 'x');
  ok('project:create', selfRepo, '--force', '--forge', 'gitlab');
  // Simulate a project registered before forge detection existed, on a host we can't classify.
  const file = path.join(home, 'projects/internal/config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete config.repo.forge;
  fs.writeFileSync(file, JSON.stringify(config));
  fs.writeFileSync(path.join(home, 'projects/internal/features/001-x/stages.json'), JSON.stringify([{ title: 'X' }]));
  ok('stages:load', 'internal', '001-x');
  ok('stage:start', 'internal', '001-x');
  const r = cli('stage:pr', 'internal', '001-x', '1', '--title', 'x', '--body-file', path.join(tmp, 'body.md'));
  assert.equal(r.code, 1);
  assert.match(r.err, /GitHub or GitLab.*--forge github\|gitlab/);
});
