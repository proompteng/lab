# Jangar persistence (Convex control plane)

Jangar is the control plane UI for Codex background workers. It tracks chat sessions, workflow requests, Temporal runs, step logs, and artifacts in Convex (no Postgres/Drizzle).

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
  chat_sessions {
    string id PK
    string userId
    string title
    number createdAt
    number updatedAt
  }

  chat_messages {
    string id PK
    string sessionId FK
    string role
    string content
    any    metadata
    number createdAt
  }

  workflow_requests {
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
    string workflowRequestId FK
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

  chat_sessions ||--o{ chat_messages : "chat history"
  chat_sessions ||--o{ workflow_requests : "work created from chat"
  workflow_requests ||--o{ runs : "Temporal runs"
  runs ||--o{ steps : "activities/checkpoints"
  runs ||--o{ artifacts : "PRs, logs, diffs"
  runs ||--o{ events : "state changes"
```

### Tables (columns → data types)

**chat_sessions**
| column | type |
| --- | --- |
| id | string |
| userId | string |
| title | string |
| createdAt | number (ms) |
| updatedAt | number (ms) |

**chat_messages**
| column | type |
| --- | --- |
| id | string |
| sessionId | string (FK chat_sessions.id) |
| role | string (user | assistant | system) |
| content | string |
| metadata | any |
| createdAt | number (ms) |

**workflow_requests**
| column | type |
| --- | --- |
| id | string |
| sessionId | string (FK chat_sessions.id) |
| triggerMessageId | string (FK messages.id) |
| summary | string |
| repo | string |
| branchHint | string |
| status | string (queued | running | succeeded | failed | canceled) |
| createdAt | number (ms) |
| updatedAt | number (ms) |

**runs**
| column | type |
| --- | --- |
| id | string |
| workflowRequestId | string (FK workflow_requests.id) |
| temporalWorkflowId | string |
| taskQueue | string |
| status | string (queued | running | succeeded | failed | canceled) |
| workerId | string |
| repo | string |
| branch | string |
| prUrl | string |
| commitSha | string |
| startedAt | number (ms) |
| endedAt | number (ms) |
| failureReason | any |

**steps**
| column | type |
| --- | --- |
| id | string |
| runId | string (FK runs.id) |
| name | string |
| kind | string (activity | hook | check) |
| status | string (pending | running | succeeded | failed) |
| startedAt | number (ms) |
| endedAt | number (ms) |
| payload | any |
| logUrl | string |

**artifacts**
| column | type |
| --- | --- |
| id | string |
| runId | string (FK runs.id) |
| type | string (pr | diff | file | log | screenshot) |
| url | string |
| label | string |
| createdAt | number (ms) |

**events**
| column | type |
| --- | --- |
| id | string |
| runId | string (FK runs.id) |
| workflowRequestId | string (FK workflow_requests.id) |
| type | string (state_change | comment | system) |
| data | any |
| createdAt | number (ms) |

## Deployment

- `bun packages/scripts/src/jangar/deploy-service.ts` runs `convex deploy` before updating the Knative service.
- Ensure Convex env vars/keys are present in the deploy environment.
