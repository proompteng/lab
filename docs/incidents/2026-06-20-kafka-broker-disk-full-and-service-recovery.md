# Kafka Broker Disk-Full Recovery And Dependent Service Bring-Up

Date: 2026-06-20
Last updated: 2026-07-15

## Summary

Kafka degraded because broker-only pods `kafka-pool-b-3` and `kafka-pool-b-4` crash-looped after their broker PVCs filled. The relevant log signature was:

```text
java.io.IOException: No space left on device
```

The impact was visible downstream as `torghut-hyperliquid-feed` remaining unavailable and Kafka producers logging `NOT_ENOUGH_REPLICAS`.

On 2026-07-15 all three `100Gi` broker volumes reached 76% use and fired the 25%-free warning. Kafka remained ready,
with full replication. `torghut.hyperliquid.bbo.v1` accounted for 109.46 GiB across its three replicas and the retained
Kafka record set is required by the staged ClickHouse writer, so deleting topics or shortening retention is not the
capacity fix. The Ceph block pool reported 49 TiB maximum available; expand the existing broker PVCs in place to
`200Gi`.

## Source Of Truth

- GitOps app: `argocd/applications/kafka`
- Kafka CR: `Kafka/kafka` in namespace `kafka`
- Broker node pool: `KafkaNodePool/pool-b`
- Broker PVCs: `data-kafka-pool-b-3`, `data-kafka-pool-b-4`, `data-kafka-pool-b-5`
- StorageClass: `rook-ceph-block`

## Recovery Plan

1. Expand only broker pool storage in Git:

```yaml
kind: KafkaNodePool
metadata:
  name: pool-b
spec:
  storage:
    type: persistent-claim
    size: 200Gi
    deleteClaim: false
    class: rook-ceph-block
```

Do not delete broker PVCs for this incident. The failure is capacity exhaustion, not confirmed volume corruption.

2. Render and validate manifests:

```bash
mise exec helm@3 -- kustomize build --enable-helm /Users/gregkonush/github.com/lab/argocd/applications/kafka
```

3. Reconcile Kafka through Argo CD:

```bash
argocd app sync kafka
argocd app wait kafka --health --sync --timeout 900
```

4. Verify PVC expansion and broker readiness:

```bash
kubectl --context galactic-tailscale -n kafka get pods,pvc,kafkanodepool,kafka -o wide

kubectl --context galactic-tailscale -n kafka exec kafka-pool-b-5 -- \
  df -h /var/lib/kafka/data
```

5. Verify Kafka metadata and replication:

```bash
kubectl --context galactic-tailscale -n kafka exec kafka-pool-a-0 -- \
  bin/kafka-topics.sh \
    --bootstrap-server kafka-kafka-bootstrap.kafka.svc:9093 \
    --describe --under-replicated-partitions
```

The command should return no under-replicated partitions after recovery settles.

## Dependent Service Recovery Order

Avoid blanket restarts. Restart only services that stay unhealthy or keep logging Kafka errors after Kafka is healthy for several minutes.

1. `torghut-hyperliquid-feed`

```bash
kubectl --context galactic-tailscale -n torghut get deploy torghut-hyperliquid-feed
kubectl --context galactic-tailscale -n torghut logs deploy/torghut-hyperliquid-feed --tail=200
```

Expected: deployment available and no fresh `NOT_ENOUGH_REPLICAS` or Kafka producer timeout errors.

2. Torghut Kafka producers and consumers

```bash
kubectl --context galactic-tailscale -n torghut get deploy \
  torghut-ws torghut-ws-options torghut-ta torghut-options-ta \
  torghut-options-catalog torghut-options-enricher
```

3. Other Kafka consumers/producers

```bash
kubectl --context galactic-tailscale -n posthog get pods
kubectl --context galactic-tailscale -n agents get kafkasources.sources.knative.dev
kubectl --context galactic-tailscale -n froussard get ksvc,pods
```

4. Argo CD health

```bash
argocd app get kafka
argocd app get torghut-hyperliquid-feed
argocd app get torghut
argocd app get torghut-options
argocd app get posthog
argocd app get froussard
```

## Break-Glass Patch

Use this only if Kafka must be restored before GitOps can reconcile. Commit the same change to Git immediately afterward.

```bash
kubectl --context galactic-tailscale -n kafka patch kafkanodepool pool-b --type merge \
  -p '{"spec":{"storage":{"type":"persistent-claim","size":"200Gi","deleteClaim":false,"class":"rook-ceph-block"}}}'
```

## Rollback

Do not shrink PVCs. Kubernetes volume expansion is effectively one-way for this storage path. If `200Gi` is too small,
choose a larger size and apply another expansion.

If Alertmanager or rule-loader changes are suspected during the same rollout, revert the observability commit and sync `observability`; leave Kafka PVCs at the expanded size.
