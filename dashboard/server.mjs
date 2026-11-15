#!/usr/bin/env node
// Local Software Factory dashboard. Zero dependencies.
// Reads projects/ (or $FACTORY_HOME/projects) and serves a live board on http://127.0.0.1:4317
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextAction } from '../scripts/factory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

export function createServer(home) {
  const indexHtml = () => fs.readFileSync(path.join(HERE, 'index.html'));
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
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
