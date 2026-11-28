# Pull request process

## Establish current state

```bash
git status --short --branch
git rev-parse HEAD
gh auth status --active --hostname github.com
gh pr view --json number,url,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
```

Record the exact head before relying on test, review, or merge-readiness evidence.

## Commit and PR contract

- Use a Conventional Commit and matching PR title: `<type>(<scope>): <summary>`.
- Build the body from `.github/PULL_REQUEST_TEMPLATE.md`.
- Describe only actual changes and validation. Remove placeholders and use `N/A` where appropriate.
- Stage only explicitly owned paths; never use `git add -A` in a dirty worktree.

## PR creation

Use the helper when interactive editing is appropriate:

```bash
skills/pr-process/scripts/pr-create.sh --title 'fix(scope): summary'
```

To supply an already completed body:

```bash
PR_BODY_PATH=/absolute/path/pr-body.md skills/pr-process/scripts/pr-create.sh --title 'fix(scope): summary'
```

The helper creates a pull request, so run it only when that external mutation is authorized.

## Exact-head readiness

```bash
VERIFIED_HEAD=$(gh pr view <pr> -R proompteng/lab --json headRefOid --jq .headRefOid)
gh pr view <pr> -R proompteng/lab --json headRefOid,baseRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr checks <pr> -R proompteng/lab
```

Inspect every actionable review thread and relevant failing log. A PR is ready only when the tested and reviewed commit equals the remote head, required checks are green, actionable feedback is handled, and the PR is mergeable.

## Merge

For an approved PR:

```bash
gh pr merge <pr> --squash --match-head-commit "$VERIFIED_HEAD" -R proompteng/lab
```

Use the `VERIFIED_HEAD` recorded before readiness checks. If the head changes, rerun the checks and review audit before
recording a new value. Do not pass `--delete-branch`; shared worktrees may still reference stack branches.
