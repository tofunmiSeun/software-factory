---
name: factory-init
description: Set up the Software Factory for a code repository. Takes the path to a local git repo, works out its remote, base branch, commands and conventions, then asks the human only what it could not infer. Use when the user wants to point the factory at a new codebase or redo a project's setup.
argument-hint: "<path-to-repo> [--name <project-name>]"
---

# Set up a project

Arguments: `$ARGUMENTS`. The first argument is the path to a local clone of the target repo. `--name` optionally overrides the project name.

Run every state command from the factory root. Never modify the user's own clone.

## 1. Register the repo
```
node scripts/factory.mjs project:create <path> [--name <name>] [--forge github|gitlab]
```
This resolves the repo root, reads the git remote (`origin` by default), parses `owner/repo` (on GitLab it can be `group/subgroup/repo`), detects the base branch, works out whether the host is GitHub or GitLab (`repo.forge`), and creates:
- `projects/<name>/config.json` with detected values and defaults
- `projects/<name>/checkout/`, a read-only detached worktree of `<remote>/<base>` for agents to read

If it says the project already exists, ask whether to re-run setup on the existing config. If yes, use `--force` (this keeps answers and re-detects repo details), then continue.

If there is no remote, explain that PR automation needs a GitHub or GitLab remote and stop.

If `repo.forge` comes back `null`, the host isn't `github.com` or `gitlab.com` and its name doesn't say GitLab. Ask whether it's a self-hosted GitLab. If yes, re-run with `--force --forge gitlab`. Otherwise explain that PR automation supports GitHub and GitLab only, and stop.

Check access to the host:
- **GitHub** (`repo.forge: "github"`): `gh auth status` and `gh repo view <owner/repo> --json name,defaultBranchRef`. If gh isn't logged in, tell the user to run `gh auth login`.
- **GitLab** (`repo.forge: "gitlab"`): `glab auth status --hostname <host>` and `glab repo view <slug> -F json`. If glab isn't installed or logged in, tell the user to install it and run `glab auth login`. The factory opens **merge requests** there; wherever these instructions say PR, it means MR.

Either way, continue with setup if access isn't ready yet.

## 2. Infer what you can from `projects/<name>/checkout`
Investigate quietly, then record each finding with `node scripts/factory.mjs config:set <name> <key> <value>`:
- **commands.install / build / test / lint / typecheck / run**: from `package.json` scripts (and the lockfile for npm/pnpm/yarn/bun), `Makefile`, `pyproject.toml`/`tox.ini`/`noxfile.py`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`, and especially the CI config (`.github/workflows/` on GitHub, `.gitlab-ci.yml` and the files it includes on GitLab). CI shows the commands that actually gate merges. Use `null` for anything that doesn't exist.
- **conventions.docs**: an array of paths (relative to the repo) like `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/architecture*`, style guides.
- **conventions.commitStyle**: look at `git -C projects/<name>/checkout log -30 --format=%s` (e.g. "Conventional Commits", "Imperative sentence, ticket prefix").
- **conventions.prTemplate**: `.github/pull_request_template.md` on GitHub, `.gitlab/merge_request_templates/Default.md` (or the only template there) on GitLab, if present.
- **conventions.branchPrefix**: keep `factory/` unless the repo has an obvious convention from `git branch -r`.
- **offLimits** candidates: migrations folders, infra/terraform, generated code, vendored deps, lockfiles, CODEOWNERS-protected paths. Propose these, but don't set them yet.

## 3. Ask the human what you couldn't infer
First show a short summary of what you detected: remote, base branch, commands, docs, commit style, and proposed off-limits paths.

Then ask with `AskUserQuestion`. Put the recommended option first and skip any question whose answer is already clear. Ask in at most two rounds:

Round 1:
1. **Review lenses** (multi-select): UX, Security, Readability, Simplicity. "Other" lets them add e.g. performance or accessibility. → `review.lenses`
2. **PR size**: "Small: one concern per PR (Recommended)", "Medium: one coherent slice per PR", "One PR per feature". → `planning.prSize`
3. **Approval gates**: "Approve spec and plan (Recommended)", "Approve spec only; auto-approve plan", "Auto-approve the plan for single-stage features only". → `gates.spec`, `gates.plan` (for the third option set `gates.plan` to `"multi-stage-only"`)
4. **PR review comments**: "Builder agent reads and fixes PR comments (Recommended)", "I handle PR comments with my Claude plugin", "Webhooks (not built yet; falls back to the builder)". → `prFeedback.mode` = `builder-reads-pr` | `plugin` | `webhook`

Round 2 (only what's still open):
- Confirm or correct any command you couldn't detect confidently (offer the detected value as the first option).
- **Off-limits paths**: offer your proposed list, "None", or Other to type paths. → `offLimits` (array of globs)
- **Factory identity**: skip this question if `identity.name` and `identity.email` are already set (they come from the factory-wide `projects/defaults.json`); just show them in the summary. Otherwise: PRs/MRs and comments are posted through `gh` or `glab` as the user's own login, but commits can carry a different name and email, and comments get a signature line. Get the user's email from `git -C <repo> config user.email` and offer "Software Factory <local+factory@domain> (Recommended)" (plus-addressing; for a `@users.noreply.github.com` address offer the address as is), "Use my own name and email", and Other. Explain that a plus-address not added to their GitHub or GitLab account shows as a plain name with no avatar; added as a verified email, commits link to their account but still show the factory name. → `identity.name`, `identity.email` (leave both `null` for their own); `identity.signature` stays `🤖 Software Factory` unless they ask otherwise
- **Watch PRs for reviews**: "Every 15 minutes (Recommended)", "Every 30 minutes", "Hourly", "Don't watch; I'll run /factory-next myself". Say in the descriptions that a scheduled task checks the factory's open PRs (MRs on GitLab) with `gh` or `glab`; when there is a new review or comment (or a merge, or other agent work), it runs `/factory-next` for this project, so the builder addresses the review without you. Checks that find nothing stop right away. → `prWatch.enabled`, `prWatch.intervalMinutes`
- **Pre-approve commands**: ask whether to add the project's install/build/test/lint/typecheck commands to `.claude/settings.local.json` `permissions.allow` (as `Bash(<command>:*)` entries) so agents can run them without prompting. Only edit that file if they say yes. Merge with what's already there.

The build/review loop limit is 3 (`review.maxRounds`) and the next stage starts only after the previous PR merges (`planning.nextStageTrigger: "merge"`). Don't ask about these. Mention them in the summary, and that stacked PRs are available: `config:set <project> planning.nextStageTrigger stack` (with `planning.maxStackDepth`, default 2) lets stage N+1 be built and reviewed while stage N's PR is open. Only change it if the user asks.

Issues are provided manually for now (`issues.source: "manual"`). Don't ask about this.

## 4. PR watcher
Skip this if the user chose not to watch PRs (`config:set <name> prWatch.enabled false`).

Otherwise set `prWatch.enabled true` and `prWatch.intervalMinutes <n>`, then create a scheduled task with the `create_scheduled_task` tool (`mcp__scheduled-tasks__create_scheduled_task`). If the tool isn't available, say the watcher couldn't be set up here and the user can run `/factory-next <name>` by hand, then continue.
- `taskId`: `factory-watch-<name>`. If it's taken by an earlier setup of this project (check `list_scheduled_tasks`), update that task instead of creating a second one.
- `title`: `Factory: watch <name> PRs`
- `cronExpression`: `*/15 * * * *`, `*/30 * * * *` or `0 * * * *`
- `description`: `Runs /factory-next for <name> when a factory PR gets a review, comment or merge`
- `prompt` (fill in the absolute factory path; the run starts with no memory, so keep it self-contained):
  ```
  You are the Software Factory orchestrator at <absolute factory path>. Work only in that folder and follow its CLAUDE.md.
  1. Run: node <absolute factory path>/scripts/factory.mjs watch:check <name>
  2. If "work" is false or "running" is true, reply with one line (e.g. "nothing new" or "a run is already in progress") and stop. Do nothing else.
  3. Otherwise read <absolute factory path>/.claude/skills/factory-next/SKILL.md and follow it for project <name> only, including taking and releasing the run lock. Stop at human gates; never approve, merge or force-push.
  4. End with a short summary: which PR reviews were addressed, PRs updated or opened, and anything now waiting on the human.
  ```
Record the task id: `config:set <name> prWatch.taskId factory-watch-<name>`.
Tell the user: the watcher runs only while the Claude desktop app is open (a missed run happens on next launch), each run that finds work spends tokens like a manual `/factory-next`, and they can pause it from the app's scheduled tasks list.

## 5. Finish
```
node scripts/factory.mjs config:set <name> setupComplete true
node scripts/factory.mjs event <name> - project.setup "Setup complete"
```
Reply with a compact summary of the final config, then the next step:
`/factory-issue <name> <describe what you want built>`.
