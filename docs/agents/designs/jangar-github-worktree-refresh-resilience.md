# Jangar GitHub Worktree Refresh Resilience

Status: Proposed (2026-03-04)

## Current state

- `github-review-ingest` and `github-review-handlers` trigger `refreshWorktreeSnapshot()` on pull request updates and file refresh APIs.
- A missing-ref error currently sets an in-process timer in both callsites, then retries after a fixed window (`WORKTREE_REFRESH_FAILURE_TTL_MS`).
- That timer state is lost on pod restart, and suppression decisions are never observable in DB.
- In production logs we observed repeated `Unable to resolve git ref` warnings for PRs even after repeated webhook traffic, indicating repeated expensive refresh attempts.

## Problem

- Refresh suppression is ephemeral and instance-local.
- No persistent failure state means clusters can retry immediately after recycle, causing repeated Git worktree churn and noisy logs.
- Operators cannot quickly answer “is this PR refresh currently suppressed due to a known Git ref issue?” from queryable data.
- Existing database schema lacks fields to track refresh health/skip windows.

## Design goals

- Add persistent, queryable refresh suppression state to `jangar_github.pr_worktrees`.
- Keep behavior safe under both API-triggered and webhook-triggered refresh flows.
- Minimize blast radius and schema churn (additive columns only).
- Preserve current observability improvements and dedupe semantics while adding resilience across process restarts.

## Chosen design

- Add `jangar_github.pr_worktrees.refresh_failure_reason`, `refresh_failed_at`, and `refresh_blocked_until`.
- Extend `GithubPrWorktree` and `upsertPrWorktree` in `services/jangar/src/server/github-review-store.ts` to carry refresh-failure state.
- On missing-ref failures in ingest/API refresh paths:
  - keep existing in-memory cooldown map for intra-process dedupe;
  - persist `refresh_failure_reason`, `refresh_failed_at`, and `refresh_blocked_until` in DB (when worktree metadata exists).
- On successful snapshot completion:
  - clear persisted refresh-failure fields.
- On refresh decision:
  - prefer DB suppression (`refresh_blocked_until`) over starting a new worktree refresh.
  - then fallback to in-process cooldown state.
- Update regression tests to assert:
  - suppressions are not re-triggered by immediate repeated events;
  - DB-sourced suppression blocks API refresh calls.

## Files changed

- `services/jangar/src/server/db.ts`
  - added `refresh_failure_reason`, `refresh_failed_at`, `refresh_blocked_until` to `JangarGithubPrWorktrees`.
- `services/jangar/src/server/migrations/20260304_jangar_github_worktree_refresh_state.ts`
  - added migration for the three new columns plus index.
- `services/jangar/src/server/kysely-migrations.ts`
  - registered the migration.
- `services/jangar/src/server/github-review-store.ts`
  - extended `GithubPrWorktree` and `upsertPrWorktree()` mapping.
- `services/jangar/src/server/github-worktree-snapshot.ts`
  - clears refresh-failure fields on successful refresh upsert.
- `services/jangar/src/server/github-review-ingest.ts`
  - reads/stores DB suppression state before deciding whether to refresh.
  - writes DB suppression metadata on missing-ref failures.
- `services/jangar/src/server/github-review-handlers.ts`
  - same DB-state checks/writes for API-triggered refresh.
- `services/jangar/src/server/__tests__/github-review-ingest.test.ts`
- `services/jangar/src/server/__tests__/github-review-api.test.ts`
  - added regression coverage around DB-backed suppression.

## Alternatives and tradeoffs

- A) Keep current in-memory suppression only.
  - Pros: zero schema changes, no new persistence concerns.
  - Cons: suppression lost on restart, repeated noisy failures during recovery, no persistent operator visibility.
- B) Add separate dedicated retry state table.
  - Pros: stronger separation of concerns and potentially richer retry metadata.
  - Cons: extra schema + queries + migration churn for a single table (`pr_worktrees`) already modeling this lifecycle.
- C) **Selected**: extend `pr_worktrees` with refresh-failure columns.
  - Pros: minimal schema additions, direct co-location with worktree metadata, low migration surface.
  - Cons: depends on row existence; first-time failures may not persist until row creation.
- D) Track suppression in Redis.
  - Pros: shared across pods.
  - Cons: additional infra dependency and more operational coupling for this path.

## Risks

- If `pr_worktrees` row has never been created for a PR, DB suppression cannot be persisted for the first missing-ref event.
- Stale `refresh_blocked_until` values require periodic cleanup when worktree metadata is rewritten.
- Configurable TTL is currently environment driven and not yet surfaced in dedicated docs; a default of 60 seconds is still used.

## Rollout / validation

- Run unit tests for ingest and API handlers.
- Run Jangar lint/format checks for touched source.
- Verify migration registration against file list.
- Validate cluster logs stop repeating immediate missing-ref refresh retries under a sustained webhook storm.
