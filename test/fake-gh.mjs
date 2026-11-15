#!/usr/bin/env node
// Minimal stand-in for the GitHub CLI used by the tests.
// PR state lives in the JSON file named by GH_STUB_STATE.
import fs from 'node:fs';

const file = process.env.GH_STUB_STATE;
const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { prs: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(db, null, 2));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const find = (ref) => db.prs.find((p) => String(p.number) === String(ref) || p.head === ref);

if (args[0] === 'pr' && args[1] === 'view') {
  const pr = find(args[2]);
  if (!pr) {
    process.stderr.write('no pull requests found\n');
    process.exit(1);
  }
  const fields = (flag('json') || '').split(',');
  const outObj = {};
  for (const k of fields) outObj[k] = pr[k] ?? null;
  process.stdout.write(JSON.stringify(outObj));
} else if (args[0] === 'pr' && args[1] === 'create') {
  const number = db.prs.length + 1;
  db.prs.push({
    number,
    url: `https://github.com/${flag('repo')}/pull/${number}`,
    state: 'OPEN',
    head: flag('head'),
    base: flag('base'),
    title: flag('title'),
    body: fs.readFileSync(flag('body-file'), 'utf8'),
    mergedAt: null,
    reviewDecision: '',
    reviews: [],
    comments: [],
    inline: [],
  });
  save();
  process.stdout.write(`https://github.com/${flag('repo')}/pull/${number}\n`);
} else if (args[0] === 'api') {
  const m = args[1].match(/pulls\/(\d+)\/comments/);
  process.stdout.write(JSON.stringify(m ? find(m[1])?.inline ?? [] : []));
} else {
  process.stderr.write(`fake gh: unsupported ${args.join(' ')}\n`);
  process.exit(1);
}
