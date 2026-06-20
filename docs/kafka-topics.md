# Kafka Topic Conventions

We namespace Kafka topics using dot notation (`<source>.<domain>.<entity>`) so producers, ACLs, and observability dashboards stay consistent. Resource manifests are managed through Strimzi’s `KafkaTopic` CRD; keep the Kubernetes resource name DNS-1123 compliant and rely on `spec.topicName` for the dotted topic (see the [Strimzi topic resource reference](https://strimzi.io/docs/operators/latest/deploying.html#type-KafkaTopic-reference_deploying)).

We namespace Kafka topics with dot notation (e.g. `github.webhook.events`) to make it obvious which producer owns the stream and what data shape to expect. The segments map to `<source>.<domain>.<entity>` and can be extended with additional qualifiers when needed.

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

| Kafka Topic                 | Purpose                                                               | Notes                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `discord.commands.incoming` | Normalized Discord slash command interactions published by Froussard. | Defined in `argocd/applications/froussard/discord-commands-topic.yaml`. 7-day retention.                                        |
| `github.webhook.events`     | Raw GitHub webhook payloads published by the `froussard` service.     | Strimzi resource: `github-webhook-events`. 7-day retention. Agents consumes this topic directly for Codex CI/review projection. |

Add new rows whenever a topic is provisioned so downstream teams can reason about ownership and retention.
