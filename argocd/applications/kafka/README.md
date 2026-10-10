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

## Controller metadata idle writes

`metadata.max.idle.interval.ms` is five seconds. On 2026-10-06, the active controller's raft thread was blocked in
`FileChannel.force` while controller logs recorded metadata no-op writes and heartbeats taking several seconds.
Kafka's default schedules idle metadata records every 500 milliseconds. The five-second interval reduces that
periodic idle-write frequency by 90 percent while retaining no-op records and the existing metadata durability,
quorum, heartbeat, and data-topic replication settings.

This removes repeated idle work from the shared storage path. It does not repair the latency of an individual
storage flush. Check controller event latency, heartbeat fencing, replica health, and market-data publication
after the managed roll. See Kafka's [configuration reference](https://kafka.apache.org/43/configuration/broker-configs/#metadata.max.idle.interval.ms).

## Stall diagnostics

The bounded JMX exporter configuration in [kafka-stall-metrics.yaml](kafka-stall-metrics.yaml) exposes port 9404 on
controllers and brokers. The central [Alloy collector](../observability/cluster-metrics-alloy-config.river) discovers
each pod and scrapes every five seconds with a four-second timeout, retaining namespace, cluster, pool, pod and node
identity in Mimir under `job="strimzi-kafka"`. Topic, partition, client and user labels are excluded at the exporter.

Controller queue/processing, broker request and log-flush duration gauges use seconds with bounded `stage`, `request`
and `statistic` labels. Raft and broker-metadata attributes preserve Kafka's units: commit/election latency and metadata
lag use milliseconds; offsets and epochs are integers. The agent's existing JVM collectors supply cumulative GC
seconds, memory use and process start time without duplicate JMX rules. Queue and request percentiles are Kafka's sampled gauges,
not Prometheus histograms or a guarantee that every individual stall was sampled.

Useful queries for a Bayn reconciliation or OTLP export failure window include:

```promql
kafka_controller_event_duration_seconds{job="strimzi-kafka",statistic="99thPercentile"}
kafka_server_raft_metrics_commit_latency_max{job="strimzi-kafka"} / 1000
increase(kafka_controller_timedoutbrokerheartbeatcount_total{job="strimzi-kafka"}[5m])
rate(jvm_gc_collection_seconds_sum{job="strimzi-kafka"}[5m])
kafka_network_request_duration_seconds{job="strimzi-kafka",statistic="99thPercentile"}
```

Join on pod/node and the same UTC interval with controller logs, cAdvisor CPU/memory, Ceph device latency and CNPG
WAL/replication waits. GC, Kafka, database and storage correlation alone does not identify which component caused a
particular transaction delay. Missing series remain unknown: `KafkaMetricsUnavailable` checks each running pod against
successful HTTP and JMX scrapes, while `KafkaControllerTelemetryMissing` detects a missing controller mapping even
when an exporter endpoint responds. Existing broker availability and storage alerts remain active.

Enabling the exporter requires Strimzi's managed rolling restart of the three controllers and three brokers. Perform
this shared-cluster rollout only within its approved scope. Preserve controller quorum, topic ISR, PVCs, replication,
durability and existing request deadlines. After the roll, require all six per-pod `up` series and zero
`jmx_scrape_error`, controller gauges from all three controllers with exactly one active controller, Raft measurements,
and process start-time/GC measurements in Mimir. A direct metrics response or a healthy pod is insufficient ingestion evidence.
Verify Bayn consumer bootstrap, fresh broker observations, exact reconciliation, and a delivered native execution
trace afterward. This telemetry change does not qualify capture capacity or repair storage latency.

For recovery, revert the metrics and collector changes through reviewed GitOps. Strimzi owns any resulting roll;
retain the existing volumes and topic assignments.

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
