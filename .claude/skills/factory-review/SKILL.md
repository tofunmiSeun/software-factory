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
  - nothing: **review**. For a spec or plan, open it in the plan-review card (section 2) and act on the answer given there. For anything else, present it as text and stop without changing state.
  - just "approve", "lgtm", "yes", "ok" or "ship it": **approve**.
  - anything else: **feedback** (or, for a blocked stage, guidance).

Read `node scripts/factory.mjs feature:get <project> <feature>`.

## 2. Review (no verdict given)

### 2a. Spec or plan: review in the plan card
For `awaiting_spec_approval` and `awaiting_plan_approval`, the human reviews in Claude Code's plan-review card, where they can add inline comments, approve or request changes. Their answer there is the verdict. Other skills come here too ("open the review card") when a feature reaches a spec or plan gate.

1. **Enter plan mode.** If the session is not already in plan mode, call `EnterPlanMode`. If it is deferred, load it first with ToolSearch `select:EnterPlanMode,ExitPlanMode`. The plan-mode system message names the plan file. If `EnterPlanMode` is unavailable or the human declines it (for example, in a non-interactive `claude -p` run), fall back to **2c**.
2. **Write the plan file.** This is the only file you may edit while in plan mode. Write:
   ```
   # Factory review: <project> / <feature> — SPEC        (or PLAN)
   > Approve = approve this spec (plan). Request changes = your comments go to the spec-builder (work-planner) for a revision.
   ```
   - Spec: if the spec has open questions, list them first under `## Open questions` so they are easy to comment on. Then include the whole of `spec.md`, word for word.
   - Plan: first a `## Stages` table (n, title, one-line summary of what the PR changes) built from `stages.json`. Then include the whole of `plan.md`, word for word.
3. **Call `ExitPlanMode`.**
4. **Route on the result.**
   - **Approved:** plan mode is now off. Run **Approve spec** or **Approve plan** in section 3.
   - **Changes requested:** the feedback is the human's message plus every inline comment. Quote each comment together with the passage it is attached to (`> passage` → comment). You are still in plan mode, so overwrite the plan file with a short confirm card:
     ```
     # Send feedback: <project> / <feature> — SPEC        (or PLAN)
     > Approve to record this feedback and have the spec-builder (work-planner) revise. Request changes to edit the feedback.
     <the feedback, quoted as above>
     ```
     Then call `ExitPlanMode` again.
     - Approved: run the **Feedback** branch for this status in section 3, with that feedback text. Then open the card again on the revised spec or plan (go back to step 1).
     - Changes requested again: the new text replaces or extends the feedback. Show the confirm card again. If the human says to stop or cancel, change no state and stop.
5. **Guardrails.** Only the human's own Approve on the review card approves a spec or plan. Approving the confirm card only sends feedback; it never approves the spec or plan. Never approve on the human's behalf.

### 2b. Blocked stage (`needs_human`)
Show the last `needs_human` note in `history`, the stage it concerns, and the main unresolved points from the latest `stages/<n>/review-*.md` or PR feedback. The only answer is `/factory-review <project> <feature> <guidance>` (or the rebuild / skip / cancel choice for a closed PR). For any other status, see "Anything else" below.

### 2c. Text fallback (no plan mode)
- `awaiting_spec_approval`: link `features/<feature>/spec.md`. Summarize the problem, the proposed behaviour, what is in and out of scope, and every open question in the spec.
- `awaiting_plan_approval`: link `features/<feature>/plan.md`. List each stage with its title and a one-line summary of what its PR changes.

End with the two ways to answer:
- approve: `/factory-review <project> <feature> approve`
- request changes: `/factory-review <project> <feature> <your feedback>`

Typed verdicts always work too, and skip the card.

## 3. Act on the verdict, by `status`

### awaiting_spec_approval
**Feedback:**
```
node scripts/factory.mjs feature:feedback <project> <feature> --gate spec --text "<feedback>"
node scripts/factory.mjs feature:status <project> <feature> spec_drafting
```
Run the **spec-builder** again (same inputs as `/factory-issue`). Set FEEDBACK to every `gate: spec` entry in the feature's feedback list, newest last, and tell it to revise the existing spec.md. Then set the status to `awaiting_spec_approval`, give a one-paragraph summary of the changes, and open the review card again (section 2a).

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
- `true`: set the status to `awaiting_plan_approval` and open the review card for the plan (section 2a).
- `"multi-stage-only"` with exactly one stage, or `false`: continue as **Approve plan**.

### awaiting_plan_approval
**Feedback:** record it with `--gate plan` and set the status to `planning`. Re-run the work-planner with all plan feedback, then `stages:load` again, set the status to `awaiting_plan_approval`, give a one-paragraph summary of the changes, and open the review card again (section 2a).

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
