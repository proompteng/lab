# Kafka

This application owns the existing Strimzi cluster, its three controllers, three brokers, and topic definitions.
The [controller and broker separation design](../../../docs/kafka-kraft-controller-broker-separation-design-2026-03-11.md)
describes the storage and quorum layout.

## Broker heartbeat tolerance

`broker.session.timeout.ms` is 60 seconds. Kafka's default is nine seconds; controller queue and disk stalls observed
during Bayn's retained-input verification exceeded the effective heartbeat request deadline. On 2026-09-13 at
04:16:25 UTC, the controller fenced the still-running broker 4, changed 437 partitions, and unfenced it one second
later. The resulting leader-epoch errors restarted Bayn's required history rebuild.

The longer lease tolerates these transient stalls while heartbeats continue at Kafka's default two-second interval.
A broker that actually fails can consequently take up to 60 seconds to be fenced. Client request deadlines, consumer
sessions, replication acknowledgments, storage, and Bayn's market-data freshness checks retain their existing settings.
This setting limits avoidable partition churn; it does not establish that storage latency has been repaired.
See Kafka's [broker configuration reference](https://kafka.apache.org/43/configuration/broker-configs/#broker.session.timeout.ms).

## Validation and rollout

Render with Helm 3 on `PATH`, then validate the changed Kafka resource without applying it:

```sh
kustomize build --enable-helm argocd/applications/kafka > /tmp/kafka-rendered.yaml
yq 'select(.kind == "Kafka")' argocd/applications/kafka/strimzi-kafka-cluster.yaml |
  kubectl --context galactic-tailscale -n kafka apply --dry-run=server -f -
bun run lint:argocd
```

Reviewed `main` changes reconcile through Argo and Strimzi. This static setting requires Strimzi's managed rolling
restart. Observe controller quorum and broker replication during the roll, then verify the generated configuration
on all six Kafka pods and the Kafka resource's observed generation and Ready condition. Do not restart pods manually.

Acceptance also requires the affected consumer to finish its captured Kafka partition cuts, with raw/feature
provenance matches and no rebuild caused by another heartbeat fence. Healthy pods alone do not establish that result.
For recovery, revert the configuration commit through the same review and GitOps path; the existing volumes and
replica assignments remain in place.
