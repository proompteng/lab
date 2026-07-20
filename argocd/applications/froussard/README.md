# Froussard GitOps

This application is the public ingress for GitHub and Discord webhooks and becomes the sole Linear
ingress after activation. Linear must then send Issue events to
`https://froussard.proompteng.ai/webhooks/linear`; Agents webhook routes are not an alternative
ingress after the canary and cutover.

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
flag to `true` in one digest-pinned rollout.
