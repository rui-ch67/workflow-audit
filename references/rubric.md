# Rubric v1.1.0

Five pillars, 10 points each. Every criterion is either **D** (decided by `scripts/audit.mjs`) or **J** (judged by Claude with the anchors in [judging.md](judging.md), and backed by verified quotes).

## Score maths

- A criterion that does not apply is `n/a`. It adds nothing to the pillar's earned points or its maximum.
- Pillar score = 10 × earned ÷ applicable max, rounded to 1 decimal. A pillar with no applicable criteria shows `n/a`.
- Confidence is `low` (shown as `~`) when the applicable max is under 4, a J criterion is still pending, the scan was partial, or the collector was not the script.
- Overall = mean of the pillar scores that are not `n/a`.
- Pending J criteria are left out until judged. Unverified J criteria score 0.
- Snapshots from different rubric versions are never compared.

## Profile

| Field | Rule |
|---|---|
| Source files | Files with a code extension (js, ts, py, go, rs, java, kt, cs, swift, rb, php, c/cpp, dart, scala, ex) |
| Stacks | Languages with ≥3 files and ≥5% of source files |
| Kind | `empty` if no files; `code` if source files ≥10% of files; otherwise `docs` |
| Monorepo | A workspace marker (`pnpm-workspace.yaml` with `packages:`, `turbo.json`, `nx.json`, `lerna.json`, `go.work`, `rush.json`, Cargo `[workspace]`, package.json `workspaces`) **and** ≥2 package directories |
| Tier L | Monorepo, or >1,500 source files, or ≥4 contributors in 90 days |
| Tier S | <150 source files and ≤1 contributor in 90 days |
| Tier M | Everything else |

Override the tier with `.claude/audits/config.json`: `{ "tier": "M" }`.

Files come from `git ls-files -co --exclude-standard`, or a directory walk without git. Generated and dependency folders (`node_modules`, `dist`, `build`, `.venv`, `target` …), `.claude/audits/` and this skill's own folder are skipped. Scans stop at 20,000 files or 10 s and are marked partial.

**Startup context** = root `CLAUDE.md` (or `.claude/CLAUDE.md`) + its `@imports`, recursively to depth 5 + `.claude/rules/*.md` without `paths:` frontmatter. Tokens ≈ characters ÷ 4.

## P1 Context & Instruction Hygiene

| Id | Pts | Applies | Kind | Rule |
|---|---|---|---|---|
| P1.a | 2 | all | D | `CLAUDE.md` = 2. Only `AGENTS.md` = 1 (Claude Code loads CLAUDE.md, so add one containing `@AGENTS.md`). None = 0 |
| P1.b | 2 | startup context exists | D | ≤ budget = 2, ≤ 2× budget = 1. Budget: S 1,500, M 3,000, L 5,000 tokens |
| P1.c | 1 | startup context exists | D | ≤15 tree lines (`├──`, `└──`, `│`) **and** <30% of lines are bare path listings or non-shell code. Shell blocks of ≤15 lines don't count |
| P1.d | 1 | startup context exists | D | 0 if an emphatic line (`IMPORTANT`, `NEVER`, `ALWAYS`, `MUST`, `DO NOT`) covers an enforceable topic with nothing enforcing it. Format/lint needs a formatter hook or pre-commit. Secrets need a deny rule or PreToolUse hook. Destructive commands need a deny rule or PreToolUse hook |
| P1.e | 2 | `CLAUDE.md` exists | J | See judging.md |
| P1.f | 1 | startup context exists | D | 0 if any referenced path or `npm run`/`make`/`just` command does not exist |
| P1.g | 1 | M, L | J | See judging.md |

## P2 Targeted Context & Retrieval

| Id | Pts | Applies | Kind | Rule |
|---|---|---|---|---|
| P2.a | 2 | M, L | D | Pointers to directories or docs (`.md`, `.mdx`, `.txt`, `.rst`) in root `CLAUDE.md`: ≥3 = 2, 1–2 = 1. Whether they resolve is scored in P1.f |
| P2.b | 1 | M, L | J | See judging.md |
| P2.c | 2 | M, L, or S over budget | D | Imported tokens ÷ startup tokens: ≤50% = 2, ≤75% = 1 |
| P2.d | 1 | as P2.c, and linked docs exist | J | See judging.md |
| P2.e | 2 | monorepo | D | Packages with a nested `CLAUDE.md` or a matching path-scoped rule: ≥50% = 2, any = 1 |
| P2.f | 2 | all | D | Docs (excluding root files, dot folders, README/CHANGELOG/LICENSE …) that are orphaned or under 10 lines: <10% = 2, <25% = 1. Linked = named in another doc, or its folder is. Templates are never tiny. Fewer than 3 docs = 2 |

## P3 Verification & Guardrails

| Id | Pts | Applies | Kind | Rule |
|---|---|---|---|---|
| P3.a | 3 | code; docs with content checks | D | Code: test command and test files = 3, either = 1. Docs: ≥2 content-check tools (markdownlint, link checker, spellcheck, Vale) = 3, 1 = 2, none = n/a |
| P3.b | 2 | code with a stack | D | Share of stacks with lint/typecheck config: all = 2, ≥half = 1. Compiled languages pass by default |
| P3.c | 2 | verify commands detected | D | Test command documented in startup context and, if other checks exist, one of them too = 2; any one = 1 |
| P3.d | 1 | not empty | D | CI workflow mentioning test/lint/check/build, or pre-commit (`.pre-commit-config.yaml`, `.husky/`, `lefthook.yml`) |
| P3.e | 1 | M, L; S only if a hook exists | D | A `PostToolUse`, `Stop` or `SubagentStop` hook runs a verify command that exists |
| P3.f | 1 | M, L, or `.env*` at root | D | A deny rule covering secrets (`.env`, keys) or destructive commands |

## P4 Task & Agent Orchestration Fit

| Id | Pts | Applies | Kind | Rule |
|---|---|---|---|---|
| P4.a | 3 | not empty | J | See judging.md |
| P4.b | 1 | agents exist | D | Every agent in `.claude/agents/` sets `tools` |
| P4.c | 1 | agents exist | J | See judging.md |
| P4.d | 2 | read-only agents exist | D | Read-only = `tools` set without Write/Edit/Bash. All set a `model` other than `inherit` = 2, some = 1 |
| P4.e | 1 | M, L | J | See judging.md |
| P4.f | 2 | `--sessions`, ≥3 sessions; S only if subagents used | D | Subagents (`Task` or `Agent` tool) in ≥30% of sessions, or ≥2 purposes seen (parallel, isolation, review) = 2; any use = 1 |

## P5 Reusability

| Id | Pts | Applies | Kind | Rule |
|---|---|---|---|---|
| P5.a | 3 | skills exist, or M/L with ≥3 scripts/targets or CI | D | All skills/commands valid = 3, ≥half = 2, some = 1. Skill valid = `description` + ≥5 body lines; command valid = ≥3 body lines |
| P5.b | 1 | skills with descriptions | D | Longest `description` + `when_to_use`: ≤400 chars = 1, ≤1,536 = 0.5, longer (truncated) = 0 |
| P5.c | 1 | skills named deploy/ship/release/publish/migrate/delete/drop/destroy/push/rollback | D | All set `disable-model-invocation: true` |
| P5.d | 1 | skills bundling scripts | D | All reference them via `${CLAUDE_SKILL_DIR}` (or `${CLAUDE_PLUGIN_ROOT}`) |
| P5.e | 1 | skills exist | J | See judging.md |
| P5.f | 1 | deploy/release/publish/migrate/ship scripts, targets or CI workflows exist | D | Each is named in a skill, a command or the startup context |
| P5.g | 1 | not empty | J | See judging.md |
| P5.h | 1 | skills exist | D | No duplicate names and no clash with built-in commands (`/help`, `/clear`, `/review` …) |
