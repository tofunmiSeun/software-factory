# Software Factory

A spec → plan → build → review → PR pipeline that you point at any git repository. **Claude Code is the orchestrator.** Four subagents do the work, you approve at fixed gates, and every change arrives as a reviewed pull request on the target repo.

```
You: issue ─► spec-builder ─► YOU approve spec ─► work-planner ─► YOU approve stages
                   ▲ feedback ┘                        ▲ feedback ┘
   ┌───────────────────────────────────────────────────────────────┘
   ▼  for each stage (in its own git worktree, branched from the latest base)
 builder ⇄ reviewer   (UX · security · readability · simplicity; max 3 rounds → needs you)
   ▼
 PR opened ─► YOU review & merge ─► (PR comments go back to the builder)
   ▼ merged
 next stage … until done
```

![Dashboard](docs/dashboard.png)

## Requirements
- [Claude Code](https://docs.claude.com/en/docs/claude-code)
- Node.js 20+ and git
- [GitHub CLI](https://cli.github.com/) logged in (`gh auth login`). PR automation is GitHub-only for now.

## Quick start
```bash
git clone <this repo> software-factory && cd software-factory
claude                 # accept the workspace trust prompt the first time
```
Then in Claude Code:
```
/factory-init ~/code/my-app          # register a repo; answer a few setup questions
/factory-issue my-app Let signed-in users save their cart and come back to it later
                                      # → drafts projects/my-app/features/001-.../spec.md
/factory-approve my-app 001          # approve the spec   (or: /factory-approve my-app 001 <feedback>)
/factory-approve my-app 001          # approve the stage plan → builds stage 1 and opens its PR
# …review & merge the PR on GitHub…
/factory-next                        # sees the merge, builds the next stage, handles PR comments
/factory-status                      # what's going on, what's waiting on you
```
In a second terminal, run the dashboard: `npm run dashboard` → http://localhost:4317

## What you give it
- **The repo path.** The factory reads the git remote to get `owner/repo`, detects the base branch, and works out the build, test and lint commands and the conventions from the code and CI. It asks you only what it couldn't work out: review lenses, PR size, approval gates, how PR comments are handled, off-limits paths.
- **Issues**, typed in by hand for now (`/factory-issue`). The source is stored in `config.json` as `issues.source: "manual"`, so a GitHub Issues, Linear or Jira reader can be added later without changing the flow.

## How it works
| Piece | Where |
|---|---|
| Orchestrator rules | `CLAUDE.md` |
| Slash commands | `.claude/skills/factory-{init,issue,approve,next,status}/SKILL.md` |
| Subagents | `.claude/agents/{spec-builder,work-planner,builder,reviewer}.md` |
| State CLI (all transitions, worktrees, PRs) | `scripts/factory.mjs` (run with no args for help) |
| Dashboard | `dashboard/` (zero-dependency Node server + one HTML page) |
| Permissions | `.claude/settings.json` (edits auto-accepted inside the factory folder; force-push and `gh pr merge` denied) |

### State: one folder per project (gitignored)
```
projects/<project>/
  config.json        detected repo info + your setup answers
  events.jsonl       activity log
  checkout/          read-only worktree of <remote>/<base> that agents read
  worktrees/         one git worktree per stage in progress
  features/<NNN-slug>/
    issue.md  spec.md  plan.md  stages.json  state.json
    stages/<n>/build-<k>.md  review-<k>.md  pr-feedback-<k>.md  pr-body-src.md
```
Your own clone of the target repo is never modified. The factory adds git worktrees to it, and those live under `projects/`.

### Rules the factory enforces
- Build ⇄ review is capped at **3 rounds** per stage (`review.maxRounds`). After that, the stage is marked **needs you**. Unblock it with `/factory-approve <project> <feature> <guidance>`.
- **The next stage starts only after the previous PR is merged.** It branches from the updated base.
- The factory never merges, force-pushes or rebases shared branches. Its own PR comments carry a hidden marker so they're never mistaken for your feedback.

### PR review comments
Set during `/factory-init` (`prFeedback.mode`):
- `builder-reads-pr` (default): `/factory-next` picks up new PR comments and inline reviews. The builder fixes them, the reviewer re-checks, the fix is pushed, and a summary is posted as a reply.
- `plugin`: you handle PR comments yourself with your Claude plugin. The factory just notes them.
- `webhook`: reserved. It currently behaves like `builder-reads-pr`.

## Running it unattended
`/factory-next` is safe to run repeatedly: it does the next step for each feature and stops at your gates. To poll for merges and comments, schedule it, for example:
```bash
*/15 * * * * cd ~/software-factory && claude -p "/factory-next" >> ~/.factory.log 2>&1
```
Headless runs can't answer permission prompts. During `/factory-init`, say yes to pre-approving the project's commands, which writes them to `.claude/settings.local.json`, or extend the allow list yourself.

## Development
```bash
npm test                 # CLI end-to-end (local bare remote + fake gh) and dashboard API tests
npm run status
```
