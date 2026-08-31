---
name: pr-process
description: Prepare, publish, inspect, and merge pull requests in this repository. Use when creating or updating a PR, checking merge readiness, or merging an approved change.
---

# Pull Request Process

Use this as the repository's single workflow for pull requests. Use `github-issue` for issue-only work.

## Workflow

1. Establish the exact local branch, HEAD, current PR, and base branch. Treat UI state as a lead, not proof.
2. Prepare a Conventional Commit and matching PR title. Fill `.github/PULL_REQUEST_TEMPLATE.md` with only the actual change, validation, risks, and rollout impact.
3. Run focused local validation before publishing. Stage only owned paths.
4. Check the remote PR's exact head, required checks, review threads, conflicts, and merge state. Fix failures in the owning layer and recheck the resulting head.
5. Create, push, update, resolve, or merge externally only when the user requested that mutation. Bind squash merges to the verified head with `--match-head-commit`, and do not delete branches from shared worktrees.
6. Report the verified head, PR state, validation evidence, and any remaining blocker.

## Resources

- Read [references/pr-process.md](references/pr-process.md) for concrete PR commands.
- Use `scripts/pr-create.sh` only when the user asked to create a PR. It refuses to submit an unchanged template.
- Use [assets/pr-checklist.md](assets/pr-checklist.md) for a compact readiness audit.
