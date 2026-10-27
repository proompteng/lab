# Bayn cache and database observability

Use [Bayn performance](https://grafana.ide-newton.ts.net/d/bayn-cache-performance)
to inspect the running source revision. The existing
[trading dashboard](https://grafana.ide-newton.ts.net/d/bayn-cycle-operations) retains readiness, authority,
reconciliation freshness and economic evidence. Neither dashboard grants trading authority.

Start with critical-path outcomes, duration and completed-cycle activity. These queries select the top-level
execution cycle and broker refresh, so nested operations do not inflate the workload or failure counts.
The broker snapshot card reports age divided by the configured reconciliation freshness limit; 100% exhausts
that limit. It requires a healthy API scrape from the selected source. Expand dependency diagnostics to compare
SET, replica acknowledgement, database commit and broker capture/publication. Cache hits are required
materialization reads, so a 100% hit rate alone does not establish a performance improvement.

Trading Operations keeps current condition and safety in the overview. Account/P&L, session/planner details
and export logs live in collapsed rows. The funnel describes the current or latest terminal cycle, rather than
throughput. Cycle latency separates local order observation, broker fill and fill ingestion clocks.
The unused research-model dashboard is removed from file provisioning;
its independent metrics, logs and alerts remain available through the model runbook and Explore.

## Preview dashboard changes

Extract the importable JSON from the GitOps ConfigMap:

```sh
yq -r '.data["bayn-cache-performance.json"]' argocd/applications/observability/bayn-cache-performance-dashboard-configmap.yaml > /tmp/bayn-performance.json
```

In Grafana, open **Dashboards**, then **New**, then **Import**. Upload `/tmp/bayn-performance.json`.
Choose a preview name and change the UID to `bayn-performance-preview` before importing into the same instance.
The canonical dashboard remains owned by its file provider. The preview uses the existing `prom`, `loki` and `tempo`
datasource UIDs.

Inspect the rendered overview and expand the broker/cache, PostgreSQL and log sections. The source picker displays
eight characters but queries the full deployed revision. The broker-trace link carries that revision and time range.
Check missing-data states as well as populated charts. Parent and child latency estimates overlap.
Keep the reviewed JSON in the ConfigMap and deliver it through the observability application's normal GitOps path.

## Collection

The central Alloy discovers only `buf.red/name=bayn-valkey` pods in namespace `bayn`, scrapes each `exporter`
port every fifteen seconds and retains a bounded Redis metric allowlist. Valkey exposes `redis_*` metric names.
The same discovery collects only the `valkey` and `exporter` containers into Loki. Existing network and log-read
permissions cover this collector; it never reads cache credentials.

The API appends native Effect metrics to its existing `/metrics` endpoint, collected by Alloy. Each execution
worker owns one native Effect OTLP metrics exporter at the process entry point because its Restate HTTP/2 endpoint
has no Prometheus route. Nested managed runtimes inherit metric identity and share the process registry without
starting exporters. The worker destination is the existing Mimir gateway `/otlp/v1/metrics`, with a fifteen-second cumulative
export interval. Worker egress permits only that gateway's pods on TCP 8080 in `observability`.

`bayn_operation_duration_seconds` records inclusive wall time for successful, failed and interrupted operations.
Fixed stage, operation, dependency, outcome, service, namespace and source-revision labels describe the work.
The OTLP resource identifies the pod. Cache keys, content hashes, account/order/cycle identifiers and raw errors
are excluded from metric labels.

- `bayn.valkey.put` includes queueing, connection establishment, SET and the complete required replica acknowledgement. Its child
  `bayn.valkey.set` and `bayn.valkey.replica-ack` spans/histograms separate those components. The original single
  one-second command deadline, cancellation and one-replica requirement remain in force.
- `bayn_valkey_queue_duration_seconds` measures only the wait for the single command permit, labeled by the
  bounded operation and `acquired`, `interrupted` or `failed` outcome. `acquired` does not mean the command succeeded.
  `bayn.valkey.connect` measures actual connection attempts only, not already-open connections; its operation
  label identifies get/put/remove and its outcome distinguishes success, failure and interruption. All queueing
  and connection work consumes the existing parent deadline. Component percentiles cannot be subtracted or summed;
  compare distributions or inspect the same operation's trace rather than attributing a parent p99 to one component.
- `bayn_valkey_reads_total` counts successful GET results as `hit` or `miss`. A required materialization miss still
  fails closed. Transport failures are counted separately in `bayn_valkey_failures_total` by bounded category.
- `bayn_valkey_unacknowledged_waits_total` counts WAIT replies below one acknowledgement, including eventual
  successful retries. It is not a count of failed publications.
- Materialization latency includes GET, JSON decoding, schema checks and content hashing; payload-byte histograms
  distinguish full snapshots from compact state. Writer fencing, commit, broker publication and reconciliation
  retain separate measurements. Parent and child timings overlap and must not be summed.
- `bayn.postgres.generation-settlement` measures the actual named SQL statement outside the surrounding commit.
  CNPG's read-only catalog query exports validity, readiness and cumulative activity for the exact generation
  expression index. Zero scans can be correct when no eligible restricted generation exists. An index scan counter
  does not prove one statement used that index; investigate regressions with its trace and a bounded read-only plan.

Missing series and no-traffic quantiles remain unknown. The dashboard does not replace absent evidence with zeros.

## Alerts and diagnosis

The `bayn-cache-performance.rules` Mimir group contains eight rules. They use the existing trading email route.

| Alert                             | Trigger and next evidence                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BaynValkeyMetricsUnavailable`    | Fewer than two healthy exporter/server pairs for two minutes. Check discovery, scrape errors and both pods.                                                                                |
| `BaynValkeyReplicaUnavailable`    | No connected replica, replica link down or missing replication observation for one minute. Publication requires WAIT; recover the peer.                                                    |
| `BaynValkeyMemoryPressure`        | More than 85% of configured cache memory for ten minutes. Inspect payload bytes and expiry; `noeviction` can reject writes.                                                                |
| `BaynValkeyPublicationFailure`    | A failed replicated put in the last five minutes, held for one minute. Join failure category with the publication trace.                                                                   |
| `BaynValkeyLatencyHigh`           | Successful GET/PUT p99 above 250ms for five minutes, with at least twenty samples. Compare SET, WAIT and queueing. This diagnostic threshold is one quarter of the command deadline.       |
| `BaynOperationMetricsUnavailable` | A missing or more than ninety-second-old service heartbeat for two minutes while the API revision expects native metrics. Check OTLP export failure logs and the exact Mimir network path. |
| `BaynGenerationIndexUnavailable`  | Missing, invalid or unready index observation for two minutes. Inspect migration 104 and CNPG query collection.                                                                            |
| `BaynGenerationSettlementSlow`    | Statement p95 above 500ms for ten minutes, with at least twenty samples. Inspect waits, the statement trace and a bounded read-only plan.                                                  |

The API pull metric `bayn_operation_metrics_expected` gates native export and index telemetry absence alerts during
the initial rollout, so the main-tracked observability app does not page before Kargo installs the application catalog
queries and metric producers.
This source-bound indicator remains available when the separate OTLP metrics path fails. Heartbeats must match
each API-advertised source revision; retained older workers cannot satisfy it. Within a revision, the newest exporter
per service is observed; existing replica alerts cover missing workers/APIs. No notification test is sent by acceptance.

Publication notifications include the observed bounded `category/cause_category` pairs from the same five-minute
failed-put window, deduplicated across API and execution-worker replicas. Missing labels are reported as `unknown`,
not inferred from a timeout. The annotation does not change the single alert identity, one-minute hold or trigger.
It describes recent failures, not necessarily a failure still in progress. A resolved notification only means no
failure increase is currently observed in that window; missing telemetry or aged-out samples do not prove a successful
publication. Verify a subsequent successful replicated put and fresh telemetry before declaring recovery.

Follow the notification's dashboard link, expand broker/cache diagnostics and inspect **Cache failures per second**.
The alert covers both services across source revisions, while the dashboard's source picker selects one API-advertised
revision. Select the relevant revision and incident time range; a quiet current-source panel cannot dismiss a failure
from a retained worker. The category/cause pairs in the notification remain the bounded incident evidence, not a
claim about which revision failed or its underlying root cause. Never weaken WAIT or trading fences to clear it.

## Verify a rollout

Verify the reviewed source, immutable image, Kargo Freight/promotion and generated `kargo/bayn` revision using
[release automation](../release-automation.md). Check API readiness and the actual runtime status separately.
Forward the three existing observability services with explicit context and namespace:

```sh
kubectl --context galactic-tailscale -n observability port-forward svc/observability-mimir-gateway 19116:80
kubectl --context galactic-tailscale -n observability port-forward svc/observability-loki-v3-gateway 19115:80
kubectl --context galactic-tailscale -n observability port-forward svc/observability-tempo-v3-query-frontend 19114:3200
```

From another terminal run the read-only verifier, using the full deployed source SHA:

```sh
python3 services/bayn/tools/verify-cache-observability.py --source <40-character-source-sha>
```

It checks both exporter/server pairs, required replication, at least two fresh source-bound native heartbeats per
service, continuous broker/cache operation histograms, cache hits, payload sizes, index validity/activity, evaluated
rules and native WAIT traces. Writer, commit, reconciliation and generation-settlement counts are reported separately;
an absent conditional stage remains unobserved until its flow runs. Collected server logs are reported over forty-eight
hours. An empty window remains unobserved because healthy servers can be quiet; it does not prove collection works.
Inspect Grafana's loaded
dashboard and its panel queries after acceptance. Notification delivery and a long-term latency SLO are separate evidence.

Validate the twenty alert cases and twenty-six dashboard query cases with the native PromQL test harness.
Publication cases cover multiple diagnostic categories, replica deduplication, unrelated streams, counter resets,
missing labels, stale series and resolution without asserting recovered publication.
The dashboard cases cover replica observations, missing telemetry, clock skew, database waits, snapshot freshness
and top-level operation outcomes without child-operation duplication.
Use `promtool` 3.5.0 on `PATH`, or set `PROMTOOL` to its executable; CI already provisions the pinned checker.

```sh
bun test packages/scripts/src/shared/__tests__/bayn-cache-promql.test.ts
bun test packages/scripts/src/shared/__tests__/bayn-cache-verifier.test.ts
```

Recover an application regression through the prior eligible Kargo image. Revert unwanted collector, catalog,
dashboard or rule changes in Git and reconcile that reviewed state. Keep required cache replication and trading fences.
