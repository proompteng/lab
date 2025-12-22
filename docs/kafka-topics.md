# Kafka Topic Conventions

We namespace Kafka topics using dot notation (`<source>.<domain>.<entity>`) so producers, ACLs, and observability dashboards stay consistent. Resource manifests are managed through Strimzi’s `KafkaTopic` CRD; keep the Kubernetes resource name DNS-1123 compliant and rely on `spec.topicName` for the dotted topic (see the [Strimzi topic resource reference](https://strimzi.io/docs/operators/latest/deploying.html#type-KafkaTopic-reference_deploying)).

We namespace Kafka topics with dot notation (e.g. `github.webhook.events`) to make it obvious which producer owns the stream and what data shape to expect. The segments map to `<source>.<domain>.<entity>` and can be extended with additional qualifiers when needed (for example, `github.issues.codex.tasks` for Codex-triggered automation).

## Working With Strimzi Manifests

Strimzi requires the Kubernetes `metadata.name` to follow DNS-1123 conventions (`[a-z0-9-]+`). When a topic contains dots, set the desired Kafka topic with `spec.topicName` while keeping the resource name kebab-cased:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: github-webhook-events
  namespace: kafka
spec:
  topicName: github.webhook.events
  partitions: 3
  replicas: 3
```

## Producer & Consumer Configuration

- Application env vars (for example `KAFKA_TOPIC`) should reference the dot-notation topic (`github.webhook.events`).
- ACLs and SASL credentials should align with the dot-separated topic name—you do not need to mirror the kebab-case resource name.
- When creating new topics, follow the same `<source>.<domain>.<entity>` structure to keep observability and retention policies predictable.

## Existing Topics

| Kafka Topic | Purpose | Notes |
| ----------- | ------- | ----- |
| `discord.commands.incoming` | Normalized Discord slash command interactions published by Froussard. | Defined in `argocd/applications/froussard/discord-commands-topic.yaml`. 7-day retention. |
| `github.webhook.events` | Raw GitHub webhook payloads published by the `froussard` service. | Strimzi resource: `github-webhook-events`. 7-day retention. |
| `github.issues.codex.tasks` | Structured Codex task payloads (protobuf) for services like Facteur. | Defined in `argocd/applications/froussard/github-issues-codex-tasks-topic.yaml`. |
| `argo.workflows.completions` | Normalized Argo Workflow completion events emitted by Argo Events. | Defined in `argocd/applications/froussard/argo-workflows-completions-topic.yaml`. Mirrors Codex topic retention (7 days). |

Add new rows whenever a topic is provisioned so downstream teams can reason about ownership and retention.

### Codex task payloads

Messages published to `github.issues.codex.tasks` (Protobuf) include a `stage` field, which is now always `implementation`. Tasks are emitted automatically when an authorized login opens a GitHub issue, with a manual override comment of `implement issue` for retries.

The payloads carry the common metadata (`repository`, `base`, `head`, `issueNumber`, etc.) needed for implementation runs. The structured stream uses the `proompteng.froussard.v1.CodexTask` message and adds the GitHub delivery identifier for consumers that need typed payloads.
