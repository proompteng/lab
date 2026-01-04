# Autonomous Codex End-to-End Delivery Design

Date: 2026-01-04
Status: Design draft for immediate implementation
Owner: Jangar
Scope: An end-to-end autonomous Argo workflow run that completes implementation, tests, PR, judging, merge, deploy, and post-deploy verification.

## 1) Ground Truth Snapshot

This design is grounded in the current cluster and the `jangar` database.

### 1.1 Kubernetes
- Namespace `jangar`
  - Pods: `jangar` (2 containers), `bumba` (2 pods), `jangar-db-1`, `jangar-openwebui-redis-0`, `open-webui-0`
  - Services: `jangar`, `jangar-db-rw/ro/r`, `jangar-openwebui-redis`, `open-webui`, `jangar-tailscale`
- Namespace `argo-workflows`
  - Completed `github-codex-implementation-*` workflows exist (e.g. `github-codex-implementation-20260103-*`).
- Namespace `nats` exists (NATS cluster running).
- Namespace `facteur` exists with `facteur-internal` service.

### 1.2 CNPG and Postgres
- CNPG cluster: `jangar-db` in namespace `jangar`, Postgres 17.0, backup to `s3://argo-workflows/cnpg/jangar`.
- Database: `jangar` with schemas: `codex_judge`, `jangar_github`, `workflow_comms`, `terminals`, `memories`, `atlas`, `public`.

### 1.3 Current DB Counts (2026-01-04)
```
 codex_judge.runs              88
 codex_judge.evaluations       60
 codex_judge.artifacts         120
 codex_judge.prompt_tuning     9
 codex_judge.rerun_submissions 13

 jangar_github.events          513
 jangar_github.pr_state        2
 jangar_github.review_state    1
 jangar_github.check_state     15
 jangar_github.pr_files        2
 jangar_github.review_threads  2
 jangar_github.comments        3
 jangar_github.write_actions   0

 workflow_comms.agent_messages 326
 terminals.sessions            23
 memories.entries              918
```

### 1.4 Observed Gaps
- `jangar_github.pr_files` has only 2 rows, so PR file snapshots are incomplete and must be sourced from the local worktree only.
- `jangar_github.check_state` stores per-commit check summaries, so UI must group checks by commit SHA.
- `jangar_github.write_actions` is empty, so no automated merges have been recorded yet.

## 2) Objective

Deliver an end-to-end autonomous run that:
1) provisions a deterministic worktree
2) implements changes
3) runs tests
4) creates or updates a PR
5) captures authoritative file snapshots from the local filesystem
6) gates on CI and review state
7) performs judge evaluation
8) merges the PR when safe
9) deploys
10) runs post-deploy integration and end-to-end tests
11) persists artifacts, logs, and audit data

If any gate fails, the system must record why and either rerun or escalate to `needs_human`.

## 3) Constraints and Non-Negotiables

- **No API backfill for PR files or patches.** The local filesystem is the only source of truth.
- PR checks must be grouped by commit SHA.
- The run must be idempotent and safe to re-enter after retries.
- All major steps must persist artifacts and logs.

## 4) Existing Code Baseline

### Codex Judge
- `services/jangar/src/server/codex-judge.ts`
- `services/jangar/src/server/codex-judge-store.ts`
- `services/jangar/src/server/codex-judge-gates.ts`
- Argo artifacts via `services/jangar/src/server/argo-client.ts`

### GitHub Review
- `services/jangar/src/server/github-review-ingest.ts`
- `services/jangar/src/server/github-review-store.ts`
- `services/jangar/src/server/github-review-actions.ts`

### Worktrees
- `services/jangar/src/server/bumba.ts`
- `services/jangar/src/server/terminals.ts`
- `services/jangar/src/server/chat.ts`

### Agent Comms
- `services/jangar/src/server/agent-comms-subscriber.ts`
- `services/jangar/src/routes/api/agents/events.ts`

## 5) Architecture Overview

```mermaid
flowchart LR
  GH[GitHub Issue] --> FRO[Froussard]
  FRO --> KAF[Kafka tasks]
  KAF --> FAC[Facteur]
  FAC --> ARGO[Argo Workflow]
  ARGO --> CODEX[Codex Implementation]
  CODEX --> ART[Artifacts and Logs]
  ARGO --> COMPLETIONS[Argo Events to Kafka completions]
  COMPLETIONS --> JANGAR[Jangar run-complete]
  CODEX -->|notify| JANGAR
  JANGAR --> GHAPI[GitHub API - PR metadata only]
  JANGAR --> DB[(jangar-db)]
  JANGAR --> MEM[(memories.entries)]
  JANGAR --> MERGE[Merge PR]
  MERGE --> DEPLOY[GitOps or Argo Deploy]
  DEPLOY --> VERIFY[Post-deploy tests]
```

## 6) End-to-End Run: Detailed Steps

### 6.1 Inputs
- `repository` (e.g. `proompteng/lab`)
- `issueNumber`
- `base` (e.g. `main`)
- `head` (e.g. `codex/issue-<n>`)
- `prompt`

### 6.2 Worktree Provisioning
**Goal:** authoritative file source.
- Worktree root: `${CODEX_CWD}/.worktrees`.
- Worktree name: `pr-${owner}-${repo}-${issueNumber}`.
- If exists: `git fetch --all` then `git reset --hard <head>`.
- If not: `git worktree add --detach <path> <head>`.
- Record into DB table `jangar_github.pr_worktrees`.

### 6.3 Implementation
- Run Codex agent inside worktree.
- Produce artifacts: changes tarball, patch, logs, events, status.
- Include `metadata/manifest.json` inside the changes archive.

### 6.4 Tests
- Execute repo-appropriate test suites and record results.
- Failures do not skip PR creation; they gate later completion.
- Store output in `codex_judge.artifacts` and logs.

### 6.5 PR Creation or Update
- Use `github.createPullRequest` or update existing PR.
- Persist PR number, URL, and head SHA into `codex_judge.runs`.

### 6.6 Worktree-Only File Snapshot
- Generate diff: `git diff --name-status <base>..<head>`.
- Optional patch: `git diff -U3 <base>..<head>`.
- Store in `jangar_github.pr_files` with `source='worktree'`.
- **Do not use GitHub API for file lists or patches.**

### 6.7 CI and Review Gate
- CI status: `jangar_github.check_state` grouped by commit SHA.
- Review status: `jangar_github.review_state` plus unresolved threads.
- Mergeability: GitHub API `mergeable_state` only.

### 6.8 Codex Judge
- Evaluate via `services/jangar/src/server/codex-judge.ts`.
- Requirements to pass:
  - CI success
  - Review clear
  - Mergeable state acceptable
  - Judge decision pass

### 6.9 Merge
- Use `mergePullRequest` in `github-review-actions.ts`.
- Record audit to `jangar_github.write_actions`.

### 6.10 Deploy
- GitOps preferred: merge triggers Argo CD sync.
- Optional: trigger deploy workflow via Argo API.

### 6.11 Post-Deploy Verification
- After deploy is ready, run integration and end-to-end tests.
- Failures gate completion and force rerun or escalation.
- Record failures as artifacts and judge evaluations.

### 6.12 Persist Evidence
- Store artifacts in `codex_judge.artifacts`.
- Store evaluations in `codex_judge.evaluations`.
- Store memories in `memories.entries`.

## 7) Data Model Changes

### 7.1 `jangar_github.pr_files`
Add `source text not null default 'worktree'`.
- Only worktree snapshots are valid; API backfill is not allowed.

### 7.2 `jangar_github.pr_worktrees` (new)
```
CREATE TABLE jangar_github.pr_worktrees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository text NOT NULL,
  pr_number integer NOT NULL,
  worktree_name text NOT NULL,
  worktree_path text NOT NULL,
  base_sha text,
  head_sha text,
  last_refreshed_at timestamptz NOT NULL,
  UNIQUE (repository, pr_number)
);
```

## 8) API Changes

### 8.1 Judge Runs by PR
`GET /api/github/pulls/:owner/:repo/:number/judge-runs`
- Returns all `codex_judge.runs` for the PR.

### 8.2 Checks Grouped by Commit
`GET /api/github/pulls/:owner/:repo/:number/checks`
- Returns grouped check runs by commit SHA.

### 8.3 Worktree Snapshot Refresh
`POST /api/github/pulls/:owner/:repo/:number/refresh-files`
- Triggers worktree diff and updates `pr_files` with `source='worktree'`.

## 9) UI Requirements
- Replace PR detail navigation with tabs: Overview, Files, Conversation, Checks, Judge.
- Checks tab grouped by commit SHA.
- Files tab shows full tree from worktree snapshot.
- Judge tab links to run history.

## 10) Mermaid Diagrams

### 10.1 Sequence: End-to-End Run
```mermaid
sequenceDiagram
  participant GH as GitHub
  participant FR as Froussard
  participant F as Facteur
  participant A as Argo
  participant C as Codex
  participant J as Jangar
  participant DB as Postgres
  participant CI as GitHub Actions

  GH->>FR: issue event
  FR->>F: submit Codex task
  F->>A: start workflow
  A->>C: run implementation
  C->>A: artifacts and logs
  A->>J: run-complete
  J->>DB: store run and artifacts
  J->>GH: create or update PR
  J->>DB: store worktree file snapshot
  J->>CI: wait for checks
  CI-->>J: status
  J->>J: judge evaluation
  alt pass
    J->>GH: merge PR
    GH-->>J: merged
    J->>A: deploy
    A->>J: deploy ready
    J->>A: post-deploy tests
  else fail
    J->>F: request rerun
  end
```

### 10.2 State: Run Lifecycle
```mermaid
stateDiagram-v2
  [*] --> WorktreeReady
  WorktreeReady --> Implementing
  Implementing --> Testing
  Testing --> PRReady
  PRReady --> AwaitingCI
  AwaitingCI --> Judging
  Judging --> MergeReady
  MergeReady --> Deploying
  Deploying --> Verifying
  Verifying --> Completed
  Judging --> NeedsIteration
  NeedsIteration --> Implementing
  Judging --> NeedsHuman
```

## 11) Implementation Readiness Checklist

A new engineer should be able to implement this in a single run only if all of the following are present:
- An Argo workflow template that includes worktree provisioning, implementation, tests, notify, and artifact upload.
- A Jangar endpoint for worktree snapshot refresh and PR-scoped judge runs.
- DB migrations for `jangar_github.pr_files.source` and `jangar_github.pr_worktrees`.
- Clear, repo-specific test commands defined in the workflow.
- Post-deploy test suite location and commands.

If any of the above are missing, the run will require additional implementation passes.

## 12) Success Criteria
- Worktree snapshot exists for PR with `source='worktree'`.
- CI success and review clear.
- Judge decision pass.
- PR merged and deployment triggered.
- Post-deploy integration and end-to-end tests pass.
- Artifacts, evaluations, and memories persisted.
