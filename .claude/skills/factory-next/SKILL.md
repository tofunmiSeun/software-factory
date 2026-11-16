---
name: factory-next
description: Advance the Software Factory. For every active feature, does the next automated step (draft spec, plan, build and review a stage, open its PR, check PRs for merge or review comments, start the next stage after a merge) and stops at human gates. Use when the user says to run, continue, advance or check on the factory.
argument-hint: "[project] [feature]"
---

# Advance the factory

Arguments: `$ARGUMENTS` (optional project and/or feature to limit the run)

Projects can live on GitHub or GitLab (`repo.forge` in config.json). On GitLab a PR is a **merge request (MR)**, numbered `!12` instead of `#12`. The `stage:*` commands handle both, so the steps below are the same. Say "MR" to the user for GitLab projects.

For each project you will work on, take its run lock first, so a scheduled PR-watch run and a manual run never work on the same feature at once:
```
node scripts/factory.mjs run:lock <project>
```
If `acquired` is false, another run is in progress: skip that project and say so (mention `heldBy` and `since`). Only if the user explicitly says the other run is dead, retry with `--force`.
**Always** release it when you are done with the project, including when you stop early or hit an error: `node scripts/factory.mjs run:unlock <project>`.

```
node scripts/factory.mjs next [project]
```
Handle items one feature at a time, in order. For each item, act on `action`:

| action | do |
|---|---|
| `draft-spec` | the spec step in `.claude/skills/factory-issue/SKILL.md` (sections 3–4). If the feature has `gate: spec` feedback (e.g. changes requested from the dashboard), pass all of it as FEEDBACK, newest last, and tell the spec-builder to revise the existing spec.md |
| `plan` | `project:refresh <project>`, then "Approve spec" in `.claude/skills/factory-review/SKILL.md` from launching the work-planner onward. If the feature has `gate: plan` feedback, pass all of it as FEEDBACK and tell the planner to revise plan.md |
| `build-stage` | **Build loop** for `stage`, then **Open the PR** |
| `sync-pr` | **Sync the PR** |
| `approve-spec`, `approve-plan`, `unblock` | nothing. List it under "Waiting on you" at the end |

Paths below: `P` = `projects/<project>`, `F` = `P/features/<feature>`. Always pass absolute paths to subagents.

## Build loop
1. `node scripts/factory.mjs stage:start <project> <feature> <n>`. This gives you `worktree`, `branch` and `stage.baseSha`. If it refuses because an earlier stage isn't merged, skip this feature.
2. Repeat:
   a. `node scripts/factory.mjs stage:round <project> <feature> <n>`. If `allowed` is false, go to **Round limit**.
   b. Launch the **builder** subagent:
      ```
      CONFIG: <abs P>/config.json
      WORKTREE: <worktree>
      FEATURE_DIR: <abs F>
      STAGE: <n> — <title>
      <stage summary from state>
      ROUND: <round>
      FIX: <empty on the first round, otherwise the path of the latest F/stages/<n>/review-<k>.md, plus any human guidance>
      ```
   c. Check there are commits: `git -C <worktree> log --oneline <baseSha>..HEAD`. If there are none, and the builder reported a blocker, go to **Round limit** with that blocker as the note.
   d. `node scripts/factory.mjs stage:update <project> <feature> <n> --json '{"status":"reviewing"}'`
   e. Launch the **reviewer** subagent with CONFIG, WORKTREE, `BASE_SHA: <baseSha>`, FEATURE_DIR, STAGE and ROUND (same round number).
   f. Read the first line of `F/stages/<n>/review-<round>.md`.
      - `VERDICT: PASS`: leave the loop.
      - `VERDICT: FAIL` (or a missing or unclear verdict): set `{"status":"building"}` and repeat with FIX = that review file.

**Round limit:** The automated build/review loop is capped at `review.maxRounds` (3).
```
node scripts/factory.mjs stage:update <project> <feature> <n> --json '{"status":"needs_human"}'
node scripts/factory.mjs feature:status <project> <feature> needs_human --note "Stage <n> still failing review after <max> rounds: <top 1–3 blocking items>"
```
Stop working on this feature.

## Open the PR
0. **Screenshots (frontend changes):** if `F/stages/<n>/screenshots.json` exists, run `node scripts/factory.mjs stage:screenshots <project> <feature> <n>`. It starts the dev server, captures desktop and mobile shots with headless Chrome, pushes them to the `factory-screenshots` branch and writes `F/stages/<n>/screenshots.md`. Append that file's content to the PR body. If it fails, open the PR anyway and note under **Testing** that screenshots could not be captured and why. Redo this step after any builder round that changes the UI.
1. Write `F/stages/<n>/pr-body-src.md`. If `conventions.prTemplate` is set, follow the template from the worktree. Otherwise use:
   - **Summary**: what this PR does, in 2–4 lines
   - **Context**: feature title, stage `<n>` of `<total>`, and one line on how it fits the plan
   - **Changes**: bullet list
   - **Testing**: commands run and their results, and tests added
   - **Review**: the automated review verdict and the round count. List any suggestions that weren't applied.
   - **Next**: the next stage's title, if there is one
2. Title: follow `conventions.commitStyle`, e.g. `feat(theme): add colour tokens (1/2)`.
3. `node scripts/factory.mjs stage:pr <project> <feature> <n> --title "<title>" --body-file <abs path to pr-body-src.md>`
   This pushes the branch and opens the PR (or reuses an open one). The feature then waits for a human to review and merge.
4. Report the PR URL.

## Sync the PR
`node scripts/factory.mjs stage:sync <project> <feature> <n>`
- `merged`: if `nextStage` is set, run the **Build loop** for it now (it branches from the updated base), then **Open the PR**. If `featureStatus` is `done`, report that the feature is complete.
- `closed`: the CLI has already set needs_human. List it under "Waiting on you".
- `open` with no `newFeedback`: still waiting on the human. Mention the PR.
- `open` with `newFeedback`: act on `prFeedback.mode` from the config:
  - `plugin`: these comments are handled outside the factory. Report how many there are, then acknowledge them:
    `stage:update ... --json '{"lastFeedbackAt":"<latestFeedbackAt>"}'`
  - `builder-reads-pr` or `webhook` (webhooks aren't built yet, so treat it the same):
    1. `node scripts/factory.mjs stage:round <project> <feature> <n> --kind pr`. If not allowed, go to the round limit, with the note "PR feedback still unresolved after <max> rounds".
    2. Write the feedback to `F/stages/<n>/pr-feedback-<round>.md` (author, file:line, body).
    3. `stage:start <project> <feature> <n>` to make sure the worktree exists. It resumes the existing one.
    4. Builder with FIX = that file. Then the reviewer. If it FAILs, run the builder once more with the review, then review again. Don't run more than two builder passes per PR round.
    5. `stage:pr` again, with the same title and body file. This pushes the new commits to the open PR.
    6. Reply on the PR: write a file listing each feedback item and what changed, then `node scripts/factory.mjs stage:comment <project> <feature> <n> --body-file <file>`. It adds the factory's signature and the `<!-- software-factory -->` marker. Don't post with `gh pr comment` or `glab mr note` directly.
    7. `stage:update ... --json '{"status":"pr_open","lastFeedbackAt":"<latestFeedbackAt from the sync>"}'` and `feature:status ... awaiting_merge`.

## Finish
Reply with a short report:
- **Done this run**: specs drafted, plans written, PRs opened (with links), feedback addressed, stages merged
- **Waiting on you**: each item with the exact command (`/factory-review ...`) or the PR link to review and merge
- **Waiting on GitHub / GitLab**: open PRs and MRs with no new feedback

To run this unattended, it can be called on a schedule, e.g. `claude -p "/factory-next"` (see README).
