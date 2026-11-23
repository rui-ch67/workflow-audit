# Judging anchors v1.1.0

Pick the anchor that matches the evidence. Don't average between anchors or add points for effort. When torn between two anchors, pick the lower one and say why in `note`.

Every grade above 0 needs at least one quote: `path`, `lines: [a, b]` and an exact `quote` from those lines.

## P1.e Content quality (0–2)

Inputs: startup context (root `CLAUDE.md` and imports).

- **2**: Mostly things Claude can't infer from the code: exact commands, gotchas, constraints, conventions that differ from defaults, and "don't do X because Y". Little or no restating of README or folder structure.
- **1**: A useful core, but about a third or more is generic advice ("write clean code"), a README copy, or architecture Claude could read from the code.
- **0**: Mostly generic, a README copy or a file tour, or so vague that it gives no concrete instruction.

## P1.g Handoff convention (0–1)

Inputs: root `CLAUDE.md` and any progress, plan, status or notes docs.

- **1**: A named place where state is kept between sessions (progress file, plan with checkboxes, handoff notes), and the instructions say when to update it. With `--sessions`, frequent `/clear` or compaction counts in favour.
- **0**: No such place, or one that exists but is never referenced.

## P2.b Routing map is short (0–1)

Inputs: root `CLAUDE.md`.

- **1**: The map points to where things live in a few lines (one line per area or doc), with a reason to go there.
- **0**: The map lists files exhaustively, mirrors the folder tree, or there is no map.

## P2.d Linked docs focused (0–1)

Inputs: imported and linked docs.

- **1**: Each doc covers one topic that its name or link text predicts. Claude can load one without the others.
- **0**: One or more docs mix unrelated topics, so loading any of them drags in unrelated context.

## P4.a Agent setup fits scale (0–3)

Inputs: `.claude/agents/*.md`, root `CLAUDE.md`, the profile (tier, kind) and session stats if present.

Three valid reasons for a subagent: parallel independent work, isolating noisy output (test runs, log reading, wide searches), and fresh-context review. Any one is enough.

- **3**: The setup matches the project. Either no agents on a project that doesn't need them (typical for S), or a small set where each agent has one of the three reasons. A single test-runner or reviewer agent counts.
- **2**: Mostly fitting, with one agent that has no clear reason or overlaps another. Or no agents on an M/L project where one would clearly help (for example a long, verbose pre-PR check), though nothing breaks without it.
- **1**: Clearly off-scale: many agents on a small project, or an M/L project whose docs describe long noisy jobs (big test suites, wide refactors) with no isolation at all.
- **0**: Agents conflict or contradict the instructions, or overlap so much that it's unclear which to use.

## P4.c Agent descriptions (0–1)

Inputs: `.claude/agents/*.md`.

- **1**: Every description says when to use the agent and what it returns.
- **0**: Any description is missing, generic ("helpful assistant") or describes behaviour without saying when to use it.

## P4.e Independent vs dependent work (0–1)

Inputs: root `CLAUDE.md` and plan, task or roadmap docs.

- **1**: The docs mark which tasks can run in parallel and which depend on others, for example a dependency column, "blocked by", or worktree guidance.
- **0**: Tasks are listed with no dependency information.

## P5.e Skill steps (0–1)

Inputs: skill and command files.

- **1**: Each skill has ordered steps, a clear stop condition or output, and says what to do on failure where that matters.
- **0**: Any skill is a vague paragraph, misses a step a reader would need, or has no defined output.

## P5.g Other repeatable work captured (0–1)

Inputs: root `CLAUDE.md`, `package.json`, `Makefile`/`justfile`, CI workflows, skill names.

- **1**: Multi-step routines that the docs or CI show are done repeatedly (release notes, PR prep, data refresh, review checklists) are captured as skills or commands, or there are none worth capturing.
- **0**: The docs describe a repeated multi-step routine that someone would have to retype each time.
