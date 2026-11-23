# workflow-audit

A drop-in Claude Code skill that scores how well a project is set up for Claude Code, saves a baseline, and shows a before/after scorecard each time you change your setup.

```
workflow-audit v1.1.0 · tier M · code · 2026-11-01 → 2026-11-23
                Before           After
Context         ████████░░  8.0  ██████████ 10.0  +2.0
Retrieval       ███████░░░  7.5  █████████░  8.8  +1.3
Verification    ██████░░░░  6.0  ████████░░  8.0  +2.0
Orchestration   ████████░░  7.5  ████████░░  7.5   0.0
Reuse           ░░░░░░░░░░  0.0  █████░░░░░  5.0  +5.0
Overall                     5.8              7.9  +2.1
```

It is **read-only**: it never edits your code or config. It writes only to `.claude/audits/`.

## Install

Clone it into your personal skills folder to use it in every project:

```bash
git clone https://github.com/rui-ch67/workflow-audit ~/.claude/skills/workflow-audit
```

Or clone it into one project only:

```bash
git clone https://github.com/rui-ch67/workflow-audit .claude/skills/workflow-audit
```

You can also download the ZIP and copy the folder to either place. Then run `/workflow-audit` in Claude Code. Use `/reload-skills` if it doesn't appear.

To update later, run `git pull` inside the skill folder.

**Requires** Node 18 or later, with no npm install. Without Node, the skill falls back to a manual audit by Claude, and every pillar is marked low confidence.

## What it scores

Five pillars, 0–10 each. The full rules are in [references/rubric.md](references/rubric.md).

| Pillar | Looks at |
|---|---|
| Context | `CLAUDE.md` size, focus, broken references, rules stated as advice but not enforced |
| Retrieval | Routing map, imported vs linked docs, nested context in monorepos, doc fragmentation |
| Verification | Tests, lint/typecheck, CI, documented commands, verify hooks, deny rules |
| Orchestration | Whether the agent setup fits the project's scale, tool restriction, model tiering, subagent use |
| Reuse | Skills and commands: validity, description length, side-effect safety, coverage |

### How it stays fair and repeatable

- **Scale-aware.** Each project gets a tier: S (solo/small), M or L (monorepo, large or a team). Criteria a project doesn't need are `n/a`, not 0, so a small repo isn't penalised for having no agents, hooks or doc tree.
- **Script first.** 38 of the 50 points are decided by `scripts/audit.mjs`. Claude judges the other 12, using fixed anchors in [references/judging.md](references/judging.md).
- **Verified judgements.** Every judged point must quote the file it relies on. The script rejects quotes it can't find at the cited lines.
- **Cached judgements.** A judgement is reused until its input files change, so re-running on an unchanged repo gives the same score.
- **Versioned rubric.** Snapshots from different rubric versions are never compared.

## Flags

| Flag | Effect |
|---|---|
| `--sessions` | Also reads this project's local session logs in `~/.claude/projects/`. Only counts are kept (sessions, subagent calls, `/clear`, compactions), never prompt text |
| `--rebaseline` | Replaces the baseline with this run |
| `--history` | Also keeps a dated copy in `.claude/audits/history/` |
| `--ascii` | Draws bars with `#` and `.`, for terminals without block characters |

Example: `/workflow-audit --sessions`

## Files it writes

| File | Written by | Purpose |
|---|---|---|
| `.claude/audits/facts.json` | script | Facts and deterministic results: paths, counts and hashes, no file contents |
| `.claude/audits/judgements.json` | Claude | Grades, quotes and recommendations (the judgement cache) |
| `.claude/audits/latest.json` | script | Current snapshot ([schema](references/schema.json)) |
| `.claude/audits/baseline.json` | script | First snapshot, or the one saved with `--rebaseline` |

Commit `.claude/audits/` if your team wants shared before/after comparisons. Otherwise add it to `.gitignore`. `judgements.json` contains short quotes from your docs.

To override the detected tier, create `.claude/audits/config.json` containing `{ "tier": "M" }`.

## Limits

- **Token counts are estimates** (characters ÷ 4). They are consistent between runs, which is what the deltas need.
- **Only project config is audited.** Your personal `~/.claude/CLAUDE.md`, user settings and plugins are not scored.
- **Session evidence is per launch folder.** If you start Claude Code in a parent folder, that project's sessions are filed under the parent's name.
- **Claude Code loads `CLAUDE.md`, not `AGENTS.md`.** A repo with only `AGENTS.md` gets half marks on P1.a. Add a `CLAUDE.md` containing `@AGENTS.md`.
- **Large repos.** Scans stop at 20,000 files or 10 seconds, and the result is marked partial.
- **The scores measure adherence to known good habits.** They are not a measure of productivity.

## Development

Run the tests (fixtures are generated in a temp dir, free and offline):

```bash
node --test tests/*.test.mjs
```

Run the script by hand against any repo, writing output elsewhere:

```bash
node scripts/audit.mjs collect --root ../some-repo --out /tmp/audit
```

## License

MIT. See [LICENSE](LICENSE).
