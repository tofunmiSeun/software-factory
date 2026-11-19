---
name: factory-issue
description: Give the Software Factory a new piece of work for a project. Creates a feature from the issue text and has the spec-builder draft spec.md, then stops for human approval. Use when the user describes something they want built in a factory project.
argument-hint: "[project] <issue description>"
---

# New issue → spec

Arguments: `$ARGUMENTS`

## 1. Work out the project and issue text
- `node scripts/factory.mjs project:list`
- If the first word of the arguments is a known project, that's the project and the rest is the issue. If there's exactly one project, use it. Otherwise ask which project.
- If the issue text is empty, ask the user to describe what they want built.
- If the project's `setupComplete` is false, tell the user to finish `/factory-init` first.

## 2. Create the feature
- Pick a short title for the issue (≤ 8 words, imperative).
- Write the issue text exactly as the user gave it to `projects/<project>/.incoming-issue.md`, then:
```
node scripts/factory.mjs feature:create <project> --title "<title>" --issue-file projects/<project>/.incoming-issue.md
node scripts/factory.mjs project:refresh <project>
```
- Delete `.incoming-issue.md` afterwards, or overwrite it next time.

## 3. Draft the spec
Launch the **spec-builder** subagent with this prompt (fill in absolute paths):
```
CONFIG: <factory>/projects/<project>/config.json
CHECKOUT: <factory>/projects/<project>/checkout
FEATURE_DIR: <factory>/projects/<project>/features/<feature>
FEEDBACK: (none)
Write FEATURE_DIR/spec.md for the issue in FEATURE_DIR/issue.md.
```
Check that `spec.md` exists and is non-empty. If it doesn't, retry the subagent once, then report the failure.

## 4. Gate
- If `gates.spec` is true (default):
  `node scripts/factory.mjs feature:status <project> <feature> awaiting_spec_approval`
  Give the spec-builder's summary in one short paragraph. Then open the review card: read `.claude/skills/factory-review/SKILL.md` and follow section 2a ("Spec or plan: review in the plan card") for this feature, acting on the answer as it says. If plan mode isn't available, use its text fallback (2c).
- If `gates.spec` is false: set the status to `planning` and continue with the planning steps in `.claude/skills/factory-review/SKILL.md` ("Approve spec").
