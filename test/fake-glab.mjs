#!/usr/bin/env node
// Minimal stand-in for `glab api` used by the GitLab tests.
// Merge-request state lives in the JSON file named by GLAB_STUB_STATE; every call is recorded in db.calls.
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.GLAB_STUB_STATE;
const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { mrs: [], uploads: [], calls: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(db, null, 2));
const fail = (msg) => {
  save();
  process.stderr.write(`fake glab: ${msg}\n`);
  process.exit(1);
};
const reply = (value) => {
  save();
  process.stdout.write(JSON.stringify(value));
};

const args = process.argv.slice(2);
if (args[0] !== 'api') fail(`unsupported ${args.join(' ')}`);
const opts = { method: 'GET', forms: [] };
let endpoint;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--hostname') opts.hostname = args[++i];
  else if (a === '--method' || a === '-X') opts.method = args[++i];
  else if (a === '--input') opts.input = JSON.parse(fs.readFileSync(args[++i], 'utf8'));
  else if (a === '--form') opts.forms.push(args[++i]);
  else if (a === '--paginate') opts.paginate = true;
  else if (a.startsWith('-')) fail(`unsupported flag ${a}`);
  else endpoint = a;
}
db.calls.push({ ...opts, endpoint });

const [route, query = ''] = endpoint.split('?');
const params = new URLSearchParams(query);
const m = route.match(/^projects\/([^/]+)\/(merge_requests|uploads)(?:\/(\d+))?(?:\/(notes))?$/);
if (!m) fail(`unsupported endpoint ${endpoint}`);
const [, project, kind, iid, sub] = m;
if (project.includes('/')) fail(`project path must be URL-encoded: ${project}`);
const slug = decodeURIComponent(project);
const mr = iid && db.mrs.find((x) => x.iid === Number(iid));
if (iid && !mr) fail(`404 merge request ${iid}`);

if (kind === 'uploads' && opts.method === 'POST') {
  const name = path.basename(opts.forms.find((f) => f.startsWith('file=@')).slice('file=@'.length));
  db.uploads.push(name);
  reply({ alt: name, url: `/uploads/${db.uploads.length}abc/${name}`, markdown: `![${name}](/uploads/${db.uploads.length}abc/${name})` });
} else if (!iid && opts.method === 'POST') {
  const iid = db.mrs.length + 1;
  const created = { iid, web_url: `https://${opts.hostname}/${slug}/-/merge_requests/${iid}`, state: 'opened', merged_at: null, ...opts.input, notes: [] };
  db.mrs.push(created);
  reply(created);
} else if (!iid) {
  reply(db.mrs.filter((x) => (!params.get('state') || x.state === params.get('state')) && (!params.get('source_branch') || x.source_branch === params.get('source_branch'))));
} else if (sub === 'notes' && opts.method === 'POST') {
  const note = { id: Date.now(), body: opts.input.body, author: { username: 'me' }, created_at: new Date().toISOString(), system: false, type: null };
  mr.notes.push(note);
  reply(note);
} else if (sub === 'notes') {
  reply(mr.notes);
} else if (opts.method === 'PUT') {
  Object.assign(mr, opts.input);
  reply({ iid: mr.iid, target_branch: mr.target_branch });
} else {
  const { notes, ...rest } = mr;
  reply(rest);
}
