# Jangar GitHub PR Reviews + Merge (In-App)

Status: Draft
Owner: Jangar
Last updated: 2026-01-02

## Summary
Enable GitHub pull request review and merge workflows directly inside the Jangar UI. Users should be able to open a PR, read the diff, participate in review threads, submit a review (approve / request changes / comment), and merge once checks and review requirements are satisfied.

This design builds on existing Jangar capabilities:
- GitHub integration in `services/jangar/src/server/github-client.ts` (PR lookup, review summaries, diffs).
- Codex judge run history UI in `services/jangar/src/routes/codex/runs.tsx` (shows PR link + review status).
- Codex judge review gating logic in `services/jangar/src/server/codex-judge.ts`.
- Jangar server-side routes pattern (`/routes/api/*`) with JSON handlers.

## Goals
- Review completion from within Jangar (submit review + resolve threads).
- Merge PRs from within Jangar (squash / merge / rebase), with safety checks.
- Surface PR context: checks, review summary, unresolved threads, files + diff, commit history.
- Keep Codex judge state in sync when the PR is associated with a run.
- Avoid polling GitHub; rely on Froussard-propagated webhook events for state changes.

## Non-goals
- Replace GitHub UI completely (still link out for advanced tasks).
- Implement a full auth/SSO system from scratch (use existing gateway or service token policy).
- Build a full GitHub client library (only endpoints required for review + merge flows).

## Current State (Relevant Implementation)
- `services/jangar/src/server/github-client.ts` supports:
  - `getPullRequest`, `getPullRequestByHead`, `getCheckRuns`, `getPullRequestDiff`, `getReviewSummary`.
  - Basic content/branch update + PR creation.
- `services/jangar/src/server/codex-judge.ts`:
  - Fetches PR data + review summary and gates completion.
  - Stores review status + summary in `codex_judge.runs`.
- `/codex/runs` UI already shows `reviewStatus`, `reviewSummary`, and PR links but does not allow interaction.
- Froussard owns GitHub webhook intake and publishes events into Kafka:
  - Raw: `github.webhook.events` (see `apps/froussard/README.md`).
  - Filtered for Codex judge: `github.webhook.codex.judge` (see `apps/froussard/README.md` and `argocd/applications/froussard/github-webhook-codex-judge-topic.yaml`).
- Jangar already ingests the filtered Codex judge stream via a KafkaSource to `/api/codex/github-events`:
  - `argocd/applications/jangar/codex-github-events-kafkasource.yaml`
  - Handler: `services/jangar/src/routes/api/codex/github-events.tsx`
- The filtered stream currently includes PR + review + CI events only (see `CODEX_JUDGE_EVENT_TYPES` in `apps/froussard/src/webhooks/github.ts`).

## UX Overview
### Navigation
Add a new sidebar entry:
- **PR Reviews** (new section under App)
  - `/github/pulls` list view
  - `/github/pulls/$owner/$repo/$number` detail view

### List View (PRs)
- Filters: repository, author, label, state (open/closed/merged), review decision, CI status.
- Table showing PR number, title, author, updated time, review decision, checks summary.

### Detail View (PR)
- Header: title, repo, branch, status pills, mergeable state.
- Tabs:
  - **Overview**: metadata, reviewers, labels, milestones, CI summary, review summary.
  - **Files**: file list + patch viewer + inline comments.
  - **Conversation**: issue comments + review comments.
  - **Checks**: required checks + individual check runs.
- Action panel (right side):
  - Review composer (approve / request changes / comment).
  - Resolve thread action.
  - Merge controls (method + title/message + delete branch).
  - Quick links (open on GitHub, open CI run, open Codex runs for linked issue).

### Review Composer
- Supports:
  - Summary body.
  - Inline comments (file + line + side + body).
  - Submit options: Approve / Request changes / Comment.
- Optional: draft review (saved locally) with discard.

### Merge Controls
- Display readiness checks:
  - `mergeable_state` + `mergeable`.
  - Required checks status.
  - Required reviews status (review decision, unresolved threads).
- Merge methods: `merge`, `squash`, `rebase` (based on repo settings).
- Post-merge options: delete branch.

## Backend API Design
### New Routes (server-side)
All routes live under `services/jangar/src/routes/api/github/*` and follow the existing JSON handler style.

1) `GET /api/github/pulls`
- Query params: `repository`, `state`, `author`, `label`, `reviewDecision`, `limit`, `cursor`.
- Returns: list of PRs + pagination cursor + lightweight status (checks + review decision).

2) `GET /api/github/pulls/:owner/:repo/:number`
- Returns: PR metadata, review summary, checks summary, mergeable state.

3) `GET /api/github/pulls/:owner/:repo/:number/files`
- Returns: file list + patches + blob URLs.
- Optional params: `limit`, `cursor`.

4) `GET /api/github/pulls/:owner/:repo/:number/threads`
- Returns: review threads (resolved + unresolved) with comments + positions.

5) `POST /api/github/pulls/:owner/:repo/:number/review`
- Body: `{ event: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT', body, comments: [{ path, line, side, body, startLine? }] }`.
- Returns: created review metadata + refreshed review summary.

6) `POST /api/github/pulls/:owner/:repo/:number/merge`
- Body: `{ method: 'merge'|'squash'|'rebase', commitTitle?, commitMessage?, deleteBranch? }`.
- Returns: merge result + new PR state + optional branch deletion result.

7) `POST /api/github/pulls/:owner/:repo/:number/threads/:threadId/resolve`
- Body: `{ resolve: true|false }`.
- Returns: updated thread state.

### Event Ingestion (No Polling)
Jangar must not poll GitHub for PR state. Instead, it consumes webhook-derived events published by Froussard and updates local state used by the UI:

```mermaid
flowchart LR
  GH[GitHub Webhooks] --> FR[Froussard]
  subgraph Kafka[Kafka Topics]
    RAW[github.webhook.events]
    CJ[github.webhook.codex.judge]
  end
  FR -->|raw payloads| RAW
  FR -->|filtered PR + review + CI| CJ
  CJ --> KS[KafkaSource jangar-codex-github-events]
  KS --> JAPI[/api/codex/github-events]
  JAPI --> JDB[(Jangar DB)]
  JDB --> JUI[Jangar PR Review UI]
```

- **Source of truth**: Froussard receives GitHub webhooks and propagates them via Kafka topics.
  - Raw topic: `github.webhook.events` (full webhook payloads).
  - Filtered Codex judge topic: `github.webhook.codex.judge`.
- **Existing pattern**: `/api/codex/github-events` already handles the filtered stream (CI + PR review gating) and is wired via KafkaSource in `argocd/applications/jangar/codex-github-events-kafkasource.yaml`.
- **Event types currently included in the filtered stream** (from `apps/froussard/src/webhooks/github.ts`):
  - `check_run`, `check_suite` (CI status).
  - `pull_request` (PR metadata + head SHA updates).
  - `pull_request_review` (review submissions/edits/dismissals).
  - `pull_request_review_comment` (inline review comments).
  - `issue_comment` (PR issue comments; only forwarded when comment is on a PR).
- **CI + PR + review comments propagation**:
  - Use `github.webhook.codex.judge` for PR + review + CI signals; `check_run`/`check_suite` cover GitHub Actions checks today.
  - If we need additional CI events (e.g., `status`, `workflow_run`), extend `CODEX_JUDGE_EVENT_TYPES` in `apps/froussard/src/webhooks/github.ts` and keep routing through the same topic.
- **Ingestion endpoint**:
  - Keep using `/api/codex/github-events` for the filtered stream.
  - If we need broader PR UI coverage (labels, assignees, merges, etc.), either:
    1) extend Froussard’s filtered stream to include more events, or
    2) add a new KafkaSource that consumes `github.webhook.events` into a new Jangar endpoint (e.g., `/api/github/events`) and persists the additional fields.
- **Storage**: write into a `jangar_github` schema (or extend `codex_judge`) that powers `GET /api/github/*` responses without polling.
- **UI freshness**: use SSE/websocket stream (optional) to push new events to the UI; otherwise, allow manual refresh that hits Jangar’s DB only.

### Backend Services
Extend `services/jangar/src/server/github-client.ts` with:
- `listPullRequests` (REST `GET /repos/:owner/:repo/pulls` + filters).
- `getPullRequestFiles` (REST `GET /repos/:owner/:repo/pulls/:number/files`).
- `getReviewThreads` (GraphQL `reviewThreads` + comment pagination).
- `submitReview` (REST `POST /repos/:owner/:repo/pulls/:number/reviews`).
- `resolveReviewThread` (GraphQL `resolveReviewThread` / `unresolveReviewThread`).
- `mergePullRequest` (REST `PUT /repos/:owner/:repo/pulls/:number/merge`).
- `deleteBranch` (REST `DELETE /repos/:owner/:repo/git/refs/heads/:branch`).
- `getStatusCheckRollup` (GraphQL `statusCheckRollup` for PR head ref).

All calls should reuse the existing rate-limited queue in `github-client.ts`.

**Note:** These GitHub client calls should be used only for write actions (review submission, merge, resolve) or one-time backfills; steady-state reads must come from webhook-ingested state to avoid polling. This aligns with the current Codex judge pipeline (filtered Kafka stream + no polling), documented in `docs/jangar/codex-judge-argo-implementation.md`.

## Data Model / Persistence
### Minimal viable (no polling)
- Store PR + review + checks state from Froussard events in DB and serve from there.
- Use GitHub API only for write actions or one-time backfill when a PR is first viewed (optional, gated).

### Recommended (Audit + Drafts)
Add a lightweight schema (new `jangar_github` or extend `codex_judge`) for:
- `review_actions`: timestamp, actor, repo, pr number, event, body, inline comments count, GitHub response id.
- `merge_actions`: timestamp, actor, repo, pr number, method, result.
- `review_drafts`: optional per-user local drafts (if auth exists).
- `pr_state`: latest PR metadata + mergeability + checks summary.
- `review_state`: latest review decision + unresolved thread metadata.
- `events`: raw webhook events (for debugging + replay).

## Auth + Permissions
Current Jangar surfaces are unauthenticated and rely on network guardrails. Review + merge are sensitive and require explicit policy:
- **Preferred**: Jangar behind SSO (reverse proxy) that injects a trusted identity header. Map identity to GitHub user or use GitHub App on behalf of user (OAuth).
- **Fallback**: use a single service token (`GITHUB_TOKEN`) and require `JANGAR_GITHUB_ACTION_TOKEN` header for review/merge routes.
- **Guardrails**:
  - Allowlist repositories (`JANGAR_GITHUB_REPOS_ALLOWED`).
  - Disallow merge unless `mergeable_state` is clean and required checks/reviews are green, unless `JANGAR_GITHUB_MERGE_FORCE=true`.
  - Audit log every write action.

## Codex Judge Integration
- When a PR is linked to a Codex run, refresh `codex_judge.runs.review_status` after review submission.
- After merge, update run status to `completed` only if Codex judge already passed (do not override the judge). Keep merge status as supplemental metadata.
- If the review is from Codex bot, continue to use existing webhook ingest (`/api/codex/github-events`).

## Observability
- Add counters for:
  - `jangar_github_review_submitted_total` (by outcome).
  - `jangar_github_merge_attempts_total` / `jangar_github_merge_failures_total`.
- Log structured fields: repo, PR number, actor, action, request id.

## Rollout Plan
1) **Event ingestion**: consume Froussard topic and persist PR/review/checks state (no polling).
2) **Read-only**: PR list + detail view sourced from DB (metadata, checks, review summary, diff, threads).
2) **Review write**: submit review + resolve threads (guarded behind feature flag `JANGAR_GITHUB_REVIEWS_WRITE=true`).
3) **Merge**: enable merge endpoint + UI button (feature flag `JANGAR_GITHUB_MERGE_WRITE=true`).

## Open Questions
- Should reviews be tied to the user identity (OAuth) or a service bot?
- Do we need to support draft reviews or comment batching?
- Which repos are in scope (default allowlist)?
- How should merge conflicts be surfaced (status + guidance)?
- Do we need a PR-level lock to avoid concurrent merges?

## Appendix: Existing Code Pointers
- GitHub client: `services/jangar/src/server/github-client.ts`
- Codex judge review gate: `services/jangar/src/server/codex-judge.ts`
- Run history UI: `services/jangar/src/routes/codex/runs.tsx`
- API route style: `services/jangar/src/routes/api/terminals.ts`
