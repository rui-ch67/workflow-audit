// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUBRIC, PILLARS, RUBRIC_VERSION, collect, score, render, sessionStats, verifyEvidence, parseFrontmatter } from '../scripts/audit.mjs';
import { FIXTURES } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'audit.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-audit-'));

function make(name, extra = {}) {
  const dir = path.join(TMP, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [p, c] of Object.entries({ ...FIXTURES[name], ...extra })) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  return dir;
}
const run = (name, extra) => { const dir = make(name, extra); return { dir, f: collect(dir, { noGit: true }) }; };
const pts = (f, id) => (f.d[id].applies ? f.d[id].points : 'n/a');

test('rubric: each pillar totals 10, docs list every criterion', () => {
  for (const p of Object.keys(PILLARS)) assert.equal(RUBRIC.filter((c) => c.pillar === p).reduce((a, c) => a + c.max, 0), 10, p);
  const rubricMd = fs.readFileSync(path.join(HERE, '..', 'references', 'rubric.md'), 'utf8');
  const judgingMd = fs.readFileSync(path.join(HERE, '..', 'references', 'judging.md'), 'utf8');
  for (const c of RUBRIC) assert.ok(rubricMd.includes(`| ${c.id} | ${c.max} |`), `rubric.md row for ${c.id}`);
  for (const c of RUBRIC.filter((r) => r.kind === 'J')) assert.ok(judgingMd.includes(`## ${c.id} `), `judging.md anchors for ${c.id}`);
  assert.ok(rubricMd.startsWith(`# Rubric v${RUBRIC_VERSION}`));
});

test('solo app: tier S, strong verification, heavy setup not required', () => {
  const { f } = run('solo-app');
  assert.equal(f.profile.tier, 'S');
  assert.equal(f.profile.kind, 'code');
  assert.equal(pts(f, 'P1.a'), 2);
  assert.equal(pts(f, 'P1.b'), 2);
  assert.equal(pts(f, 'P1.f'), 1);
  assert.equal(pts(f, 'P3.a'), 3);
  assert.equal(pts(f, 'P3.b'), 2);
  assert.equal(pts(f, 'P3.c'), 2);
  assert.equal(pts(f, 'P3.d'), 1);
  for (const id of ['P2.a', 'P2.c', 'P3.e', 'P3.f', 'P4.b', 'P4.d', 'P4.f', 'P5.a']) assert.equal(pts(f, id), 'n/a', id);
  assert.equal(f.j['P1.g'].applies, false);
  assert.equal(f.j['P4.a'].applies, true);
});

test('monorepo: tier L, tree dump, broken command, no package context', () => {
  const { f } = run('monorepo');
  assert.equal(f.profile.monorepo, true);
  assert.equal(f.profile.tier, 'L');
  assert.equal(pts(f, 'P1.c'), 0);
  assert.equal(pts(f, 'P1.f'), 0);
  assert.match(f.d['P1.f'].note, /npm run deploy/);
  assert.equal(pts(f, 'P2.e'), 0);
  assert.equal(pts(f, 'P3.e'), 0);
});

test('monorepo: nested CLAUDE.md per package earns P2.e', () => {
  const { f } = run('monorepo', { 'packages/web/CLAUDE.md': '# web\n', 'packages/api/CLAUDE.md': '# api\n' });
  assert.equal(pts(f, 'P2.e'), 2);
});

test('pnpm-workspace.yaml without packages is not a monorepo', () => {
  const { f } = run('solo-app', { 'pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - esbuild\n' });
  assert.equal(f.profile.monorepo, false);
});

test('docs-only: content checks replace tests, no stack checks', () => {
  const { f } = run('docs-only');
  assert.equal(f.profile.kind, 'docs');
  assert.equal(pts(f, 'P3.a'), 2);
  assert.equal(pts(f, 'P3.b'), 'n/a');
  assert.equal(pts(f, 'P2.f'), 2);
});

test('empty project: scores without crashing, mostly n/a', () => {
  const { dir, f } = run('empty');
  assert.equal(f.profile.kind, 'empty');
  assert.equal(pts(f, 'P1.a'), 0);
  const { snapshot } = score(dir, f, null);
  assert.equal(snapshot.pillars.P1.score, 0);
  assert.equal(snapshot.pillars.P4.score, null);
});

test('.claude/worktrees copies are not scanned', () => {
  const { f } = run('solo-app', { '.claude/worktrees/wt1/src/x.js': 'x\n', '.claude/worktrees/wt1/CLAUDE.md': '# copy\n' });
  assert.equal(f.profile.source_files, 5);
  assert.deepEqual(f.facts.nested_claude_md, []);
});

test('AGENTS.md alone earns half of P1.a', () => {
  const { f } = run('empty', { 'AGENTS.md': '# agents\n' });
  assert.equal(pts(f, 'P1.a'), 1);
});

test('over-engineered small repo: flagged on agents, skills, enforcement', () => {
  const { f } = run('over-engineered-small');
  assert.equal(f.profile.tier, 'S');
  assert.equal(pts(f, 'P1.d'), 0);
  assert.match(f.d['P1.d'].note, /secrets/);
  assert.equal(pts(f, 'P4.b'), 0);
  assert.equal(pts(f, 'P5.b'), 0);
  assert.equal(pts(f, 'P5.c'), 0);
  assert.equal(pts(f, 'P5.d'), 0);
  assert.equal(pts(f, 'P5.f'), 1);
  assert.equal(f.j['P4.c'].applies, true);
});

test('deny rule backs the .env rule', () => {
  const { f } = run('over-engineered-small', { '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Read(./.env)'] } }) });
  assert.equal(pts(f, 'P1.d'), 1);
});

test('verify hook counts only when its command exists', () => {
  const good = run('solo-app', { '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'npm run lint' }] }] } }) }).f;
  assert.equal(pts(good, 'P3.e'), 1);
  const bad = run('solo-app', { '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '.claude/hooks/check.sh' }] }] } }) }).f;
  assert.equal(pts(bad, 'P3.e'), 0);
});

test('frontmatter parser handles lists, folded text and booleans', () => {
  const { fm } = parseFrontmatter('---\nname: x\ndescription: >\n  one\n  two\ntools:\n  - Read\n  - Grep\ndisable-model-invocation: true\n---\nbody');
  assert.equal(fm.description, 'one two');
  assert.deepEqual(fm.tools, ['Read', 'Grep']);
  assert.equal(fm['disable-model-invocation'], true);
});

test('evidence: exact quote passes, wrong quote and bad lines fail', () => {
  const { dir } = run('solo-app');
  assert.equal(verifyEvidence(dir, { path: 'CLAUDE.md', lines: [4, 4], quote: '`npm test` runs the unit tests' }), null);
  assert.equal(verifyEvidence(dir, { path: 'CLAUDE.md', lines: [2, 2], quote: 'npm test runs' }), null, '±2 line window and backticks ignored');
  assert.match(verifyEvidence(dir, { path: 'CLAUDE.md', lines: [4, 4], quote: 'tests are optional' }), /not found/);
  assert.match(verifyEvidence(dir, { path: 'CLAUDE.md', lines: [40, 41], quote: 'x' }), /outside/);
  assert.match(verifyEvidence(dir, { path: '../x', lines: [1, 1], quote: 'x' }), /outside project/);
});

test('score: verified, unverified, stale and pending judgements', () => {
  const { dir, f } = run('solo-app');
  const h = (id) => f.j[id].input_hash;
  const judgements = {
    rubric_version: RUBRIC_VERSION,
    items: {
      'P1.e': { grade: 2, input_hash: h('P1.e'), evidence: [{ path: 'CLAUDE.md', lines: [8, 8], quote: 'never use local time' }] },
      'P4.a': { grade: 3, input_hash: h('P4.a'), evidence: [{ path: 'CLAUDE.md', lines: [1, 1], quote: 'made up text' }] },
      'P5.g': { grade: 1, input_hash: 'stale' },
    },
  };
  const { snapshot, warnings } = score(dir, f, judgements);
  const crit = (id) => Object.values(snapshot.pillars).flatMap((p) => p.criteria).find((c) => c.id === id);
  assert.equal(crit('P1.e').status, 'ok');
  assert.equal(crit('P1.e').points, 2);
  assert.equal(crit('P4.a').status, 'unverified');
  assert.equal(crit('P4.a').points, 0);
  assert.equal(crit('P5.g').status, 'pending');
  assert.equal(snapshot.pillars.P4.confidence, 'low');
  assert.ok(warnings.some((w) => w.startsWith('P5.g pending')));
  assert.equal(snapshot.pillars.P1.score, 10);
});

test('score is identical on re-run with the same inputs', () => {
  const { dir } = run('solo-app');
  const a = score(dir, collect(dir, { noGit: true }), null).snapshot;
  const b = score(dir, collect(dir, { noGit: true }), null).snapshot;
  for (const p of Object.keys(PILLARS)) assert.equal(a.pillars[p].score, b.pillars[p].score);
  assert.deepEqual(collect(dir, { noGit: true }).j, collect(dir, { noGit: true }).j);
});

test('render: single column first, before/after later, ascii, rubric mismatch', () => {
  const { dir, f } = run('solo-app');
  const s1 = score(dir, f, null).snapshot;
  const first = render(s1, s1, { ascii: true });
  assert.ok(!first.includes('Before'));
  assert.match(first, /Verification\s+#+\.*\s+\d/);
  const s2 = { ...s1, created_at: '2099-01-01T00:00:00.000Z', pillars: { ...s1.pillars, P3: { ...s1.pillars.P3, score: 10 } } };
  const both = render(s1, s2);
  assert.match(both, /Before/);
  assert.match(both, /█/);
  const old = { ...s1, rubric_version: '0.9.0', created_at: '2000-01-01T00:00:00.000Z' };
  assert.match(render(old, s2), /no delta/);
});

test('sessions: counts Task and Agent calls, groups parallel calls by message id', () => {
  const root = make('solo-app');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-home-'));
  const dir = path.join(home, '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const call = (id, name, desc) => JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'tool_use', name, input: { description: desc } }] } });
  const user = JSON.stringify({ type: 'user', message: { content: 'hi' } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [user, call('m1', 'Agent', 'run tests'), call('m1', 'Agent', 'search api')].join('\n'));
  fs.writeFileSync(path.join(dir, 's2.jsonl'), [user, call('m2', 'Task', 'review diff')].join('\n'));
  fs.writeFileSync(path.join(dir, 's3.jsonl'), [user, JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } })].join('\n'));
  const st = sessionStats(root, home);
  assert.equal(st.recognised, 3);
  assert.equal(st.with_subagents, 2);
  assert.equal(st.parallel_messages, 1);
  assert.equal(st.clear_commands, 1);
  assert.equal(st.purposes.review, 1);
  const f = collect(root, { noGit: true, sessions: true, home });
  assert.equal(pts(f, 'P4.f'), 2);
});

test('CLI: collect, score and render write only .claude/audits', () => {
  const dir = make('solo-app');
  const before = new Set(fs.readdirSync(dir));
  const cli = (...args) => execFileSync(process.execPath, [SCRIPT, ...args, '--root', dir, '--no-git'], { encoding: 'utf8' });
  assert.match(cli('collect'), /Judgements to make/);
  const out = cli('score', '--ascii');
  assert.match(out, /Saved baseline/);
  assert.match(out, /Overall/);
  assert.match(cli('render'), /workflow-audit v/);
  const audits = fs.readdirSync(path.join(dir, '.claude', 'audits')).sort();
  assert.deepEqual(audits, ['baseline.json', 'facts.json', 'latest.json']);
  const after = new Set(fs.readdirSync(dir));
  assert.deepEqual([...after].filter((x) => !before.has(x)), ['.claude']);
  const snap = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'audits', 'latest.json'), 'utf8'));
  assert.ok(!JSON.stringify(snap.facts).includes('never use local time'), 'no file contents in snapshot facts');
});
