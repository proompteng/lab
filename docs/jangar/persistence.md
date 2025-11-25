# Jangar persistence

Jangar is the control plane UI for Codex background workers. It stores chat context (sessions + messages) and work orders that launch Temporal workflows—kept simple and denormalized enough to be practical.

## Environment

- `CONVEX_URL` / `CONVEX_DEPLOYMENT`
- `CONVEX_SELF_HOSTED_URL` / `CONVEX_SITE_ORIGIN`
- `CONVEX_DEPLOY_KEY` or `CONVEX_ADMIN_KEY`
- Local default: `http://127.0.0.1:3210`

## Data model (Convex)

```mermaid
erDiagram
  chat_sessions {
    id string PK
    userId string NN
    title string NN
    lastMessageAt number NN
    createdAt number NN
    updatedAt number NN
    deletedAt number NULL
  }

  chat_messages {
    id string PK
    sessionId string FK NN
    role string NN
    content string NN
    metadata any NULL
    createdAt number NN
    updatedAt number NN
    deletedAt number NULL
  }

  work_orders {
    id string PK
    sessionId string FK NN
    workflowId string NN
    githubIssueUrl string NULL
    prompt string NULL
    title string NULL
    status string NN
    requestedBy string NULL
    targetRepo string NULL
    targetBranch string NULL
    prUrl string NULL
    createdAt number NN
    updatedAt number NN
    deletedAt number NULL
  }

  chat_sessions ||--o{ chat_messages : "chat history"
  chat_sessions ||--o{ work_orders : "work requested from chat"
```

### Column reference

**chat_sessions**

| column | type | nullable | notes |
| --- | --- | --- | --- |
| id | string | no | PK |
| userId | string | no | requester |
| title | string | no | display title |
| lastMessageAt | number (ms) | no | for recency sorting |
| createdAt | number (ms) | no | timestamp |
| updatedAt | number (ms) | no | timestamp |
| deletedAt | number (ms) | yes | null when active |

**chat_messages**

| column | type | nullable | notes |
| --- | --- | --- | --- |
| id | string | no | PK |
| sessionId | string | no | FK chat_sessions.id |
| role | string | no | user \| assistant \| system |
| content | string | no | message text |
| metadata | any | yes | tool calls, attachments, etc. |
| createdAt | number (ms) | no | timestamp |
| updatedAt | number (ms) | no | timestamp |
| deletedAt | number (ms) | yes | null when active |

**work_orders**

| column | type | nullable | notes |
| --- | --- | --- | --- |
| id | string | no | PK |
| sessionId | string | no | FK chat_sessions.id |
| workflowId | string | no | Temporal workflow id/run id |
| githubIssueUrl | string | yes | optional source issue/PR |
| prompt | string | yes | operator instruction |
| title | string | yes | human label |
| status | string | no | draft \| submitted \| accepted \| running \| succeeded \| failed \| canceled |
| requestedBy | string | yes | user id / subject |
| targetRepo | string | yes | repo URL/path |
| targetBranch | string | yes | branch to use/create |
| prUrl | string | yes | resulting PR URL (if produced) |
| createdAt | number (ms) | no | timestamp |
| updatedAt | number (ms) | no | timestamp |
| deletedAt | number (ms) | yes | null when active |

## Functions to implement (Convex)

- `chatSessions:create`, `chatSessions:list`, `chatSessions:get`, `chatSessions:updateLastMessage`, soft-delete handling
- `chatMessages:append`, `chatMessages:listBySession`, soft-delete handling
- `workOrders:create`
- `workOrders:updateStatus`
- `workOrders:updateResult` (prUrl)
- `workOrders:listBySession`
- `workOrders:get`

Indexes

- chat_messages: by `sessionId, createdAt`
- work_orders: by `sessionId, createdAt`; by `status, updatedAt`

Deployment

- `bun packages/scripts/src/jangar/deploy-service.ts` runs `convex deploy` before Knative apply; ensure Convex envs/keys are set.
