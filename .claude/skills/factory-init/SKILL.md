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
node scripts/factory.mjs project:create <path> [--name <name>]
```
This resolves the repo root, reads the git remote (`origin` by default), parses `owner/repo`, detects the base branch, and creates:
- `projects/<name>/config.json` with detected values and defaults
- `projects/<name>/checkout/`, a read-only detached worktree of `<remote>/<base>` for agents to read

If it says the project already exists, ask whether to re-run setup on the existing config. If yes, use `--force` (this keeps answers and re-detects repo details), then continue.

If there is no remote, or the host isn't `github.com`, explain that PR automation needs a GitHub remote and stop.

Check GitHub access: `gh auth status` and `gh repo view <owner/repo> --json name,defaultBranchRef`. If gh isn't logged in, tell the user to run `gh auth login`, then continue with setup anyway.

## 2. Infer what you can from `projects/<name>/checkout`
Investigate quietly, then record each finding with `node scripts/factory.mjs config:set <name> <key> <value>`:
- **commands.install / build / test / lint / typecheck / run**: from `package.json` scripts (and the lockfile for npm/pnpm/yarn/bun), `Makefile`, `pyproject.toml`/`tox.ini`/`noxfile.py`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`, and especially the CI workflows in `.github/workflows/`. CI shows the commands that actually gate merges. Use `null` for anything that doesn't exist.
- **conventions.docs**: an array of paths (relative to the repo) like `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/architecture*`, style guides.
- **conventions.commitStyle**: look at `git -C projects/<name>/checkout log -30 --format=%s` (e.g. "Conventional Commits", "Imperative sentence, ticket prefix").
- **conventions.prTemplate**: `.github/pull_request_template.md` or similar, if present.
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
- **Pre-approve commands**: ask whether to add the project's install/build/test/lint/typecheck commands to `.claude/settings.local.json` `permissions.allow` (as `Bash(<command>:*)` entries) so agents can run them without prompting. Only edit that file if they say yes. Merge with what's already there.

The build/review loop limit is 3 (`review.maxRounds`) and the next stage starts only after the previous PR merges (`planning.nextStageTrigger: "merge"`). Don't ask about these. Mention them in the summary.

Issues are provided manually for now (`issues.source: "manual"`). Don't ask about this.

## 4. Finish
```
node scripts/factory.mjs config:set <name> setupComplete true
node scripts/factory.mjs event <name> - project.setup "Setup complete"
```
Reply with a compact summary of the final config, then the next step:
`/factory-issue <name> <describe what you want built>`.
