#!/usr/bin/env node
// Local Software Factory dashboard. Zero dependencies.
// Reads projects/ (or $FACTORY_HOME/projects) and serves a live board on http://127.0.0.1:4317.
// Its one write: answering a spec/plan review gate (POST /api/review), done through scripts/factory.mjs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { nextAction } from '../scripts/factory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../scripts/factory.mjs');
const SAFE = /^[A-Za-z0-9][\w.-]*$/;
const DOC = /^(?:(?:issue|spec|plan)\.md|stages\/\d+\/[\w.-]+\.md)$/;

const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const dirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((x) => SAFE.test(x) && fs.statSync(path.join(d, x)).isDirectory()).sort() : []);

function listDocs(featureDir) {
  const docs = ['issue.md', 'spec.md', 'plan.md'].filter((d) => fs.existsSync(path.join(featureDir, d)));
  const stagesDir = path.join(featureDir, 'stages');
  for (const n of dirs(stagesDir)) {
    for (const f of fs.readdirSync(path.join(stagesDir, n)).filter((x) => x.endsWith('.md')).sort()) docs.push(`stages/${n}/${f}`);
  }
  return docs;
}

function readEvents(projectDir, limit) {
  const file = path.join(projectDir, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .slice(-limit)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

export function snapshot(home) {
  const root = path.join(home, 'projects');
  const projects = [];
  let events = [];
  for (const name of dirs(root)) {
    const pdir = path.join(root, name);
    if (!fs.existsSync(path.join(pdir, 'config.json'))) continue;
    let config;
    try {
      config = readJSON(path.join(pdir, 'config.json'));
    } catch {
      continue;
    }
    const features = [];
    for (const id of dirs(path.join(pdir, 'features'))) {
      const fdir = path.join(pdir, 'features', id);
      if (!fs.existsSync(path.join(fdir, 'state.json'))) continue;
      try {
        const state = readJSON(path.join(fdir, 'state.json'));
        features.push({ ...state, next: nextAction(config, state), docs: listDocs(fdir) });
      } catch {
        /* partially written; skip this tick */
      }
    }
    projects.push({
      name,
      repo: { slug: config.repo?.slug, baseBranch: config.repo?.baseBranch, path: config.repo?.path, host: config.repo?.host },
      setupComplete: !!config.setupComplete,
      maxRounds: config.review?.maxRounds ?? 3,
      lenses: config.review?.lenses ?? [],
      features,
    });
    events = events.concat(readEvents(pdir, 200));
  }
  events.sort((a, b) => (a.at < b.at ? 1 : -1));
  return { generatedAt: new Date().toISOString(), projects, events: events.slice(0, 150) };
}

function readDoc(home, project, feature, doc) {
  if (!SAFE.test(project || '') || !SAFE.test(feature || '') || !DOC.test(doc || '')) return null;
  const base = path.resolve(home, 'projects', project, 'features', feature);
  const file = path.resolve(base, doc);
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

// Human review gates the dashboard can answer. Each decision is the same CLI calls /factory-approve makes
// before it launches an agent; the agent work itself happens on the next /factory-next.
const GATES = {
  spec: { status: 'awaiting_spec_approval', approve: 'planning', revise: 'spec_drafting' },
  plan: { status: 'awaiting_plan_approval', approve: 'building', revise: 'planning' },
};
const MAX_BODY = 64 * 1024;

const cli = (home, args) =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, FACTORY_HOME: home } }, (err, _stdout, stderr) =>
      err ? reject(new Error(String(stderr).replace(/^error:\s*/, '').trim() || err.message)) : resolve(),
    );
  });

export async function review(home, { project, feature, gate, decision, text }) {
  const g = GATES[gate];
  if (!SAFE.test(project || '') || !SAFE.test(feature || '') || !g || !['approve', 'revise'].includes(decision)) return [400, 'bad request'];
  text = typeof text === 'string' ? text.trim() : '';
  if (decision === 'revise' && !text) return [400, 'feedback text is required to request changes'];
  const stateFile = path.join(home, 'projects', project, 'features', feature, 'state.json');
  if (!fs.existsSync(stateFile)) return [404, 'unknown feature'];
  const { status } = readJSON(stateFile);
  if (status !== g.status) return [409, `this ${gate} is no longer waiting for review (status: ${status})`];
  if (decision === 'approve') {
    await cli(home, ['feature:status', project, feature, g.approve, '--note', `${gate} approved (dashboard)`]);
  } else {
    await cli(home, ['feature:feedback', project, feature, '--gate', gate, '--text', text]);
    await cli(home, ['feature:status', project, feature, g.revise, '--note', `${gate} changes requested (dashboard)`]);
  }
  return [200, null];
}

// The server is bound to 127.0.0.1, but a page on any other site can still send requests to it.
// Writes must come from this dashboard: right Host (blocks DNS rebinding), same Origin, JSON body (forces a CORS preflight we never answer).
function trustedWrite(req) {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  return (req.headers['content-type'] || '').split(';')[0].trim() === 'application/json';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer(home) {
  const indexHtml = () => fs.readFileSync(path.join(HERE, 'index.html'));
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
    const json = (code, obj) => send(code, 'application/json', JSON.stringify(obj));
    if (req.method === 'POST' && url.pathname === '/api/review') {
      if (!trustedWrite(req)) return json(403, { error: 'forbidden' });
      try {
        const [code, error] = await review(home, JSON.parse(await readBody(req)));
        return json(code, error ? { error } : { ok: true });
      } catch (err) {
        return json(err instanceof SyntaxError ? 400 : 500, { error: err instanceof SyntaxError ? 'invalid JSON' : err.message });
      }
    }
    if (req.method !== 'GET') return send(405, 'text/plain', 'method not allowed');
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', indexHtml());
    if (url.pathname === '/api/state') return send(200, 'application/json', JSON.stringify(snapshot(home)));
    if (url.pathname === '/api/doc') {
      const text = readDoc(home, url.searchParams.get('project'), url.searchParams.get('feature'), url.searchParams.get('doc'));
      return text === null ? send(404, 'text/plain', 'not found') : send(200, 'text/plain; charset=utf-8', text);
    }
    send(404, 'text/plain', 'not found');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.env.FACTORY_HOME ? path.resolve(process.env.FACTORY_HOME) : path.resolve(HERE, '..');
  const port = Number(process.env.PORT) || 4317;
  createServer(home).listen(port, '127.0.0.1', () => {
    console.log(`Software Factory dashboard → http://localhost:${port}  (reading ${path.join(home, 'projects')})`);
  });
}
