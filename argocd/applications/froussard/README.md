# Froussard GitOps

This application is the public ingress for GitHub and Discord webhooks and becomes the sole Linear
ingress after activation. Linear must then send Issue events to
`https://froussard.proompteng.ai/webhooks/linear`; Agents webhook routes are not an alternative
ingress after the canary and cutover.

## GitHub identity

Froussard uses `tuslagch` through `froussard/github-token`, sourced from
`op://infra/tuslagch-github/token`. The reseal helper's `FROUSSARD_GITHUB_TOKEN_OP_PATH`
overrides that source. Argo Workflows keeps its separate existing token from
`op://infra/github/personal-access-token` (`ARGO_WORKFLOWS_GITHUB_TOKEN_OP_PATH`).
Do not substitute Froussard's credential into the Argo Workflows secret.
Argo waits for the Froussard token's decrypted generation in sync wave `-1` before
starting the new workload, so the new revision cannot capture the old identity.

The ready comment is now the body of an `APPROVED` review from `tuslagch`, bound to
the checked commit. Pending CI, unresolved threads, drafts, conflicts, and missing
or stale Codex review evidence block approval. PR edits, completed checks, commit
statuses, Codex summary updates, submitted reviews, and resolved threads recheck
readiness. GitHub reviews provide the durable receipt used to reconcile retries.

## Linear webhook secret

The Linear webhook signing secret is independent from the OAuth app used by the Agents Linear MCP
gateway. Store it at `op://infra/linear/webhook-secret` and generate the encrypted manifest with:

```bash
bun packages/scripts/src/froussard/reseal-secrets.ts
```

Override the source with `FROUSSARD_LINEAR_WEBHOOK_SECRET_OP_PATH` or the destination with
`FROUSSARD_LINEAR_SEALED_SECRETS_OUTPUT`. Commit only the resulting SealedSecret; never commit the
plaintext secret or a rendered Kubernetes Secret.

Argo CD also reconciles the dedicated `linear.webhook.events` Kafka topic. The Froussard workload
publishes every verified Linear Issue delivery there before accepting the webhook and submits the
source-bound AgentRun independently through the Agents API.

The code rollout deliberately keeps `LINEAR_WEBHOOK_ENABLED=false`. The activation change must add
the generated `linear-secrets.yaml`, configure the Linear topic and AgentRun settings, and set the
flag to `true` in one reviewed source change. The image remains Kargo-managed: the `froussard`
Warehouse/Stage writes the exact promoted digest and source metadata to `kargo/froussard`, and Argo
tracks that branch. Do not hand-edit an image tag or digest or use a deployment PR for this app.
