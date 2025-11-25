# Jangar persistence (work orders)

Jangar is the control plane UI for Codex background workers. It stores chat context and the work orders that spawn Temporal workflows. This doc defines the single canonical table for those work orders.

## Environment
- `CONVEX_URL` / `CONVEX_DEPLOYMENT`
- `CONVEX_SELF_HOSTED_URL` / `CONVEX_SITE_ORIGIN`
- `CONVEX_DEPLOY_KEY` or `CONVEX_ADMIN_KEY`
- Local default: `http://127.0.0.1:3210`

## Work orders table (Convex)

```mermaid
erDiagram
  work_orders {
    id string PK
    sessionId string FK      // chat session that requested the work
    workflowType string      // Temporal workflow name
    workflowArgs any         // JSON args passed to Temporal
    githubIssueUrl string    // optional source issue
    prompt string            // operator prompt / instruction
    title string             // human label
    status string            // draft|submitted|accepted|running|succeeded|failed|canceled
    createdAt number         // ms
    updatedAt number         // ms
    requestedBy string       // user id / subject
    targetRepo string        // repo URL/path
    targetBranch string      // branch to use or create
    commitSha string         // resulting commit (if produced)
    prUrl string             // resulting PR (if produced)
  }
```

### Column reference
| column | type | notes |
| --- | --- | --- |
| id | string | PK |
| sessionId | string | FK to chat session issuing the order |
| workflowType | string | Temporal workflow name |
| workflowArgs | any | JSON-serializable args for the workflow |
| githubIssueUrl | string | optional source issue/PR |
| prompt | string | operator instruction text |
| title | string | human-readable label |
| status | string | draft \| submitted \| accepted \| running \| succeeded \| failed \| canceled |
| createdAt | number (ms) | timestamp |
| updatedAt | number (ms) | timestamp |
| requestedBy | string | user id / subject that requested the work |
| targetRepo | string | repo URL/path |
| targetBranch | string | branch to use/create |
| commitSha | string | resulting commit SHA (if produced) |
| prUrl | string | resulting PR URL (if produced) |

## Functions to implement (Convex)
- `workOrders:create`
- `workOrders:updateStatus`
- `workOrders:updateResult` (commitSha, prUrl)
- `workOrders:listBySession`
- `workOrders:get`

Indexes
- by `sessionId, createdAt`
- by `status, updatedAt`

Deployment
- `bun packages/scripts/src/jangar/deploy-service.ts` calls `convex deploy` before Knative apply; ensure Convex envs/keys are set.
