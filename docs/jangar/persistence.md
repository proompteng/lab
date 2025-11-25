# Jangar persistence (Convex control plane)

Jangar is the control plane UI for Codex background workers. It tracks chat sessions, work orders, Temporal runs, step logs, and artifacts in Convex (no Postgres/Drizzle).

## Environment

- `CONVEX_URL` or `CONVEX_DEPLOYMENT`: Convex deployment URL for prod.
- `CONVEX_SELF_HOSTED_URL` / `CONVEX_SITE_ORIGIN`: self-hosted endpoint (e.g., `https://convex.proompteng.ai/http`).
- `CONVEX_DEPLOY_KEY` or `CONVEX_ADMIN_KEY`: required for deploys and server-to-server calls.
- Local default: `http://127.0.0.1:3210` when not set.

## Local workflow

1. `cd services/jangar && bun install`
2. In another shell: `bunx convex dev` (dev deployment + codegen/watch).
3. Run UI/worker: `bun run dev:all` (convex + UI + single worker).

## Convex schema & functions

- Schema: `services/jangar/convex/schema.ts`
- Functions (mutations/queries under `services/jangar/convex/`):
  - `sessions:create`, `sessions:list`, `sessions:getWithThreads`
  - `threads:append`
  - `workOrders:createFromMessage`, `workOrders:listBySession`
  - `runs:start`, `runs:updateStatus`, `runs:getDashboard`, `runs:getTimeline`
  - `steps:appendOrUpdate`
  - `artifacts:add`
  - `events:append`

### Data model (Convex)

```mermaid
erDiagram
  sessions {
    string id PK
    string userId
    string title
    number createdAt
    number updatedAt
  }

  threads {
    string id PK
    string sessionId FK
    string role
    string content
    any    metadata
    number createdAt
  }

  work_orders {
    string id PK
    string sessionId FK
    string triggerMessageId FK
    string summary
    string repo
    string branchHint
    string status
    number createdAt
    number updatedAt
  }

  runs {
    string id PK
    string workOrderId FK
    string temporalWorkflowId
    string taskQueue
    string status
    string workerId
    string repo
    string branch
    string prUrl
    string commitSha
    number startedAt
    number endedAt
    any    failureReason
  }

  steps {
    string id PK
    string runId FK
    string name
    string kind
    string status
    number startedAt
    number endedAt
    any    payload
    string logUrl
  }

  artifacts {
    string id PK
    string runId FK
    string type
    string url
    string label
    number createdAt
  }

  events {
    string id PK
    string runId FK
    string workOrderId FK
    string type
    any    data
    number createdAt
  }

  sessions ||--o{ threads : "messages"
  sessions ||--o{ work_orders : "work created from chat"
  work_orders ||--o{ runs : "Temporal runs"
  runs ||--o{ steps : "activities/checkpoints"
  runs ||--o{ artifacts : "PRs, logs, diffs"
  runs ||--o{ events : "state changes"
```

## Deployment

- `bun packages/scripts/src/jangar/deploy-service.ts` runs `convex deploy` before updating the Knative service.
- Ensure Convex env vars/keys are present in the deploy environment.
