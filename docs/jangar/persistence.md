# Jangar persistence (chat + work orders, 5NF)

Jangar stores chat context and work orders that launch Temporal workflows. The work-order data is normalized so each fact lives in exactly one place and joins are lossless (5NF-oriented).

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
    userId string
    title string
    createdAt number
    updatedAt number
  }

  chat_messages {
    id string PK
    sessionId string FK
    role string
    content string
    metadata any
    createdAt number
  }

  work_orders {
    id string PK
    sessionId string FK
    workflowType string
    prompt string
    title string
    status string
    requestedBy string
    createdAt number
    updatedAt number
  }

  work_order_args {
    id string PK
    workOrderId string FK
    name string
    value any
  }

  work_order_targets {
    workOrderId string PK
    targetRepo string
    targetBranch string
  }

  work_order_links {
    id string PK
    workOrderId string FK
    kind string
    value string
  }

  chat_sessions ||--o{ chat_messages : "chat history"
  chat_sessions ||--o{ work_orders : "requested work"
  work_orders ||--o{ work_order_args : "args"
  work_orders ||--|| work_order_targets : "target"
  work_orders ||--o{ work_order_links : "refs (issue/pr/commit)"
```

### Column reference

**chat_sessions**
| column | type | notes |
| --- | --- | --- |
| id | string | PK |
| userId | string | requester |
| title | string | display title |
| createdAt | number (ms) | timestamp |
| updatedAt | number (ms) | timestamp |

**chat_messages**
| column | type | notes |
| --- | --- | --- |
| id | string | PK |
| sessionId | string | FK chat_sessions.id |
| role | string | user \| assistant \| system |
| content | string | message text |
| metadata | any | tool calls, attachments, etc. |
| createdAt | number (ms) | timestamp |

**work_orders**
| column | type | notes |
| --- | --- | --- |
| id | string | PK |
| sessionId | string | FK chat_sessions.id |
| workflowType | string | Temporal workflow name |
| prompt | string | operator instruction |
| title | string | human label |
| status | string | draft \| submitted \| accepted \| running \| succeeded \| failed \| canceled |
| requestedBy | string | user id / subject |
| createdAt | number (ms) | timestamp |
| updatedAt | number (ms) | timestamp |

**work_order_args** (multi-valued workflow parameters)
| column | type | notes |
| --- | --- | --- |
| id | string | PK |
| workOrderId | string | FK work_orders.id |
| name | string | argument name |
| value | any | argument value |

**work_order_targets** (one-to-one)
| column | type | notes |
| --- | --- | --- |
| workOrderId | string | PK/FK work_orders.id |
| targetRepo | string | repo URL/path |
| targetBranch | string | branch name |

**work_order_links** (normalized references)
| column | type | notes |
| --- | --- | --- |
| id | string | PK |
| workOrderId | string | FK work_orders.id |
| kind | string | github_issue \| pr \| commit |
| value | string | URL or SHA |

## Functions to implement (Convex)
- `chatSessions:create`, `chatSessions:list`, `chatSessions:get`
- `chatMessages:append`, `chatMessages:listBySession`
- `workOrders:create`
- `workOrders:updateStatus`
- `workOrderArgs:upsert`
- `workOrderTargets:upsert`
- `workOrderLinks:add`
- `workOrders:listBySession`
- `workOrders:get`

Indexes
- chat_messages: by `sessionId, createdAt`
- work_orders: by `sessionId, createdAt`; by `status, updatedAt`
- work_order_args: by `workOrderId, name`
- work_order_links: by `workOrderId, kind`

Deployment
- `bun packages/scripts/src/jangar/deploy-service.ts` runs `convex deploy` before Knative apply; ensure Convex envs/keys are set.
