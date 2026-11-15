// Dashboard API tests. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../dashboard/server.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-dash-'));
const fdir = path.join(home, 'projects/app/features/001-thing');
fs.mkdirSync(path.join(fdir, 'stages/1'), { recursive: true });
fs.writeFileSync(path.join(home, 'projects/app/config.json'), JSON.stringify({
  name: 'app', repo: { slug: 'acme/app', baseBranch: 'main', path: '/x', host: 'github.com' }, review: { maxRounds: 3, lenses: ['ux'] }, setupComplete: true,
}));
fs.writeFileSync(path.join(fdir, 'state.json'), JSON.stringify({
  id: '001-thing', project: 'app', title: 'Thing', status: 'awaiting_spec_approval', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  currentStage: null, feedback: [], history: [{ at: '2026-01-01T00:00:00Z', status: 'spec_drafting' }], stages: [],
}));
fs.writeFileSync(path.join(fdir, 'spec.md'), '# Spec\nhello');
fs.writeFileSync(path.join(fdir, 'stages/1/review-1.md'), 'VERDICT: PASS');
fs.writeFileSync(path.join(home, 'projects/app/events.jsonl'), '{"at":"2026-01-01T00:00:00Z","project":"app","type":"feature.created","message":"Thing"}\nnot json\n');
fs.writeFileSync(path.join(home, 'secret.txt'), 'nope');

const server = createServer(home);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (p) => fetch(base + p);

test('state aggregates projects, features, next action, docs and events', async () => {
  const s = await (await get('/api/state')).json();
  assert.equal(s.projects.length, 1);
  const f = s.projects[0].features[0];
  assert.equal(f.next.kind, 'human');
  assert.deepEqual(f.docs, ['spec.md', 'stages/1/review-1.md']);
  assert.equal(s.events.length, 1, 'bad event lines are skipped');
});

test('doc endpoint serves whitelisted docs only', async () => {
  assert.equal(await (await get('/api/doc?project=app&feature=001-thing&doc=spec.md')).text(), '# Spec\nhello');
  assert.equal((await get('/api/doc?project=app&feature=001-thing&doc=stages/1/review-1.md')).status, 200);
  for (const bad of ['../../../secret.txt', 'state.json', 'stages/1/../../../../secret.txt']) {
    assert.equal((await get(`/api/doc?project=app&feature=001-thing&doc=${encodeURIComponent(bad)}`)).status, 404, bad);
  }
  assert.equal((await get('/api/doc?project=..&feature=001-thing&doc=spec.md')).status, 404);
});

test('serves the board and rejects writes', async () => {
  const r = await get('/');
  assert.match(await r.text(), /Software Factory/);
  assert.equal((await fetch(base + '/api/state', { method: 'POST' })).status, 405);
});

test.after(() => server.close());
