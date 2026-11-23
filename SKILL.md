---
name: workflow-audit
description: Audit this project's Claude Code workflow setup (CLAUDE.md, doc routing, verification, agents, skills), save a baseline snapshot and print a before/after scorecard with prioritised fixes. Read-only; writes only .claude/audits/.
argument-hint: "[--sessions] [--rebaseline] [--history] [--ascii]"
disable-model-invocation: true
context: fork
model: sonnet
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/audit.mjs" *), Read, Glob, Grep
---

# workflow-audit

Score how well this project is set up for Claude Code, on five pillars (0–10 each), and compare against a saved baseline.

A script does all detection and maths. You judge only the criteria it lists, and every judgement must quote the file it relies on.

## Rules

- **Read-only.** Never edit, create or delete project files. The only file you write is `.claude/audits/judgements.json`. The script writes the others in `.claude/audits/`.
- Never open `.env*`, key files or anything that looks like a secret. Never put secrets in quotes or notes.
- Never change a score by hand or edit `latest.json` or `baseline.json`.
- Small projects are not penalised for missing heavy setup. The script already marks those criteria `n/a`. Don't recommend agents, hooks or doc trees a project doesn't need.

## Steps

Arguments passed: `$ARGUMENTS`

1. **Collect.** Run exactly:

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/audit.mjs" collect $ARGUMENTS
   ```

   If `node` is missing or older than 18, follow **No Node** below instead.

2. **Judge.** The output lists `Judgements to make`. Each has an id, a 0–max range, a `hash`, a question and the files to read.
   - If nothing is listed, skip this step and step 3's new items. Don't open `references/judging.md`.
   - Otherwise read only the listed files, and read [references/judging.md](references/judging.md) once. Pick the anchor that matches; don't average.
   - Criteria listed as cached keep their earlier grade. Don't re-read their files or re-judge them.

3. **Write `.claude/audits/judgements.json`.** Keep cached items, and add or replace the new ones:

   ```json
   {
     "rubric_version": "1.1.0",
     "items": {
       "P1.e": {
         "grade": 1,
         "input_hash": "<hash from collect output>",
         "evidence": [{ "path": "CLAUDE.md", "lines": [12, 14], "quote": "exact text from those lines" }],
         "note": "One sentence on why this anchor."
       }
     },
     "recommendations": [
       { "pillar": "P3", "impact": "high", "effort": "S", "text": "Add a Stop hook that runs `npm test`." }
     ]
   }
   ```

   - `quote` must be copied exactly from the cited lines, at most 200 characters. The script rejects quotes it cannot find within ±2 lines.
   - A grade above 0 needs at least one piece of evidence. A grade of 0 may have none, if the thing is absent.
   - Recommendations: 3–5, ordered by points recoverable per effort. Base them on the lost points in the collect output and your own grades, and name the exact file or command to add.

4. **Score.** Run:

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/audit.mjs" score $ARGUMENTS
   ```

   If it prints `unverified` warnings, fix those citations once and run score again. Don't retry a second time: the 0 stands.

5. **Report.** Keep it short: the scorecard exactly as printed, in a code block, then 3–5 one-line recommendations. No walkthrough of your reading or reasoning unless the user asks. Mention `~` pillars as low confidence. On the first run, say the baseline is saved and re-running `/workflow-audit` after changes shows the delta.

## Flags

| Flag | Effect |
|---|---|
| `--sessions` | Also reads local session logs for this project (counts only, never prompt text) to score subagent use |
| `--rebaseline` | Replaces the baseline with this run |
| `--history` | Also keeps a dated copy in `.claude/audits/history/` |
| `--ascii` | `#` and `.` bars for terminals without block characters |

## No Node

Do the audit by hand with Glob, Grep and Read, following [references/rubric.md](references/rubric.md) criterion by criterion. Write `.claude/audits/latest.json` in the shape of [references/schema.json](references/schema.json), with `"collector": "llm"` and every pillar's `confidence` set to `"low"`. Do the score maths exactly as rubric.md describes. Tell the user that installing Node 18+ gives exact, repeatable scores.
