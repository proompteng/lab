# Release PR Automerge Plan (PRs like #3290)

## Goal
- Automatically squash-merge low-risk release PRs like [#3290](https://github.com/proompteng/lab/pull/3290) without manual intervention.
- Keep strong safety gates so only expected bot-generated Argo CD image bump PRs are merged.

## Target PR Shape
- Base branch: `main`
- Head branch: `release/<sha256>`
- Author: GitHub Actions bot (`app/github-actions` or `github-actions[bot]`)
- File changes: allowlist only
  - `argocd/applications/proompteng/kustomization.yaml` (phase 1 scope)
- Merge method: `squash` (matches repo ruleset)

## Existing Foundation
- PR creation is already automated in `.github/workflows/auto-pr-release-branches.yml`.
- Repo ruleset already allows squash merges to `main`.
- Pattern for enabling auto-merge already exists in `.github/workflows/jangar-deploy-automerge.yml`.

## Proposed Implementation

### 1. Add a dedicated automerge workflow
- Create `.github/workflows/release-pr-automerge.yml`.
- Trigger on `pull_request_target` for:
  - `opened`
  - `reopened`
  - `synchronize`
  - `ready_for_review`

### 2. Add strict eligibility gates
- In workflow/job `if` and validation script, require:
  - `github.event.pull_request.base.ref == 'main'`
  - `startsWith(github.event.pull_request.head.ref, 'release/')`
  - PR is not draft
  - PR author login is in allowlist (`app/github-actions`, `github-actions[bot]`)
  - No opt-out label (for example `do-not-automerge`)
  - Changed files are only allowed paths (phase 1: exactly `argocd/applications/proompteng/kustomization.yaml`)

### 3. Enable auto-merge through GitHub CLI
- Use:
  - `gh pr merge "$PR_NUMBER" -R "$REPO" --auto --squash`
- This keeps merge behavior compatible with branch/ruleset protections.

### 4. Add observability and operator control
- Emit explicit log lines for each gate decision (`eligible=true|false`, failed reason).
- Add manual override paths:
  - Label `do-not-automerge` to block automation.
  - Optional label `force-automerge` (maintainers only) for future use.

## Rollout Stages

### Stage 0: Dry run
- Implement workflow logic but replace merge command with logging.
- Validate against real release PR events for 1-2 days.

### Stage 1: Enable for proompteng only
- Turn on real `gh pr merge --auto --squash`.
- Keep file allowlist restricted to:
  - `argocd/applications/proompteng/kustomization.yaml`

### Stage 2: Expand safely
- Expand allowlist to other release-managed app kustomizations after observing stability.
- Keep branch/author/draft/label gates unchanged.

## Safety Constraints
- Never automerge if:
  - Any changed file is outside allowlist.
  - PR author is not expected bot identity.
  - PR is draft.
  - Opt-out label is present.
- Prefer fail-closed behavior (exit without merge on any ambiguity).

## Validation Checklist
- Create a test PR from `release/<sha256>` with only the allowed file changed.
- Confirm workflow logs all gates as passing.
- Confirm auto-merge gets enabled and PR merges by squash.
- Create a negative test:
  - Add a second changed file and verify automerge is skipped.
  - Add `do-not-automerge` and verify skip.

## Documentation Updates
- Update `docs/release-automation.md` with:
  - Eligibility rules
  - Opt-out label behavior
  - Troubleshooting commands (`gh pr view`, `gh run view`, `gh pr checks`)

## Suggested Ownership
- Primary: platform/release automation maintainers
- Review: Argo CD/GitOps owners
