---
name: factory-approve
description: Human approval gate for the Software Factory. Approves a feature's spec or plan, or sends feedback for another revision, or unblocks a feature that needs a human. Use when the user approves, rejects or comments on a factory spec or plan, or gives instructions for a blocked stage.
argument-hint: "[project] [feature] [feedback — omit to approve]"
---

# Approve or give feedback

Arguments: `$ARGUMENTS`

## 1. Resolve the target
- `node scripts/factory.mjs next` lists active features and what they're waiting on.
- Project: the first argument if it's a known project, or the only project.
- Feature: the next argument if it matches a feature id, its number prefix (`001` or `1`), or a unique prefix. If omitted, use the single feature whose next action is `human`. If there are several, ask which.
- Everything after that is **feedback**. No feedback, or just "approve", "lgtm", "yes", "ok" or "ship it", means **approve**.

Read `node scripts/factory.mjs feature:get <project> <feature>` and act on `status`:

## awaiting_spec_approval
**Feedback:**
```
node scripts/factory.mjs feature:feedback <project> <feature> --gate spec --text "<feedback>"
node scripts/factory.mjs feature:status <project> <feature> spec_drafting
```
Run the **spec-builder** again (same inputs as `/factory-issue`). Set FEEDBACK to every `gate: spec` entry in the feature's feedback list, newest last, and tell it to revise the existing spec.md. Then set the status to `awaiting_spec_approval` and reply with the summary of changes.

**Approve spec:**
```
node scripts/factory.mjs feature:status <project> <feature> planning --note "spec approved"
node scripts/factory.mjs project:refresh <project>
```
Launch the **work-planner** subagent:
```
CONFIG: <factory>/projects/<project>/config.json
CHECKOUT: <factory>/projects/<project>/checkout
FEATURE_DIR: <factory>/projects/<project>/features/<feature>
FEEDBACK: (none, or all gate: plan feedback when revising)
```
Then `node scripts/factory.mjs stages:load <project> <feature>`. If stages.json is invalid, re-run the planner once and tell it the error.

Plan gate. Read `gates.plan` from the config:
- `true`: set the status to `awaiting_plan_approval`. Reply with the stage list and how to approve or give feedback.
- `"multi-stage-only"` with exactly one stage, or `false`: continue as **Approve plan**.

## awaiting_plan_approval
**Feedback:** record it with `--gate plan` and set the status to `planning`. Re-run the work-planner with all plan feedback, then `stages:load` again, set the status to `awaiting_plan_approval`, and reply with the changes.

**Approve plan:** set the status with `--note "plan approved"`, then run the **build loop** for the first stage, exactly as described in `.claude/skills/factory-next/SKILL.md`. Read that file and follow its "Build loop" and "Open the PR" sections.

## needs_human
Read the last `needs_human` note in `history`, the latest `stages/<n>/review-*.md`, and the stage status.
- **Stage hit the round limit:** the user's text is guidance for the builder. Record it with `--gate stage`. Then:
  `node scripts/factory.mjs stage:update <project> <feature> <n> --json '{"status":"building","rounds":0}'`
  `node scripts/factory.mjs feature:status <project> <feature> building --note "unblocked by human"`
  Run the build loop. On its first round, pass FIX as the user's guidance plus the last review file.
- **PR was closed without merging:** ask whether to rebuild this stage from scratch, skip it, or cancel the feature. Then do that:
  - rebuild: `stage:update` to status `pending`, clear branch/worktree/pr, reset rounds, then build.
  - skip: `stage:update` to status `closed` and move on.
  - cancel: `feature:status ... cancelled`.
- **PR-feedback rounds exhausted:** like the round limit, but reset `prRounds` instead. The FIX is the user's guidance plus the outstanding PR feedback.

## Anything else
Nothing is waiting for approval. Say what the feature's status is and what happens next (`/factory-next`).
