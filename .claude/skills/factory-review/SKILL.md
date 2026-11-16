---
name: factory-review
description: Human review gate for the Software Factory. With no verdict, presents a feature's spec, plan or blocked stage for review. With "approve", approves it; with any other text, sends that as feedback for another revision or as guidance to unblock a stage. Use when the user wants to review, approve, reject or comment on a factory spec or plan, or gives instructions for a blocked stage.
argument-hint: "[project] [feature] [approve | feedback — omit to review]"
---

# Review a spec, plan or blocked stage

Arguments: `$ARGUMENTS`

## 1. Resolve the target
- `node scripts/factory.mjs next` lists active features and what they're waiting on.
- Project: the first argument if it's a known project, or the only project.
- Feature: the next argument if it matches a feature id, its number prefix (`001` or `1`), or a unique prefix. If omitted, use the single feature whose next action is `human`. If there are several, ask which.
- Everything after that is the **verdict**:
  - nothing: **review**. Present the item (section 2) and stop. Change no state.
  - just "approve", "lgtm", "yes", "ok" or "ship it": **approve**.
  - anything else: **feedback** (or, for a blocked stage, guidance).

Read `node scripts/factory.mjs feature:get <project> <feature>`.

## 2. Review (no verdict given)
Show the human what is waiting on them, by `status`, so they can decide without opening files:
- `awaiting_spec_approval`: link `features/<feature>/spec.md`. Summarize the problem, the proposed behaviour, what is in and out of scope, and every open question in the spec.
- `awaiting_plan_approval`: link `features/<feature>/plan.md`. List each stage with its title and a one-line summary of what its PR changes.
- `needs_human`: the last `needs_human` note in `history`, the stage it concerns, and the main unresolved points from the latest `stages/<n>/review-*.md` or PR feedback.
- anything else: as in "Anything else" below.

End with the two ways to answer:
- approve: `/factory-review <project> <feature> approve`
- request changes: `/factory-review <project> <feature> <your feedback>`

For `needs_human`, the only answer is `/factory-review <project> <feature> <guidance>` (or the rebuild / skip / cancel choice for a closed PR).

## 3. Act on the verdict, by `status`

### awaiting_spec_approval
**Feedback:**
```
node scripts/factory.mjs feature:feedback <project> <feature> --gate spec --text "<feedback>"
node scripts/factory.mjs feature:status <project> <feature> spec_drafting
```
Run the **spec-builder** again (same inputs as `/factory-issue`). Set FEEDBACK to every `gate: spec` entry in the feature's feedback list, newest last, and tell it to revise the existing spec.md. Then set the status to `awaiting_spec_approval` and reply with the summary of changes and how to answer, as in section 2.

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
- `true`: set the status to `awaiting_plan_approval`. Reply with the review of the plan, as in section 2.
- `"multi-stage-only"` with exactly one stage, or `false`: continue as **Approve plan**.

### awaiting_plan_approval
**Feedback:** record it with `--gate plan` and set the status to `planning`. Re-run the work-planner with all plan feedback, then `stages:load` again, set the status to `awaiting_plan_approval`, and reply with the changes and how to answer, as in section 2.

**Approve plan:** set the status with `--note "plan approved"`, then run the **build loop** for the first stage, exactly as described in `.claude/skills/factory-next/SKILL.md`. Read that file and follow its "Build loop" and "Open the PR" sections.

### needs_human
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

### Anything else
Nothing is waiting for review. Say what the feature's status is and what happens next (`/factory-next`).
