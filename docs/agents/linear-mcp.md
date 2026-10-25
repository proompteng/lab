# Linear Intake And Source-Bound MCP

Status: Current (2026-07-20)

Docs index: [README](README.md)

## Ownership And Data Flow

After the production activation gate is enabled, Froussard owns the public endpoint
`https://froussard.proompteng.ai/webhooks/linear`. It verifies a Linear Issue delivery, audits the
verified raw event to `linear.webhook.events`, and submits an inline AgentRun only when `agentrun`
is present on create or is proven newly added on update.

The AgentRun source is issue provenance only:

```yaml
implementation:
  inline:
    summary: Issue title
    text: Issue description
    source:
      provider: linear
      externalId: PROOMPT-123
      url: https://linear.app/proompteng/issue/PROOMPT-123/example
    metadata:
      issueId: 2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9
      deliveryId: 6c81c2be-4fd7-44f1-a8e4-f9cc6e5d2ff3
      action: create
      sourceVersion: 1
```

Team and project are deliberately absent. Froussard uses `Linear-Delivery` for the Agents HTTP
idempotency header and `AgentRun.spec.idempotencyKey`. The deprecated Agents provider-webhook route
returns `410 Gone` and points callers back to Froussard only when
`AGENTS_IMPLEMENTATION_SOURCE_WEBHOOKS_GONE=true`; it remains live until Froussard passes its canary.

## Runtime MCP Boundary

`codex-linear-agent` selects `codex-linear`, whose Codex config starts the bundled
`linear-mcp-bridge` over stdio. The bridge reads a ten-minute rotating projected service-account
token and connects to the internal `agents-linear-mcp-gateway` Service. It receives no Linear
OAuth token and cannot use the Linear API directly.

The gateway exposes exactly five tools:

- `get_issue()`
- `list_comments()`
- `list_issue_statuses()`
- `create_comment(body)`
- `update_issue(status)`

Issue, team, and project identifiers are absent from caller-visible schemas. The gateway injects
the source issue. It derives the team transiently only to list valid statuses. Arbitrary search,
issue creation/deletion, labels, descriptions, projects, and workspace administration are not
exposed.

## Identity And Mutation Policy

The `codex-linear-runner` service account has no Kubernetes RBAC and does not automount the default
Kubernetes token. Its projected token has audience `agents.proompteng.ai/linear-mcp`.

For every request, the gateway performs TokenReview and verifies the bound Pod UID, Pod-to-Job and
Job-to-AgentRun owner references and UIDs, Job labels, Agent and AgentProvider identities, effective
service account, active AgentRun phase, and inline Linear source. Namespace object reads are granted
through a namespaced Role; only TokenReview is cluster-scoped.

Before each mutation it re-authenticates and fetches the issue through upstream MCP by the immutable
UUID captured from the webhook. It verifies the returned visible identifier against
`implementation.source.externalId` and, when upstream echoes an immutable UUID, requires that UUID
to match too. It then verifies `agentrun` remains present and validates status against the issue's
current workflow. Removing `agentrun` or terminating the run revokes writes.

Mutation receipts persist the AgentRun UID, issue UUID, tool, canonical argument hash, state,
sanitized result ID, and timestamps. Ambiguous status writes are reconciled with a fresh issue read.
Ambiguous comments are reconciled by app actor, time window, and body hash. Unprovable results become
`indeterminate` and blind retries are blocked.

## Upstream Credentials And Readiness

The gateway alone holds a dedicated Linear OAuth app's client ID, client secret, and actor ID in the
`linear-mcp-oauth` Secret, populated by the Agents namespace 1Password ExternalSecret. The app uses
client credentials with `read,write` scopes. The upstream endpoint is the official
`https://mcp.linear.app/mcp` Streamable HTTP server.

Readiness authenticates and validates the pinned upstream `tools/list` contract. Missing or
incompatible required tools make both replicas unready; newly added upstream tools are never exposed.
Liveness is independent of database or upstream availability.

## Production Acceptance

The code release keeps `linearMcpGateway.enabled=false`, `LINEAR_WEBHOOK_ENABLED=false`, and the
Agents legacy-ingress cutover false. Activate only after digest-pinned controller, runner, and
Froussard images are available and the OAuth ExternalSecret and webhook SealedSecret are healthy.
Verify both gateway replicas are Ready, then use one canary issue:

1. Add `agentrun`; observe exactly one AgentRun with the issue-only source above.
2. Inspect the Job and prove it has the projected identity token and Linear MCP config but no Linear
   credential.
3. Read the source issue/comments, create one comment, and update one valid status.
4. Confirm fresh Linear readback and a succeeded mutation receipt.
5. Try a caller-supplied different issue identifier and confirm zero upstream mutation.
6. Remove `agentrun`; confirm further mutations are denied.

Monitor webhook verification and latency, submission/Kafka failures, gateway policy denials,
upstream/OAuth errors, contract drift, and indeterminate receipts. Do not treat Argo health alone as
proof; require the canary readback and receipt evidence.
