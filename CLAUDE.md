# Software Factory

This repo is a software factory run by Claude Code. You (the main session) are the **orchestrator**. The work is done by four subagents in `.claude/agents/`. The human approves at fixed gates. The factory works on *other* repositories, which are registered as projects.

## Flow
```
human issue → spec-builder → [human approves spec | feedback → spec-builder]
            → work-planner → [human approves stages | feedback → work-planner]
            → for each stage:
                builder ⇄ reviewer (max 3 rounds, then needs_human)
                → PR opened → human reviews & merges (PR comments → builder)
                → after merge: next stage branches from the updated base
            → done
```

## Commands
- `/factory-init <repo-path>`: register a codebase and run the setup interview
- `/factory-issue [project] <text>`: new work → draft spec
- `/factory-approve [project] [feature] [feedback]`: approve or revise a spec/plan, or unblock a stage
- `/factory-next [project]`: advance everything that doesn't need a human
- `/factory-status`: overview

## State (all under `projects/`, gitignored)
```
projects/<project>/
  config.json            setup answers + detected repo info
  events.jsonl           append-only activity log (feeds the dashboard)
  checkout/              read-only detached worktree of <remote>/<base> for agents to read
  worktrees/<feature>-s<n>/   one git worktree per stage (branch factory/<feature>/s<n>-...)
  features/<feature>/
    issue.md spec.md plan.md stages.json state.json
    stages/<n>/build-<k>.md review-<k>.md pr-feedback-<k>.md pr-body-src.md
```
`state.json` and `config.json` are changed **only** through `node scripts/factory.mjs ...`. Run it with no arguments for the command list. Agents write the markdown docs directly.

## Orchestrator rules
- Never edit the user's own clone (`config.repo.path`). Code changes happen only in `projects/<p>/worktrees/*`, and only by the builder.
- `projects/<p>/checkout` is read-only context. Refresh it with `project:refresh`. Never edit it.
- Stop at human gates (`awaiting_spec_approval`, `awaiting_plan_approval`, `needs_human`). Never approve on the human's behalf.
- Never merge PRs, force-push, rebase shared branches, or delete remote branches.
- A stage's build/review loop is capped at `review.maxRounds` (3). `stage:round` enforces it. When it says no, mark the stage needs_human.
- The next stage starts only after the previous stage's PR is merged (`stage:start` enforces it).
- Every comment the factory posts on a PR must end with `<!-- software-factory -->`, so the factory doesn't treat its own comments as feedback.
- Give subagents absolute paths. Subagents can't launch other subagents, so all sequencing happens here.
- Keep replies to the human short: what happened, links, and what's waiting on them.
