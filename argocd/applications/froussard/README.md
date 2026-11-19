# Froussard GitOps

This application is the public ingress for GitHub and Discord webhooks and becomes the sole Linear
ingress after activation. Linear must then send Issue events to
`https://froussard.proompteng.ai/webhooks/linear`; Agents webhook routes are not an alternative
ingress after the canary and cutover.

## GitHub identity

Froussard uses `tuslagch` through `froussard/froussard-github-token`, sourced from
`op://infra/tuslagch-github/token`. The reseal helper's `FROUSSARD_GITHUB_TOKEN_OP_PATH`
overrides that source. Argo Workflows keeps its separate existing token from
`op://infra/github/personal-access-token` (`ARGO_WORKFLOWS_GITHUB_TOKEN_OP_PATH`).
The dedicated Secret avoids the existing `github-token` mirror from Jangar, which
the Sealed Secrets controller cannot own. Do not substitute Froussard's credential
into that mirror or the Argo Workflows secret.
Argo waits for the Froussard token's decrypted generation in sync wave `-1` before
starting the new workload, so the new revision cannot capture the old identity.

The ready comment is now the body of an `APPROVED` review from `tuslagch`, bound to
the checked commit. Pending CI, unresolved threads, drafts, conflicts, and missing
or stale Codex review evidence block approval. PR edits, completed checks, commit
statuses, Codex summary updates, submitted reviews, and resolved threads recheck
readiness. GitHub reviews provide the durable receipt used to reconcile retries.
The webhook server durably enqueues commands in the shared Restate cluster.
`RestateDeployment/froussard-approvals` is the sole approval writer. Its virtual
object owns each repository/PR and checkpoints the review ID before submission.
Kargo promotes both workloads to the same digest. Argo registers the worker in
wave `0` before replacing the public server in wave `1`. The worker accepts only
Restate-signed requests carrying the webhook server's signed approval command;
its NetworkPolicy allows ingress from the `restate` namespace only.
Check readiness uses the newest observed execution of each workflow/job for the same
event, branch and commit. Superseded executions cannot block a passing replacement;
checks from other workflows or unknown identities remain independent. Failed metadata
reads block approval. The `ready approval blocked` log records the checked head, delivery,
CI names/conclusions, unresolved thread count, reaction, draft and merge state; GitHub read
failures also record the failed stage and HTTP status without credentials or response bodies.

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
