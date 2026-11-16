---
name: factory-status
description: Show the state of every Software Factory project and feature (stages, PRs, what is waiting on the human). Use when the user asks what the factory is doing or what needs their attention.
argument-hint: "[project]"
---

# Factory status

Run `node scripts/factory.mjs status` and `node scripts/factory.mjs next $ARGUMENTS`.

Reply with:
1. A compact table: project · feature · status · stages (with PR numbers).
2. **Waiting on you**: the exact command or PR link for each item.
3. **What /factory-next would do**: the agent steps, and which PRs/MRs are waiting on GitHub or GitLab.

The visual dashboard runs with `npm run dashboard` (http://localhost:4317). If the user asks for it, start it in the background and give them the URL.
