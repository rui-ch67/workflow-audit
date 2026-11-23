#!/usr/bin/env node
// workflow-audit: deterministic collector, scorer and renderer.
// Node >= 18, standard library only. Read-only on the project except .claude/audits/.
//
//   node audit.mjs collect [--root DIR] [--sessions] [--no-git]
//   node audit.mjs score   [--root DIR] [--rebaseline] [--history] [--ascii]
//   node audit.mjs render  [--root DIR] [--ascii]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RUBRIC_VERSION = '1.1.0';
export const SCHEMA = 'workflow-audit/1';
const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILES = 20000;
const TIME_BUDGET_MS = 10000;
const MAX_READ = 1_000_000;
const BUDGET = { S: 1500, M: 3000, L: 5000 };

// ---------------------------------------------------------------- rubric

export const PILLARS = {
  P1: 'Context',
  P2: 'Retrieval',
  P3: 'Verification',
  P4: 'Orchestration',
  P5: 'Reuse',
};

export const RUBRIC = [
  ['P1.a', 2, 'D', 'Root CLAUDE.md exists'],
  ['P1.b', 2, 'D', 'Startup context within tier budget'],
  ['P1.c', 1, 'D', 'Not a file dump'],
  ['P1.d', 1, 'D', 'Enforceable rules backed by hook or deny rule'],
  ['P1.e', 2, 'J', 'Content: non-obvious commands, gotchas, constraints'],
  ['P1.f', 1, 'D', 'No broken path or command references'],
  ['P1.g', 1, 'J', 'Handoff convention'],
  ['P2.a', 2, 'D', 'Routing map exists'],
  ['P2.b', 1, 'J', 'Routing map is short'],
  ['P2.c', 2, 'D', 'Imported docs at most half of startup context'],
  ['P2.d', 1, 'J', 'Linked docs each cover one topic'],
  ['P2.e', 2, 'D', 'Package-level context in monorepo'],
  ['P2.f', 2, 'D', 'Low doc fragmentation'],
  ['P3.a', 3, 'D', 'Tests (or content checks) exist and run'],
  ['P3.b', 2, 'D', 'Lint/typecheck config per language'],
  ['P3.c', 2, 'D', 'Verify commands documented for Claude'],
  ['P3.d', 1, 'D', 'CI or pre-commit runs checks'],
  ['P3.e', 1, 'D', 'Hook runs an existing verify command'],
  ['P3.f', 1, 'D', 'Deny rules for secrets and destructive commands'],
  ['P4.a', 3, 'J', 'Agent setup fits project scale'],
  ['P4.b', 1, 'D', 'Agents restrict tools'],
  ['P4.c', 1, 'J', 'Agent descriptions state purpose'],
  ['P4.d', 2, 'D', 'Read-only agents set a cheaper model'],
  ['P4.e', 1, 'J', 'Independent vs dependent work stated'],
  ['P4.f', 2, 'D', 'Session evidence of subagent use'],
  ['P5.a', 3, 'D', 'Valid skills/commands with real bodies'],
  ['P5.b', 1, 'D', 'Lean skill descriptions'],
  ['P5.c', 1, 'D', 'Side-effect skills not model-invoked'],
  ['P5.d', 1, 'D', 'Bundled scripts use ${CLAUDE_SKILL_DIR}'],
  ['P5.e', 1, 'J', 'Skill steps clear and complete'],
  ['P5.f', 1, 'D', 'Side-effect workflows captured'],
  ['P5.g', 1, 'J', 'Other repeatable work captured'],
  ['P5.h', 1, 'D', 'No duplicate or clashing skill names'],
].map(([id, max, kind, title]) => ({ id, max, kind, title, pillar: id.slice(0, 2) }));

// ---------------------------------------------------------------- helpers

const DENY_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', '.venv', 'venv', 'target', '.next',
  '.nuxt', 'out', 'coverage', '__pycache__', '.turbo', '.cache', '.gradle', '.idea',
  '.pytest_cache', '.mypy_cache', 'Pods', 'DerivedData', '.svelte-kit', '.parcel-cache',
  '.vercel', '.expo', '.dart_tool',
]);

const LANG_EXT = {
  js: ['.js', '.mjs', '.cjs', '.jsx', '.vue', '.svelte'],
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  python: ['.py'], go: ['.go'], rust: ['.rs'], java: ['.java'], kotlin: ['.kt', '.kts'],
  csharp: ['.cs'], swift: ['.swift'], ruby: ['.rb'], php: ['.php'],
  c: ['.c', '.h', '.cpp', '.cc', '.hpp'], dart: ['.dart'], scala: ['.scala'],
  elixir: ['.ex', '.exs'],
};
const EXT_LANG = Object.fromEntries(Object.entries(LANG_EXT).flatMap(([l, xs]) => xs.map((x) => [x, l])));
const IMPLICIT_CHECK_LANGS = new Set(['go', 'rust', 'java', 'kotlin', 'csharp', 'swift', 'c', 'dart', 'scala', 'elixir']);
const KNOWN_TOOLS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'deno', 'node', 'make', 'just', 'pytest', 'ruff',
  'black', 'mypy', 'pyright', 'eslint', 'prettier', 'biome', 'tsc', 'cargo', 'go', 'gofmt',
  'rustfmt', 'uv', 'uvx', 'poetry', 'gradle', 'gradlew', 'mvn', 'mvnw', 'dotnet', 'rubocop',
  'bundle', 'composer', 'phpstan', 'swiftlint', 'ktlint', 'markdownlint', 'markdownlint-cli2',
  'lychee', 'vale', 'cspell', 'codespell', 'pre-commit', 'lefthook',
]);
const BUILTIN_COMMANDS = new Set([
  'help', 'clear', 'compact', 'init', 'config', 'model', 'review', 'memory', 'cost', 'status',
  'doctor', 'login', 'logout', 'mcp', 'permissions', 'agents', 'hooks', 'resume', 'exit',
  'context', 'plugin', 'skills', 'add-dir', 'bug', 'export',
]);
const SIDE_EFFECT_NAME = /(deploy|ship|release|publish|migrat|delete|drop|destroy|push|rollback)/i;
const SIDE_EFFECT_WORKFLOW = /(deploy|release|publish|migrat|ship)/i;
const FILE_EXT = /[\w-]\.(md|mdx|txt|rst|json|jsonc|ya?ml|toml|ini|env|lock|[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kts?|cs|swift|rb|php|c|h|cc|cpp|hpp|dart|scala|exs?|sh|bash|ps1|sql|prisma|graphql|css|scss|html|xml|gradle|plist|xcconfig|pbxproj|storyboard|png|svg|jpe?g|pdf)$/i;
const SCRIPT_EXT = new Set(['.sh', '.bash', '.py', '.mjs', '.js', '.cjs', '.ts', '.ps1', '.rb']);

const toPosix = (p) => p.split(path.sep).join('/');
const rel = (root, p) => toPosix(path.relative(root, p));
const within = (root, p) => p === root || p.startsWith(root + path.sep);
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const splitLines = (t) => t.split(/\r?\n/);
const nonEmptyCount = (t) => splitLines(t).filter((l) => l.trim()).length;
const approxTokens = (t) => Math.ceil(t.length / 4);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round1 = (n) => Math.round(n * 10) / 10;

function readText(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_READ) return null;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return null;
    return buf.toString('utf8').replace(/^﻿/, '');
  } catch { return null; }
}

function readJson(abs) {
  const t = readText(abs);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function walkDir(dir, pred) {
  const out = [];
  if (!isDir(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && pred(p)) out.push(p);
    }
  }
  return out.sort();
}

const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2');

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fm: null, body: text };
  const fm = {};
  let key = null;
  let block = false;
  for (const line of splitLines(m[1])) {
    if (block) {
      if (/^\s+\S/.test(line) || !line.trim()) { fm[key] = (fm[key] ? fm[key] + ' ' : '') + line.trim(); continue; }
      block = false;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      let v = kv[2].trim();
      if (/^[>|][-+]?$/.test(v)) { fm[key] = ''; block = true; continue; }
      if (v === '') { fm[key] = []; continue; }
      if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
      else v = unquote(v);
      if (v === 'true') v = true; else if (v === 'false') v = false;
      fm[key] = v;
      continue;
    }
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && key && Array.isArray(fm[key])) { fm[key].push(unquote(li[1].trim())); continue; }
    if (/^\s+\S/.test(line) && key && typeof fm[key] === 'string') fm[key] += ' ' + line.trim();
  }
  for (const k of Object.keys(fm)) if (Array.isArray(fm[k]) && fm[k].length === 0) fm[k] = '';
  return { fm, body: text.slice(m[0].length) };
}

// Split markdown into prose lines and fenced code blocks.
export function mdParse(text) {
  const prose = [];
  const blocks = [];
  let cur = null;
  splitLines(text).forEach((l, i) => {
    const t = l.trim();
    if (cur) {
      if (t.startsWith(cur.fence) && t.replace(/[`~]/g, '') === '') { blocks.push(cur); cur = null; } else cur.lines.push(l);
      return;
    }
    const f = t.match(/^(```+|~~~+)\s*([\w+-]*)/);
    if (f) { cur = { fence: f[1], lang: (f[2] || '').toLowerCase(), start: i + 1, lines: [] }; return; }
    prose.push({ n: i + 1, line: l });
  });
  if (cur) blocks.push(cur);
  return { prose, blocks };
}

// ---------------------------------------------------------------- file inventory

function listFiles(root, { noGit }) {
  const start = Date.now();
  let partial = false;
  let files = null;
  let source = 'walk';
  if (!noGit) {
    try {
      const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
        cwd: root, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'],
      });
      files = out.toString('utf8').split('\0').filter(Boolean);
      source = 'git';
    } catch { files = null; }
  }
  if (!files) {
    files = [];
    const stack = [''];
    outer: while (stack.length) {
      const d = stack.pop();
      let ents;
      try { ents = fs.readdirSync(path.join(root, d), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (files.length >= MAX_FILES || Date.now() - start > TIME_BUDGET_MS) { partial = true; break outer; }
        const r = d ? `${d}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!DENY_DIRS.has(e.name) && r !== '.claude/worktrees') stack.push(r); } else if (e.isFile()) files.push(r);
      }
    }
  }
  const selfRel = rel(root, SELF_DIR);
  const selfInside = selfRel && !selfRel.startsWith('..') && !path.isAbsolute(selfRel);
  files = files.filter((f) => !f.startsWith('.claude/audits/') && !f.startsWith('.claude/worktrees/')
    && !(selfInside && (f === selfRel || f.startsWith(selfRel + '/')))
    && !f.split('/').some((s) => DENY_DIRS.has(s)));
  if (files.length > MAX_FILES) { files = files.slice(0, MAX_FILES); partial = true; }
  return { files: files.sort(), partial, source };
}

function gitInfo(root, noGit) {
  if (noGit) return { head: null, dirty: null, contributors_90d: null };
  const run = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  try {
    const head = run(['rev-parse', '--short', 'HEAD']);
    const dirty = run(['status', '--porcelain']).length > 0;
    const authors = new Set(run(['log', '--since=90.days', '--format=%ae']).split('\n').filter(Boolean));
    return { head, dirty, contributors_90d: authors.size };
  } catch { return { head: null, dirty: null, contributors_90d: null }; }
}

// ---------------------------------------------------------------- context files

function findImports(text) {
  const res = [];
  for (const { n, line } of mdParse(text).prose) {
    const stripped = line.replace(/`[^`]*`/g, '');
    for (const m of stripped.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.-][\w./-]*)/g)) {
      const p = m[1].replace(/[.,;:)]+$/, '');
      if (/[/.]/.test(p)) res.push({ p, n });
    }
  }
  return res;
}

function loadContext(root) {
  const rootFiles = ['CLAUDE.md', '.claude/CLAUDE.md'].filter((c) => exists(path.join(root, c)));
  const loaded = [];
  const seen = new Set();
  let externalImports = 0;
  const visit = (abs, depth, via) => {
    if (seen.has(abs) || depth > 5) return;
    const text = readText(abs);
    if (text == null) return;
    seen.add(abs);
    loaded.push({ path: rel(root, abs), abs, text, tokens: approxTokens(text), via });
    for (const im of findImports(text)) {
      if (im.p.startsWith('~/') || path.isAbsolute(im.p)) { externalImports++; continue; }
      const target = path.resolve(path.dirname(abs), im.p);
      if (!within(root, target)) { externalImports++; continue; }
      // CLAUDE.md -> @AGENTS.md is the recommended alias pattern: count it as root, not an import.
      const alias = via === 'root' && rel(root, target) === 'AGENTS.md';
      if (exists(target) && !isDir(target)) visit(target, depth + 1, alias ? 'root' : 'import');
    }
  };
  for (const f of rootFiles) visit(path.join(root, f), 0, 'root');
  const rules = [];
  for (const abs of walkDir(path.join(root, '.claude', 'rules'), (p) => p.endsWith('.md'))) {
    const t = readText(abs);
    if (t == null) continue;
    const { fm } = parseFrontmatter(t);
    const paths = fm && fm.paths ? [].concat(fm.paths) : [];
    rules.push({ path: rel(root, abs), scoped: paths.length > 0, paths });
    if (!paths.length) visit(abs, 0, 'rule');
  }
  return { rootFiles, agentsMd: exists(path.join(root, 'AGENTS.md')), loaded, rules, externalImports };
}

// Path-like references in code spans, markdown links and list-item leads (prose only).
function pathRefs(text) {
  const refs = [];
  for (const { n, line } of mdParse(text).prose) {
    const cands = [];
    for (const m of line.matchAll(/`([^`\s]+)`/g)) cands.push(m[1]);
    for (const m of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) cands.push(m[1]);
    const lead = line.match(/^\s*(?:[-*+]|\d+\.)\s+\**([\w.@-]*\/[\w./@-]*)/);
    if (lead) cands.push(lead[1]);
    for (let c of cands) {
      if (/:\/\/|^mailto:|^#|[*<>{}$]|^[~/\\]|^-|^@/.test(c)) continue;
      c = c.replace(/#.*$/, '').replace(/:\d+(-\d+)?$/, '').replace(/[.,;:]+$/, '');
      if (!c || c === '.' || c === '..') continue;
      const hasExt = FILE_EXT.test(c);
      if (!c.includes('/') && !hasExt) continue;
      refs.push({ ref: c, n, hasExt, dirLike: c.endsWith('/') });
    }
  }
  return refs;
}

// ---------------------------------------------------------------- manifests & commands

function makeTargets(text, re) {
  const out = new Set();
  for (const l of splitLines(text)) {
    const m = l.match(re);
    if (m && !m[1].startsWith('.')) out.add(m[1]);
  }
  return out;
}

function collectCommands(root, files) {
  const entries = [];
  const scriptNames = new Set();
  const workflowNames = [];
  const kindOf = (name) => {
    if (/^(test|tests|test:.*|unit|e2e)$/.test(name)) return 'test';
    if (/^(lint|lint:.*|eslint)$/.test(name)) return 'lint';
    if (/^(typecheck|type-check|check-types|types|tsc|check)$/.test(name)) return 'typecheck';
    if (/^(build|compile)$/.test(name)) return 'build';
    if (/^(format|fmt|prettier)$/.test(name)) return 'format';
    return null;
  };
  for (const f of files.filter((f) => path.posix.basename(f) === 'package.json')) {
    const pkg = readJson(path.join(root, f));
    if (!pkg || typeof pkg.scripts !== 'object' || !pkg.scripts) continue;
    for (const [name, body] of Object.entries(pkg.scripts)) {
      if (name === 'test' && /no test specified/.test(String(body))) continue;
      scriptNames.add(name);
      workflowNames.push(name);
      const k = kindOf(name);
      if (k) entries.push({ kind: k, runner: 'npm', name, source: f });
    }
  }
  const mk = files.find((f) => /^(GNU)?makefile$/i.test(f));
  if (mk) {
    for (const t of makeTargets(readText(path.join(root, mk)) || '', /^([A-Za-z0-9][\w.\-/]*)\s*:(?!=)/)) {
      scriptNames.add(t); workflowNames.push(t);
      const k = kindOf(t);
      if (k) entries.push({ kind: k, runner: 'make', name: t, source: mk });
    }
  }
  const jf = files.find((f) => /^\.?justfile$/i.test(f));
  if (jf) {
    for (const t of makeTargets(readText(path.join(root, jf)) || '', /^@?([A-Za-z0-9_-]+)(?:\s+[^:=]*)?:(?!=)/)) {
      scriptNames.add(t); workflowNames.push(t);
      const k = kindOf(t);
      if (k) entries.push({ kind: k, runner: 'just', name: t, source: jf });
    }
  }
  const deno = readJson(path.join(root, 'deno.json')) || readJson(path.join(root, 'deno.jsonc'));
  if (deno && deno.tasks) for (const t of Object.keys(deno.tasks)) {
    scriptNames.add(t); workflowNames.push(t);
    const k = kindOf(t);
    if (k) entries.push({ kind: k, runner: 'deno', name: t, source: 'deno.json' });
  }
  const has = (name) => files.includes(name);
  const implicit = (kind, cmd, re, source) => entries.push({ kind, runner: 'implicit', name: cmd, re: re.source, source });
  const py = readText(path.join(root, 'pyproject.toml')) || '';
  if (py) {
    if (/\[tool\.pytest|pytest/.test(py) || files.some((f) => /(^|\/)(pytest\.ini|conftest\.py)$/.test(f))) implicit('test', 'pytest', /\bpytest\b/, 'pyproject.toml');
    if (/\[tool\.ruff/.test(py)) implicit('lint', 'ruff check', /\bruff\b/, 'pyproject.toml');
    if (/\[tool\.mypy/.test(py)) implicit('typecheck', 'mypy', /\bmypy\b/, 'pyproject.toml');
  } else if (files.some((f) => /(^|\/)(pytest\.ini|conftest\.py)$/.test(f))) implicit('test', 'pytest', /\bpytest\b/, 'pytest.ini');
  if (has('Cargo.toml')) { implicit('test', 'cargo test', /\bcargo (test|nextest)\b/, 'Cargo.toml'); implicit('lint', 'cargo clippy', /\bcargo clippy\b/, 'Cargo.toml'); }
  if (has('go.mod')) { implicit('test', 'go test ./...', /\bgo test\b/, 'go.mod'); implicit('lint', 'go vet', /\b(go vet|golangci-lint)\b/, 'go.mod'); }
  if (files.some((f) => /^build\.gradle(\.kts)?$/.test(f))) implicit('test', 'gradle test', /\bgradlew? (test|check)\b/, 'build.gradle');
  if (has('pom.xml')) implicit('test', 'mvn test', /\bmvnw? (test|verify)\b/, 'pom.xml');
  if (files.some((f) => /\.(csproj|sln)$/.test(f))) implicit('test', 'dotnet test', /\bdotnet test\b/, '*.csproj');
  const composer = readJson(path.join(root, 'composer.json'));
  if (composer && composer.scripts) for (const t of Object.keys(composer.scripts)) {
    scriptNames.add(t); workflowNames.push(t);
    const k = kindOf(t);
    if (k) entries.push({ kind: k, runner: 'composer', name: t, source: 'composer.json' });
  }
  return { entries, scriptNames, workflowNames, makeTargets: mk ? makeTargets(readText(path.join(root, mk)) || '', /^([A-Za-z0-9][\w.\-/]*)\s*:(?!=)/) : null, justTargets: jf ? makeTargets(readText(path.join(root, jf)) || '', /^@?([A-Za-z0-9_-]+)(?:\s+[^:=]*)?:(?!=)/) : null };
}

function commandDocumented(e, text) {
  if (e.runner === 'implicit') return new RegExp(e.re).test(text);
  const n = esc(e.name);
  const re = {
    npm: `\\b(npm|pnpm|yarn|bun)(\\s+run)?\\s+${n}(?![\\w:-])`,
    make: `\\bmake\\s+${n}(?![\\w-])`,
    just: `\\bjust\\s+${n}(?![\\w-])`,
    deno: `\\bdeno\\s+task\\s+${n}(?![\\w-])`,
    composer: `\\bcomposer\\s+(run(-script)?\\s+)?${n}(?![\\w-])`,
  }[e.runner];
  return new RegExp(re).test(text);
}

const PM_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'rm', 'dlx', 'exec', 'x', 'create', 'init', 'why', 'update', 'up', 'upgrade', 'outdated', 'publish', 'link', 'ci', 'audit', 'test', 't', 'start', 'run', 'pack', 'login', 'version', 'info', 'list', 'ls', 'config', 'store', 'prune', 'dedupe', 'rebuild', 'workspace', 'workspaces']);

function brokenCommandRefs(text, cmds) {
  const broken = [];
  const { prose, blocks } = mdParse(text);
  const chunks = [];
  for (const { n, line } of prose) for (const m of line.matchAll(/`([^`]+)`/g)) chunks.push({ n, s: m[1] });
  for (const b of blocks) if (/^(|sh|bash|shell|zsh|console|powershell|pwsh|ps1|cmd)$/.test(b.lang)) b.lines.forEach((s, i) => chunks.push({ n: b.start + 1 + i, s }));
  for (const { n, s } of chunks) {
    for (const m of s.matchAll(/\b(npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\s+([\w:.-]+)/g)) {
      const name = m[2];
      if (/^-/.test(name) || (!m[1].endsWith('run') && PM_BUILTINS.has(name))) continue;
      if (PM_BUILTINS.has(name) && name !== 'run') continue;
      if (!cmds.scriptNames.has(name)) broken.push({ ref: `${m[1]} ${name}`, n });
    }
    const mk = s.match(/^\s*make\s+([\w.-]+)/);
    if (mk && !(cmds.makeTargets && cmds.makeTargets.has(mk[1]))) broken.push({ ref: `make ${mk[1]}`, n });
    const jt = s.match(/^\s*just\s+([\w-]+)/);
    if (jt && !(cmds.justTargets && cmds.justTargets.has(jt[1]))) broken.push({ ref: `just ${jt[1]}`, n });
  }
  return broken;
}

// ---------------------------------------------------------------- claude config

function loadSettings(root) {
  const out = { hooks: [], deny: [], sources: [] };
  for (const name of ['settings.json', 'settings.local.json']) {
    const s = readJson(path.join(root, '.claude', name));
    if (!s) continue;
    out.sources.push(`.claude/${name}`);
    const local = name.includes('local');
    if (s.permissions && Array.isArray(s.permissions.deny)) for (const d of s.permissions.deny) out.deny.push({ rule: String(d), local });
    if (s.hooks && typeof s.hooks === 'object') {
      for (const [event, groups] of Object.entries(s.hooks)) {
        for (const g of [].concat(groups || [])) {
          const hs = g && Array.isArray(g.hooks) ? g.hooks : [g];
          for (const h of hs) if (h && typeof h.command === 'string') out.hooks.push({ event, command: h.command, local });
        }
      }
    }
  }
  return out;
}

const VERIFY_WORD = /(test|lint|format|fmt|check|typecheck|tsc|prettier|eslint|ruff|black|biome|pytest|vet|clippy|build|verify)/i;

function hookValid(cmd, root, scriptNames) {
  if (!VERIFY_WORD.test(cmd)) return false;
  const c = cmd.replace(/["']/g, ' ');
  const pm = c.match(/(\$\{?CLAUDE_PROJECT_DIR\}?[\\/]|\.\/|\.claude\/)[\w.\\/-]+/);
  if (pm) {
    const p = pm[0].replace(/^\$\{?CLAUDE_PROJECT_DIR\}?[\\/]/, '').replace(/^\.\//, '');
    return exists(path.join(root, p));
  }
  const npm = c.match(/\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/);
  if (npm) return npm[2] === 'test' || scriptNames.has(npm[2]);
  const first = c.trim().split(/\s+/)[0] || '';
  return KNOWN_TOOLS.has(path.basename(first));
}

function loadAgents(root) {
  return walkDir(path.join(root, '.claude', 'agents'), (p) => p.endsWith('.md')).map((abs) => {
    const t = readText(abs) || '';
    const { fm } = parseFrontmatter(t);
    const tools = fm && fm.tools ? (Array.isArray(fm.tools) ? fm.tools : String(fm.tools).split(',')).map((s) => s.trim()).filter(Boolean) : null;
    const writes = tools ? tools.some((x) => /^(Write|Edit|MultiEdit|NotebookEdit|Bash)(\(|$)/.test(x)) : true;
    return {
      path: rel(root, abs),
      name: (fm && fm.name) || path.basename(abs, '.md'),
      model: (fm && typeof fm.model === 'string' && fm.model) || null,
      tools_restricted: !!tools,
      read_only: !!tools && !writes,
      has_description: !!(fm && fm.description),
    };
  });
}

function loadSkills(root) {
  const out = [];
  const skillsDir = path.join(root, '.claude', 'skills');
  if (isDir(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(skillsDir, d.name);
      if (path.resolve(dir) === SELF_DIR) continue;
      const file = path.join(dir, 'SKILL.md');
      const t = readText(file);
      if (t == null) continue;
      const { fm, body } = parseFrontmatter(t);
      const name = (fm && typeof fm.name === 'string' && fm.name) || d.name;
      if (name === 'workflow-audit') continue;
      const scripts = walkDir(dir, (p) => SCRIPT_EXT.has(path.extname(p)) && path.basename(p) !== 'SKILL.md');
      out.push(skillEntry(root, file, 'skill', name, fm, body, t, scripts.length > 0, nonEmptyCount(body) >= 5 && !!(fm && fm.description)));
    }
  }
  for (const abs of walkDir(path.join(root, '.claude', 'commands'), (p) => p.endsWith('.md'))) {
    const t = readText(abs) || '';
    const { fm, body } = parseFrontmatter(t);
    const name = toPosix(path.relative(path.join(root, '.claude', 'commands'), abs)).replace(/\.md$/, '').replace(/\//g, ':');
    out.push(skillEntry(root, abs, 'command', name, fm, body, t, false, nonEmptyCount(body) >= 3));
  }
  return out;
}

function skillEntry(root, abs, type, name, fm, body, text, hasScripts, valid) {
  const desc = (fm && typeof fm.description === 'string' ? fm.description : '') + (fm && typeof fm.when_to_use === 'string' ? fm.when_to_use : '');
  return {
    path: rel(root, abs), type, name, valid,
    desc_chars: desc.length,
    side_effect: SIDE_EFFECT_NAME.test(name),
    disable_model_invocation: !!(fm && fm['disable-model-invocation'] === true),
    has_scripts: hasScripts,
    uses_skill_dir: /\$\{?CLAUDE_SKILL_DIR\}?|\$\{?CLAUDE_PLUGIN_ROOT\}?/.test(text),
    text,
  };
}

// ---------------------------------------------------------------- sessions (opt-in, counts only)

export function sessionStats(root, home) {
  const slug = root.replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(home, '.claude', 'projects', slug);
  if (!isDir(dir)) return { available: false, reason: 'no session folder for this project' };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 30);
  const st = { sessions: 0, recognised: 0, with_subagents: 0, parallel_messages: 0, clear_commands: 0, compactions: 0, purposes: { parallel: 0, isolation: 0, review: 0, other: 0 } };
  for (const { f } of files) {
    let text;
    try { if (fs.statSync(path.join(dir, f)).size > 50e6) continue; text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    st.sessions++;
    let ok = false;
    let sub = false;
    const perMessage = new Map();
    for (const l of text.split('\n')) {
      if (!l) continue;
      let o;
      try { o = JSON.parse(l); } catch { continue; }
      if (o.type === 'assistant' || o.type === 'user') ok = true;
      if (o.isCompactSummary) st.compactions++;
      if (o.isSidechain) continue;
      const c = o.message && o.message.content;
      if (o.type === 'user') {
        const s = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('') : '';
        if (s.includes('<command-name>/clear</command-name>')) st.clear_commands++;
      }
      if (o.type === 'assistant' && Array.isArray(c)) {
        for (const b of c) {
          if (!b || b.type !== 'tool_use' || (b.name !== 'Task' && b.name !== 'Agent')) continue;
          sub = true;
          const key = (o.message && o.message.id) || o.uuid;
          perMessage.set(key, (perMessage.get(key) || 0) + 1);
          const s = `${(b.input && b.input.subagent_type) || ''} ${(b.input && b.input.description) || ''}`.toLowerCase();
          if (/review|audit|verif|critique/.test(s)) st.purposes.review++;
          else if (/test|search|explor|find|locat|log|investigat|grep|research/.test(s)) st.purposes.isolation++;
          else st.purposes.other++;
        }
      }
    }
    for (const n of perMessage.values()) if (n >= 2) { st.parallel_messages++; st.purposes.parallel++; }
    if (ok) st.recognised++;
    if (sub) st.with_subagents++;
  }
  return { available: st.recognised > 0, ...st };
}

// ---------------------------------------------------------------- collect

export function collect(root, opts = {}) {
  root = path.resolve(root);
  const inv = listFiles(root, opts);
  const files = inv.files;
  const git = gitInfo(root, opts.noGit);
  const cfg = readJson(path.join(root, '.claude', 'audits', 'config.json')) || {};

  // profile
  const langCount = {};
  let sourceFiles = 0;
  for (const f of files) {
    const l = EXT_LANG[path.posix.extname(f).toLowerCase()];
    if (l) { langCount[l] = (langCount[l] || 0) + 1; sourceFiles++; }
  }
  const stacks = Object.entries(langCount).filter(([, n]) => n >= Math.max(3, sourceFiles * 0.05)).map(([l]) => l).sort();
  const pkgJson = readJson(path.join(root, 'package.json'));
  const cargo = readText(path.join(root, 'Cargo.toml')) || '';
  const pkgDirs = [...new Set(files.filter((f) => /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|pom\.xml|build\.gradle(\.kts)?)$/.test(f))
    .map((f) => path.posix.dirname(f)).filter((dd) => dd !== '.' && dd.split('/').length <= 3))];
  const pnpmWs = readText(path.join(root, 'pnpm-workspace.yaml')) || '';
  const marker = /^packages\s*:/m.test(pnpmWs) || ['turbo.json', 'nx.json', 'lerna.json', 'go.work', 'rush.json'].some((m) => files.includes(m))
    || /\[workspace\]/.test(cargo) || !!(pkgJson && pkgJson.workspaces);
  const monorepo = marker && pkgDirs.length >= 2;
  const contributors = git.contributors_90d ?? 1;
  let tier = 'M';
  if (monorepo || sourceFiles > 1500 || contributors >= 4) tier = 'L';
  else if (sourceFiles < 150 && contributors <= 1) tier = 'S';
  const tierSource = ['S', 'M', 'L'].includes(cfg.tier) ? 'config' : 'auto';
  if (tierSource === 'config') tier = cfg.tier;
  const kind = files.length === 0 ? 'empty' : sourceFiles / files.length >= 0.1 ? 'code' : 'docs';
  const profile = { tier, tier_source: tierSource, kind, monorepo, files: files.length, source_files: sourceFiles, contributors_90d: git.contributors_90d, stacks, partial: inv.partial, file_source: inv.source };

  const ctx = loadContext(root);
  const loadedText = ctx.loaded.map((l) => l.text).join('\n');
  const loadedTokens = ctx.loaded.reduce((a, l) => a + l.tokens, 0);
  const importedTokens = ctx.loaded.filter((l) => l.via === 'import').reduce((a, l) => a + l.tokens, 0);
  const rootDoc = ctx.loaded.find((l) => l.via === 'root');
  const settings = loadSettings(root);
  const cmds = collectCommands(root, files);
  const agents = loadAgents(root);
  const skills = loadSkills(root);
  const fileSet = new Set(files);
  const basenames = new Set(files.map((f) => path.posix.basename(f)));
  const ciFiles = files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$|^\.gitlab-ci\.yml$|^\.circleci\/config\.yml$|^azure-pipelines\.yml$|^Jenkinsfile$|^bitbucket-pipelines\.yml$/.test(f));
  const precommit = files.filter((f) => /^\.pre-commit-config\.yaml$|^\.husky\/|^lefthook\.ya?ml$|^\.lefthook\.ya?ml$/.test(f));

  const d = {};
  const j = {};
  const set = (id, applies, points, note) => { d[id] = { applies, points: applies ? points : 0, note }; };
  const tierML = tier !== 'S';

  // ---- P1
  if (rootDoc) set('P1.a', true, 2, `${rootDoc.path} found`);
  else if (ctx.agentsMd) set('P1.a', true, 1, 'Only AGENTS.md: Claude Code loads CLAUDE.md, so add a CLAUDE.md containing @AGENTS.md');
  else set('P1.a', true, 0, 'No CLAUDE.md');

  const budget = BUDGET[tier];
  if (!ctx.loaded.length) set('P1.b', false, 0, 'No startup context to measure');
  else set('P1.b', true, loadedTokens <= budget ? 2 : loadedTokens <= budget * 2 ? 1 : 0, `≈${loadedTokens} tok loaded at startup; budget ${budget}`);

  let treeLines = 0;
  let dumpLines = 0;
  let totalLines = 0;
  for (const l of ctx.loaded) {
    const { prose, blocks } = mdParse(l.text);
    for (const { line } of prose) {
      if (!line.trim()) continue;
      totalLines++;
      if (/[├└]──|│\s{2,}|^\s*[|`]--/.test(line)) { treeLines++; dumpLines++; continue; }
      if (/^\s*(?:[-*+]|\d+\.)?\s*`?[\w.@-]*\/[\w.@/-]*`?\s*$/.test(line) || /^\s*[-*+]\s*`?[\w.-]+\.\w{1,5}`?\s*$/.test(line)) dumpLines++;
    }
    for (const b of blocks) {
      const ne = b.lines.filter((x) => x.trim());
      totalLines += ne.length;
      const shellShort = /^(sh|bash|shell|zsh|console|powershell|pwsh|ps1|cmd|bat)$/.test(b.lang) && ne.length <= 15;
      if (shellShort) continue;
      const tl = ne.filter((x) => /[├└]──|│\s{2,}|^\s*[|`]--/.test(x)).length;
      treeLines += tl;
      dumpLines += ne.length;
    }
  }
  const dumpRatio = totalLines ? dumpLines / totalLines : 0;
  if (!ctx.loaded.length) set('P1.c', false, 0, 'No startup context');
  else set('P1.c', true, treeLines <= 15 && dumpRatio < 0.3 ? 1 : 0, `${treeLines} tree lines, ${Math.round(dumpRatio * 100)}% listings/non-shell code`);

  const hookCmds = settings.hooks.map((h) => h.command).join('\n');
  const denyText = settings.deny.map((x) => x.rule).join('\n');
  const hasPreHook = settings.hooks.some((h) => h.event === 'PreToolUse');
  const topics = [
    { topic: 'format/lint', re: /\b(format\w*|prettier|black|gofmt|rustfmt|lint\w*|eslint|ruff|biome)\b/i, backed: /(prettier|black|gofmt|rustfmt|eslint|ruff|biome|lint|format|fmt)/i.test(hookCmds) || precommit.length > 0 },
    { topic: 'secrets', re: /(\.env\b|secret|credential|api[ _-]?key|private key)/i, backed: /(env|secret|credential|key|token|pem)/i.test(denyText) || hasPreHook },
    { topic: 'destructive', re: /(rm -rf|force[- ]push|push --force|push -f\b|reset --hard|drop table)/i, backed: /(rm|push|reset|drop)/i.test(denyText) || hasPreHook },
  ];
  const mismatches = [];
  for (const l of ctx.loaded) for (const { n, line } of mdParse(l.text).prose) {
    if (!/\b(IMPORTANT|NEVER|ALWAYS|MUST|DO NOT|DON'T)\b/.test(line)) continue;
    for (const t of topics) if (t.re.test(line) && !t.backed) mismatches.push({ topic: t.topic, at: `${l.path}:${n}` });
  }
  if (!ctx.loaded.length) set('P1.d', false, 0, 'No startup context');
  else set('P1.d', true, mismatches.length ? 0 : 1, mismatches.length ? `Advice without enforcement: ${mismatches.slice(0, 3).map((m) => `${m.topic} @ ${m.at}`).join('; ')}` : 'No unenforced emphatic rules');

  const broken = [];
  const docRefs = [];
  for (const l of ctx.loaded) {
    for (const r of pathRefs(l.text)) {
      const fromFile = path.resolve(path.dirname(l.abs), r.ref);
      const fromRoot = path.resolve(root, r.ref);
      const first = r.ref.replace(/^\.\//, '').split('/')[0];
      const plausible = /^\.{1,2}\//.test(r.ref) || exists(path.join(root, first)) || r.hasExt;
      if (l.via === 'root' && (r.dirLike || /\.(md|mdx|txt|rst)$/i.test(r.ref))) docRefs.push(r.ref);
      if (!plausible) continue;
      const bare = r.ref.replace(/^\.\//, '').replace(/\/$/, '');
      const ok = exists(fromFile) || exists(fromRoot) || (!r.ref.includes('/') && basenames.has(r.ref)) || fileSet.has(bare)
        || files.some((f) => f.endsWith('/' + bare) || f.includes('/' + bare + '/'));
      if (!ok) broken.push(`${r.ref} (${l.path}:${r.n})`);
    }
    for (const b of brokenCommandRefs(l.text, cmds)) broken.push(`${b.ref} (${l.path}:${b.n})`);
  }
  if (!ctx.loaded.length) set('P1.f', false, 0, 'No startup context');
  else set('P1.f', true, broken.length ? 0 : 1, broken.length ? `${broken.length} broken: ${broken.slice(0, 4).join(', ')}` : 'All references resolve');

  // ---- P2
  const distinctDocRefs = [...new Set(docRefs)];
  if (!tierML) set('P2.a', false, 0, 'Tier S: map optional');
  else if (!rootDoc) set('P2.a', true, 0, 'No CLAUDE.md');
  else set('P2.a', true, distinctDocRefs.length >= 3 ? 2 : distinctDocRefs.length ? 1 : 0, `${distinctDocRefs.length} directory/doc pointers in ${rootDoc.path}`);

  const p2cApplies = !!ctx.loaded.length && (tierML || loadedTokens > budget);
  if (!p2cApplies) set('P2.c', false, 0, 'Tier S within budget');
  else {
    const share = loadedTokens ? importedTokens / loadedTokens : 0;
    set('P2.c', true, share <= 0.5 ? 2 : share <= 0.75 ? 1 : 0, `Imports are ${Math.round(share * 100)}% of startup context`);
  }

  const nestedClaude = files.filter((f) => /(^|\/)CLAUDE\.md$/.test(f) && f !== 'CLAUDE.md' && !f.startsWith('.claude/'));
  const scopedRules = ctx.rules.filter((r) => r.scoped);
  if (!monorepo) set('P2.e', false, 0, 'Not a monorepo');
  else {
    const covered = pkgDirs.filter((pd) => nestedClaude.some((c) => c.startsWith(pd + '/'))
      || scopedRules.some((r) => r.paths.some((p) => { const lit = String(p).split('*')[0].replace(/\/$/, ''); return lit && (pd.startsWith(lit) || lit.startsWith(pd)); })));
    const ratio = pkgDirs.length ? covered.length / pkgDirs.length : 0;
    set('P2.e', true, ratio >= 0.5 ? 2 : (covered.length || nestedClaude.length || scopedRules.length) ? 1 : 0, `${covered.length}/${pkgDirs.length} packages have nested CLAUDE.md or scoped rules`);
  }

  const mdFiles = files.filter((f) => /\.(md|mdx)$/i.test(f));
  const docs = mdFiles.filter((f) => !/^(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|AGENTS|CLAUDE)(\.[\w]+)?\.mdx?$/i.test(f)
    && !f.split('/').some((seg) => seg.startsWith('.')) && !/(^|\/)CLAUDE\.md$/.test(f));
  if (docs.length < 3) set('P2.f', true, 2, `${docs.length} docs: too few to fragment`);
  else {
    let corpus = '';
    for (const f of mdFiles.concat(ctx.loaded.map((l) => l.path))) { if (corpus.length > 4e6) break; corpus += '\n' + (readText(path.join(root, f)) || ''); }
    const bad = [];
    for (const f of docs) {
      const text = readText(path.join(root, f)) || '';
      const base = path.posix.basename(f);
      const noExt = f.replace(/\.mdx?$/i, '');
      const dirName = path.posix.dirname(f);
            const mentions = corpus.split(base).length - 1 - (text.split(base).length - 1);
      const dirLinked = dirName !== '.' && (corpus.includes(dirName + '/') || corpus.includes(`(${dirName})`));
      const linked = dirName === '.' || mentions > 0 || corpus.includes(noExt + ')') || dirLinked;
      const tiny = nonEmptyCount(text) < 10 && !/template/i.test(base);
      if (!linked || tiny) bad.push(f);
    }
    const r = bad.length / docs.length;
    set('P2.f', true, r < 0.1 ? 2 : r < 0.25 ? 1 : 0, `${bad.length}/${docs.length} docs orphaned or under 10 lines${bad.length ? `: ${bad.slice(0, 3).join(', ')}` : ''}`);
  }

  // ---- P3
  const testFiles = files.filter((f) => /(^|\/)(tests?|__tests__|spec|specs)\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
    || /_test\.(go|py)$/.test(f) || /(^|\/)test_[^/]*\.py$/.test(f) || /Tests?\.(java|kt|cs|swift)$/.test(f) || /_spec\.rb$/.test(f));
  const testCmds = cmds.entries.filter((e) => e.kind === 'test');
  const contentTools = [
    files.some((f) => /(^|\/)\.markdownlint(-cli2)?(\.[\w]+|rc)?$/.test(f)),
    files.some((f) => /(^|\/)(\.?lychee\.toml|\.markdown-link-check\.json|mlc_config\.json)$/.test(f)),
    files.some((f) => /(^|\/)(\.?cspell(\.config)?\.(json|ya?ml|js|cjs|mjs)|\.codespellrc|_?typos\.toml)$/.test(f)),
    files.some((f) => /(^|\/)\.vale\.ini$/.test(f)),
  ].filter(Boolean).length;
  if (kind === 'empty') set('P3.a', false, 0, 'Empty project');
  else if (kind === 'docs') {
    if (contentTools === 0) set('P3.a', false, 0, 'Docs project without content checks: not applicable');
    else set('P3.a', true, contentTools >= 2 ? 3 : 2, `${contentTools} content-check tool(s)`);
  } else {
    const pts = testCmds.length && testFiles.length ? 3 : testCmds.length || testFiles.length ? 1 : 0;
    set('P3.a', true, pts, `${testCmds.length ? `test command: ${testCmds[0].name}` : 'no test command'}; ${testFiles.length} test files`);
  }

  const lintCfg = {
    js: () => files.some((f) => /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?|biome\.jsonc?|\.?oxlintrc\.json|deno\.jsonc?)$/.test(f)) || !!(pkgJson && pkgJson.eslintConfig),
    ts: () => files.some((f) => /(^|\/)(tsconfig[\w.-]*\.json|eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?|biome\.jsonc?|deno\.jsonc?)$/.test(f)),
    python: () => files.some((f) => /(^|\/)(ruff\.toml|\.ruff\.toml|mypy\.ini|\.flake8|pyrightconfig\.json|\.pylintrc)$/.test(f)) || /\[tool\.(ruff|mypy|pylint|pyright|black)/.test(readText(path.join(root, 'pyproject.toml')) || ''),
    ruby: () => files.some((f) => /(^|\/)\.rubocop\.yml$/.test(f)),
    php: () => files.some((f) => /(^|\/)(phpstan\.neon(\.dist)?|psalm\.xml|\.php-cs-fixer(\.dist)?\.php|phpcs\.xml(\.dist)?)$/.test(f)),
  };
  const langs = stacks;
  if (kind !== 'code' || !langs.length) set('P3.b', false, 0, 'No code stack detected');
  else {
    const missing = langs.filter((l) => !IMPLICIT_CHECK_LANGS.has(l) && !(lintCfg[l] && lintCfg[l]()));
    const ok = langs.length - missing.length;
    set('P3.b', true, ok === langs.length ? 2 : ok >= langs.length / 2 ? 1 : 0, missing.length ? `No lint/typecheck config for: ${missing.join(', ')}` : `Checks configured for ${langs.join(', ')}`);
  }

  if (!cmds.entries.length) set('P3.c', false, 0, 'No verify commands detected');
  else {
    const testDoc = testCmds.some((e) => commandDocumented(e, loadedText));
    const others = cmds.entries.filter((e) => e.kind !== 'test');
    const otherDoc = others.some((e) => commandDocumented(e, loadedText));
    let pts;
    if (testCmds.length) pts = testDoc && (!others.length || otherDoc) ? 2 : testDoc || otherDoc ? 1 : 0;
    else pts = otherDoc ? 2 : 0;
    set('P3.c', true, pts, `test documented: ${testDoc ? 'yes' : 'no'}; other checks documented: ${otherDoc ? 'yes' : 'no'}`);
  }

  const ciWithChecks = ciFiles.filter((f) => /(test|lint|check|build|verify|ci)/i.test(readText(path.join(root, f)) || ''));
  if (kind === 'empty') set('P3.d', false, 0, 'Empty project');
  else set('P3.d', true, ciWithChecks.length || precommit.length ? 1 : 0, ciWithChecks.length || precommit.length ? `CI: ${ciWithChecks.length} workflow(s); pre-commit: ${precommit.length ? 'yes' : 'no'}` : 'No CI or pre-commit checks');

  const verifyHooks = settings.hooks.filter((h) => /^(PostToolUse|Stop|SubagentStop)$/.test(h.event));
  const validHooks = verifyHooks.filter((h) => hookValid(h.command, root, cmds.scriptNames));
  if (kind === 'empty') set('P3.e', false, 0, 'Empty project');
  else if (!tierML && !verifyHooks.length) set('P3.e', false, 0, 'Tier S: hooks optional');
  else set('P3.e', true, validHooks.length ? 1 : 0, validHooks.length ? `${validHooks.length} verify hook(s)` : verifyHooks.length ? 'Hooks found but none runs an existing verify command' : 'No PostToolUse/Stop verify hook');

  let envPresent = false;
  try { envPresent = fs.readdirSync(root).some((n) => /^\.env(\.|$)/.test(n)); } catch { /* ignore */ }
  const goodDeny = settings.deny.filter((x) => /(\.env|secret|credential|\.pem|\.key|id_rsa|rm -rf|rm:|push --force|push -f|reset --hard)/i.test(x.rule));
  if (!tierML && !envPresent) set('P3.f', false, 0, 'Tier S without .env: deny rules optional');
  else set('P3.f', true, goodDeny.length ? 1 : 0, goodDeny.length ? `${goodDeny.length} protective deny rule(s)${goodDeny.every((x) => x.local) ? ' (local settings only)' : ''}` : 'No deny rules for secrets or destructive commands');

  // ---- P4
  if (!agents.length) { set('P4.b', false, 0, 'No agents'); set('P4.d', false, 0, 'No agents'); }
  else {
    const restricted = agents.filter((a) => a.tools_restricted).length;
    set('P4.b', true, restricted === agents.length ? 1 : 0, `${restricted}/${agents.length} agents restrict tools`);
    const ro = agents.filter((a) => a.read_only);
    if (!ro.length) set('P4.d', false, 0, 'No read-only agents');
    else {
      const tiered = ro.filter((a) => a.model && a.model !== 'inherit').length;
      set('P4.d', true, tiered === ro.length ? 2 : tiered ? 1 : 0, `${tiered}/${ro.length} read-only agents set a model`);
    }
  }
  let sessions = null;
  if (opts.sessions) sessions = sessionStats(root, opts.home || os.homedir());
  if (!sessions || !sessions.available || sessions.recognised < 3) set('P4.f', false, 0, opts.sessions ? 'Too few readable sessions (need 3)' : 'Run with --sessions to score');
  else if (!tierML && !sessions.with_subagents) set('P4.f', false, 0, 'Tier S with no subagent use: fine');
  else {
    const cats = ['parallel', 'isolation', 'review'].filter((k) => sessions.purposes[k] > 0).length;
    const share = sessions.with_subagents / sessions.recognised;
    set('P4.f', true, share >= 0.3 || cats >= 2 ? 2 : sessions.with_subagents ? 1 : 0, `Subagents in ${sessions.with_subagents}/${sessions.recognised} sessions; purposes seen: ${cats}`);
  }

  // ---- P5
  const repeatable = skills.length > 0 || (tierML && (cmds.workflowNames.length >= 3 || ciFiles.length > 0));
  if (!repeatable) set('P5.a', false, 0, tierML ? 'No repeatable workflow detected' : 'Tier S without skills: scripts are enough');
  else {
    const valid = skills.filter((s) => s.valid).length;
    set('P5.a', true, valid && valid === skills.length ? 3 : valid >= skills.length / 2 && valid ? 2 : valid ? 1 : 0, skills.length ? `${valid}/${skills.length} skills/commands valid` : 'Repeatable workflows exist but no skills/commands');
  }
  const withDesc = skills.filter((s) => s.desc_chars > 0);
  if (!withDesc.length) set('P5.b', false, 0, 'No skill descriptions');
  else {
    const max = Math.max(...withDesc.map((s) => s.desc_chars));
    set('P5.b', true, max <= 400 ? 1 : max <= 1536 ? 0.5 : 0, `Longest description ${max} chars${max > 1536 ? ' (truncated at 1,536)' : ''}; total ${withDesc.reduce((a, s) => a + s.desc_chars, 0)}`);
  }
  const se = skills.filter((s) => s.side_effect);
  if (!se.length) set('P5.c', false, 0, 'No side-effect skills');
  else {
    const bad = se.filter((s) => !s.disable_model_invocation);
    set('P5.c', true, bad.length ? 0 : 1, bad.length ? `Model can auto-invoke: ${bad.map((s) => s.name).join(', ')}` : 'Side-effect skills are user-only');
  }
  const withScripts = skills.filter((s) => s.has_scripts);
  if (!withScripts.length) set('P5.d', false, 0, 'No bundled scripts');
  else {
    const bad = withScripts.filter((s) => !s.uses_skill_dir);
    set('P5.d', true, bad.length ? 0 : 1, bad.length ? `Hard-coded script paths: ${bad.map((s) => s.name).join(', ')}` : 'Scripts referenced via ${CLAUDE_SKILL_DIR}');
  }
  const ciNames = ciFiles.map((f) => path.posix.basename(f).replace(/\.ya?ml$/, ''));
  const seWorkflows = [...new Set(cmds.workflowNames.concat(ciNames).filter((n) => SIDE_EFFECT_WORKFLOW.test(n)))];
  if (!seWorkflows.length) set('P5.f', false, 0, 'No deploy/release/publish/migrate workflows');
  else {
    const hay = (loadedText + '\n' + skills.map((s) => `${s.name}\n${s.text}`).join('\n')).toLowerCase();
    const missing = seWorkflows.filter((w) => !hay.includes(w.toLowerCase()));
    set('P5.f', true, missing.length ? 0 : 1, missing.length ? `Not captured: ${missing.slice(0, 5).join(', ')}` : `${seWorkflows.length} side-effect workflow(s) captured`);
  }
  if (!skills.length) set('P5.h', false, 0, 'No skills');
  else {
    const counts = {};
    for (const s of skills) counts[s.name] = (counts[s.name] || 0) + 1;
    const dup = Object.keys(counts).filter((k) => counts[k] > 1);
    const clash = skills.filter((s) => BUILTIN_COMMANDS.has(s.name)).map((s) => s.name);
    set('P5.h', true, dup.length || clash.length ? 0 : 1, dup.length || clash.length ? `Duplicates: ${dup.join(', ') || 'none'}; built-in clashes: ${clash.join(', ') || 'none'}` : 'Names unique');
  }

  // ---- J criteria: applicability + inputs + hash
  const docMatch = (re, n) => mdFiles.filter((f) => re.test(path.posix.basename(f))).slice(0, n);
  const linkedDocs = [...new Set(ctx.loaded.filter((l) => l.via === 'import').map((l) => l.path)
    .concat(distinctDocRefs.map((r) => r.replace(/^\.\//, '')).filter((r) => fileSet.has(r))))].slice(0, 10);
  const rootPaths = ctx.loaded.filter((l) => l.via !== 'rule').map((l) => l.path);
  const jdef = {
    'P1.e': [!!rootDoc, rootPaths, 'Is the startup context focused on non-obvious commands, gotchas and constraints rather than README/code-derivable content?'],
    'P1.g': [tierML && kind !== 'empty', (rootDoc ? [rootDoc.path] : []).concat(docMatch(/(handoff|progress|status|session|notes|todo|plan|roadmap)/i, 8)), 'Is there a convention for handing work between sessions (progress/handoff doc, when to /clear)?'],
    'P2.b': [tierML && !!rootDoc, rootDoc ? [rootDoc.path] : [], 'Does the routing map point the way in a few lines rather than enumerate files?'],
    'P2.d': [p2cApplies && linkedDocs.length > 0, linkedDocs, 'Does each imported/linked doc cover one topic?'],
    'P4.a': [kind !== 'empty', agents.map((a) => a.path).concat(rootDoc ? [rootDoc.path] : []), 'Does the agent setup fit the project scale? Parallel work, output isolation and fresh-context review all count; none is right for small projects.'],
    'P4.c': [agents.length > 0, agents.map((a) => a.path), 'Does each agent description state when to use it and what it returns?'],
    'P4.e': [tierML && kind !== 'empty', (rootDoc ? [rootDoc.path] : []).concat(docMatch(/(plan|task|roadmap|backlog|contributing|workflow)/i, 8)), 'Do docs say which work is independent (parallel) and which is sequential?'],
    'P5.e': [skills.length > 0, skills.slice(0, 15).map((s) => s.path), 'Are skill/command steps clear, ordered and complete?'],
    'P5.g': [kind !== 'empty', (rootDoc ? [rootDoc.path] : []).concat(files.filter((f) => /^(package\.json|Makefile|justfile)$/i.test(f)), ciFiles.slice(0, 5)), 'Is other repeatable work (beyond side-effect workflows) captured as skills/commands where it would help?'],
  };
  for (const [id, [applies, inputs, question]] of Object.entries(jdef)) {
    const uniq = [...new Set(inputs)];
    const content = uniq.map((p) => `${p}\n${readText(path.join(root, p)) || ''}`).join('\n\0');
    const extra = id === 'P4.a' || id === 'P1.g' || id === 'P4.e' ? `${tier}|${kind}|${JSON.stringify(sessions && sessions.available ? sessions : null)}` : '';
    j[id] = { applies, inputs: uniq, question, input_hash: applies ? sha1(`${RUBRIC_VERSION}\n${extra}\n${content}`) : null };
  }

  const facts = {
    instruction_files: ctx.loaded.map((l) => ({ path: l.path, via: l.via, approx_tokens: l.tokens })),
    agents_md_only: !rootDoc && ctx.agentsMd,
    external_imports: ctx.externalImports,
    loaded_tokens: loadedTokens,
    imported_tokens: importedTokens,
    budget,
    dump: { tree_lines: treeLines, ratio: round1(dumpRatio * 100) / 100 },
    enforcement_mismatches: mismatches,
    broken_refs: broken,
    commands: cmds.entries.map(({ kind: k, runner, name, source }) => ({ kind: k, runner, name, source })),
    test_files: testFiles.length,
    ci_files: ciFiles,
    precommit: precommit.length > 0,
    settings_sources: settings.sources,
    hooks: settings.hooks.map((h) => ({ event: h.event, valid_verify: hookValid(h.command, root, cmds.scriptNames), local: h.local })),
    deny_rules: settings.deny.length,
    rules: ctx.rules.map(({ path: p, scoped }) => ({ path: p, scoped })),
    nested_claude_md: nestedClaude,
    agents,
    skills: skills.map(({ text, ...s }) => s),
    docs: docs.length,
    sessions,
  };
  return { schema: SCHEMA, rubric_version: RUBRIC_VERSION, created_at: new Date().toISOString(), collector: 'script', root: toPosix(root), git: { head: git.head, dirty: git.dirty }, profile, facts, d, j };
}

// ---------------------------------------------------------------- score

const normQuote = (s) => s.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

export function verifyEvidence(root, ev) {
  if (!ev || typeof ev.path !== 'string' || !Array.isArray(ev.lines) || typeof ev.quote !== 'string') return 'evidence needs path, lines [a,b] and quote';
  const abs = path.resolve(root, ev.path);
  if (!within(root, abs)) return `path outside project: ${ev.path}`;
  const text = readText(abs);
  if (text == null) return `cannot read ${ev.path}`;
  const ls = splitLines(text);
  const [a, b] = ev.lines;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > ls.length) return `${ev.path}: lines ${a}-${b} outside 1-${ls.length}`;
  const q = normQuote(ev.quote);
  if (!q || ev.quote.length > 200) return 'quote empty or over 200 chars';
  const win = normQuote(ls.slice(Math.max(0, a - 3), Math.min(ls.length, b + 2)).join(' '));
  return win.includes(q) ? null : `${ev.path}:${a}-${b}: quote not found`;
}

export function score(root, facts, judgements, { collector } = {}) {
  root = path.resolve(root);
  const items = (judgements && judgements.rubric_version === RUBRIC_VERSION && judgements.items) || {};
  const pillars = {};
  const warnings = [];
  for (const p of Object.keys(PILLARS)) pillars[p] = { score: null, earned: 0, applicable_max: 0, confidence: 'high', criteria: [] };
  for (const c of RUBRIC) {
    const out = { id: c.id, kind: c.kind, title: c.title, max: c.max, applies: false, points: 0, status: 'na', note: '' };
    if (c.kind === 'D') {
      const r = facts.d[c.id];
      out.applies = r.applies; out.points = r.points; out.note = r.note; out.status = r.applies ? 'ok' : 'na';
    } else {
      const r = facts.j[c.id];
      out.applies = r.applies; out.inputs = r.inputs; out.input_hash = r.input_hash;
      if (r.applies) {
        const jd = items[c.id];
        if (!jd || jd.input_hash !== r.input_hash) { out.status = 'pending'; out.note = jd ? 'inputs changed since last judgement' : 'not judged'; warnings.push(`${c.id} pending`); }
        else {
          const evs = Array.isArray(jd.evidence) ? jd.evidence : [];
          const errs = [];
          if (!Number.isInteger(jd.grade) || jd.grade < 0 || jd.grade > c.max) errs.push(`grade must be an integer 0-${c.max}`);
          if (jd.grade > 0 && !evs.length) errs.push('grade above 0 needs evidence');
          for (const ev of evs) { const e = verifyEvidence(root, ev); if (e) errs.push(e); }
          out.evidence = evs.map((ev) => ({ ...ev, verified: !verifyEvidence(root, ev) }));
          out.note = jd.note || '';
          if (errs.length) { out.status = 'unverified'; out.points = 0; out.note = `${errs.join('; ')}${out.note ? ` | ${out.note}` : ''}`; warnings.push(`${c.id} unverified: ${errs[0]}`); }
          else { out.status = 'ok'; out.points = jd.grade; }
        }
      }
    }
    const pl = pillars[c.pillar];
    pl.criteria.push(out);
    if (out.status === 'ok' || out.status === 'unverified') { pl.earned += out.points; pl.applicable_max += c.max; }
    if (out.status === 'pending') pl.confidence = 'low';
  }
  const lowAll = (collector || facts.collector) !== 'script' || facts.profile.partial;
  for (const pl of Object.values(pillars)) {
    pl.score = pl.applicable_max ? round1((10 * pl.earned) / pl.applicable_max) : null;
    if (pl.applicable_max < 4 || lowAll) pl.confidence = 'low';
  }
  const scored = Object.values(pillars).filter((pl) => pl.score != null);
  const overall = { score: scored.length ? round1(scored.reduce((a, pl) => a + pl.score, 0) / scored.length) : null, pillars_counted: scored.length };
  const snapshot = {
    schema: SCHEMA, rubric_version: RUBRIC_VERSION, created_at: facts.created_at, collector: facts.collector,
    git: facts.git, profile: facts.profile, facts: facts.facts, pillars, overall,
    recommendations: (judgements && Array.isArray(judgements.recommendations)) ? judgements.recommendations : [],
  };
  return { snapshot, warnings };
}

// ---------------------------------------------------------------- render

export function render(baseline, latest, { ascii = false } = {}) {
  const full = ascii ? '#' : '█';
  const empty = ascii ? '.' : '░';
  const bar = (s) => (s == null ? 'n/a'.padEnd(10) : full.repeat(Math.round(s)) + empty.repeat(10 - Math.round(s)));
  const num = (s) => (s == null ? '    ' : s.toFixed(1).padStart(4));
  const delta = (a, b) => (a == null || b == null ? '' : `${b - a >= 0 ? '+' : ''}${(b - a).toFixed(1)}`.padStart(5));
  const day = (s) => (s || '').slice(0, 10);
  const p = latest.profile;
  const comparable = baseline && baseline.created_at !== latest.created_at && baseline.rubric_version === latest.rubric_version;
  const out = [];
  out.push(`workflow-audit v${latest.rubric_version} · tier ${p.tier} · ${p.kind}${p.monorepo ? ' · monorepo' : ''}${comparable ? ` · ${day(baseline.created_at)} → ${day(latest.created_at)}` : ` · ${day(latest.created_at)}`}`);
  if (comparable) out.push(`${''.padEnd(16)}${'Before'.padEnd(17)}After`);
  for (const [id, label] of Object.entries(PILLARS)) {
    const L = latest.pillars[id];
    const name = `${label}${L.confidence === 'low' ? ' ~' : ''}`.padEnd(16);
    if (comparable) {
      const B = baseline.pillars[id];
      out.push(`${name}${bar(B.score)} ${num(B.score)}  ${bar(L.score)} ${num(L.score)} ${delta(B.score, L.score)}`.trimEnd());
    } else out.push(`${name}${bar(L.score)} ${num(L.score)}`.trimEnd());
  }
  const o = latest.overall.score;
  if (comparable) out.push(`${'Overall'.padEnd(16)}${''.padEnd(11)}${num(baseline.overall.score)}  ${''.padEnd(11)}${num(o)} ${delta(baseline.overall.score, o)}`.trimEnd());
  else out.push(`${'Overall'.padEnd(16)}${''.padEnd(11)}${num(o)}`.trimEnd());
  if (baseline && baseline.rubric_version !== latest.rubric_version) out.push(`Baseline uses rubric ${baseline.rubric_version}: no delta. Re-run with --rebaseline.`);
  out.push('~ = low confidence (few applicable points, pending judgements, or partial scan)');
  return out.join('\n');
}

// ---------------------------------------------------------------- CLI

function gaps(snapshot, n = 8) {
  return Object.values(snapshot.pillars).flatMap((pl) => pl.criteria)
    .filter((c) => (c.status === 'ok' || c.status === 'unverified') && c.points < c.max)
    .sort((a, b) => (b.max - b.points) - (a.max - a.points)).slice(0, n)
    .map((c) => `  -${String(c.max - c.points).padEnd(3)} ${c.id} ${c.title}: ${c.note}`);
}

function parseArgs(argv) {
  const a = { cmd: argv[0], root: process.cwd(), flags: new Set() };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--root') a.root = argv[++i];
    else if (argv[i] === '--home') a.home = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else a.flags.add(argv[i].replace(/^--/, ''));
  }
  return a;
}

function writeJson(abs, obj) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n');
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const root = path.resolve(a.root);
  const dir = a.out ? path.resolve(a.out) : path.join(root, '.claude', 'audits');
  const factsPath = path.join(dir, 'facts.json');
  const judgePath = path.join(dir, 'judgements.json');
  const latestPath = path.join(dir, 'latest.json');
  const basePath = path.join(dir, 'baseline.json');
  const ascii = a.flags.has('ascii');
  const show = (p) => (rel(root, p).startsWith('..') ? toPosix(p) : rel(root, p));

  if (a.cmd === 'collect') {
    const facts = collect(root, { sessions: a.flags.has('sessions'), noGit: a.flags.has('no-git'), home: a.home });
    writeJson(factsPath, facts);
    const prev = readJson(judgePath);
    const items = (prev && prev.rubric_version === RUBRIC_VERSION && prev.items) || {};
    const p = facts.profile;
    console.log(`Profile: tier ${p.tier} (${p.tier_source}) · ${p.kind}${p.monorepo ? ' · monorepo' : ''} · ${p.files} files, ${p.source_files} source · stacks: ${p.stacks.join(', ') || 'none'}${p.partial ? ' · PARTIAL SCAN' : ''}`);
    console.log(`Startup context ≈${facts.facts.loaded_tokens} tok (budget ${facts.facts.budget})`);
    console.log('\nDeterministic results:');
    for (const c of RUBRIC.filter((r) => r.kind === 'D')) {
      const r = facts.d[c.id];
      console.log(`  ${c.id} ${r.applies ? `${r.points}/${c.max}` : 'n/a'.padEnd(String(c.max).length + 2)}  ${r.note}`);
    }
    const todo = [];
    const cached = [];
    for (const c of RUBRIC.filter((r) => r.kind === 'J')) {
      const r = facts.j[c.id];
      if (!r.applies) continue;
      if (items[c.id] && items[c.id].input_hash === r.input_hash) cached.push(c.id);
      else todo.push({ id: c.id, max: c.max, input_hash: r.input_hash, question: r.question, inputs: r.inputs });
    }
    console.log(`\nJudgements cached (inputs unchanged): ${cached.join(', ') || 'none'}`);
    console.log(`Judgements to make: ${todo.length}`);
    for (const t of todo) console.log(`  ${t.id} (0-${t.max}) hash=${t.input_hash}\n    Q: ${t.question}\n    read: ${t.inputs.join(', ') || '(no files: judge from profile)'}`);
    console.log(`\nWrote ${show(factsPath)}. Next: write ${show(judgePath)}, then run score.`);
    return;
  }
  if (a.cmd === 'score') {
    const facts = readJson(factsPath);
    if (!facts) { console.error('No facts.json: run collect first.'); process.exit(2); }
    if (facts.rubric_version !== RUBRIC_VERSION) { console.error('facts.json is from another rubric version: run collect again.'); process.exit(2); }
    const { snapshot, warnings } = score(root, facts, readJson(judgePath));
    writeJson(latestPath, snapshot);
    let baseline = readJson(basePath);
    if (!baseline || a.flags.has('rebaseline')) { writeJson(basePath, snapshot); baseline = snapshot; console.log(`Saved baseline: ${show(basePath)}`); }
    if (a.flags.has('history')) writeJson(path.join(dir, 'history', `${snapshot.created_at.replace(/[:.]/g, '-')}.json`), snapshot);
    console.log(render(baseline, snapshot, { ascii }));
    if (warnings.length) console.log(`\nWarnings:\n${warnings.map((w) => `  ${w}`).join('\n')}`);
    const g = gaps(snapshot);
    if (g.length) console.log(`\nBiggest gaps (points lost):\n${g.join('\n')}`);
    return;
  }
  if (a.cmd === 'render') {
    const latest = readJson(latestPath);
    if (!latest) { console.error('No latest.json: run collect and score first.'); process.exit(2); }
    console.log(render(readJson(basePath), latest, { ascii }));
    return;
  }
  console.error('Usage: audit.mjs <collect|score|render> [--root DIR] [--sessions] [--no-git] [--rebaseline] [--history] [--ascii]');
  process.exit(2);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
