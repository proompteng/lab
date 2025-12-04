# Flink + Strimzi Kafka Platform Notes

Current code lives under `services/dorvud/flink-integration` (Gradle multi-project) and includes a minimal Kafka
round-trip Flink job (uppercase transform) packaged as a fat jar.

## Versions
- Flink runtime: 2.1.1 (latest 2.x as of 2025‑12‑04).
- Flink Kubernetes Operator: 1.13.0.

## Build and publish the sample job
1. Build the fat JAR and Docker image, push to the registry, and update the deployment image tag:
   ```bash
   bun run flink:build
   ```
   Environment overrides:
   - `FLINK_IMAGE_REGISTRY` (default `registry.ide-newton.ts.net`)
   - `FLINK_IMAGE_REPOSITORY` (default `lab/flink-kafka-roundtrip`)
   - `FLINK_IMAGE_TAG` (defaults to `git rev-parse --short HEAD`)

2. The script runs `./services/dorvud/gradlew :flink-integration:clean :flink-integration:uberJar`, builds/pushes the
   image, prints the digest, and rewrites `argocd/applications/flink/overlays/cluster/flinkdeployment.yaml` with the
   new tag.

## Argo CD flow / sync order
1. ApplicationSet entry `flink` (sync wave 3) creates the `flink` app pointing at `argocd/applications/flink/overlays/cluster`.
2. Strimzi `KafkaUser` `flink` (app `kafka`, wave 2) must reconcile first so the SCRAM secret is available and reflected into the `flink` namespace.
3. MinIO creds secret now reflects to the `flink` namespace; the existing buckets job also provisions `flink-checkpoints`.
4. Flink operator (v1.13.0) CRDs + controller deploy in namespace `flink`.
5. The `FlinkDeployment` `flink-kafka-roundtrip` starts the JM/TMs using the pushed image.

## Smoke test checklist
- `argocd app get flink` → `Synced`/`Healthy`.
- `kubectl get flinkdeployments.flink.apache.org -n flink` shows `Ready`.
- Produce messages to `flink-input` and confirm upper‑cased messages land in `flink-output`.
- Trigger a restart (`kubectl -n flink rollout restart deployment/flink-kubernetes-operator` or scale TM) and verify logs show restore from checkpoints in `s3://flink-checkpoints/flink-kafka-roundtrip/checkpoints`.
- Prometheus targets: operator ServiceMonitor and PodMonitor `flink-job-metrics` should be scraping port `9249`; alerts are defined under `argocd/applications/observability` (PrometheusRule).

## Savepoint / restart
- Application upgrade uses `upgradeMode: savepoint` on the deployment; Argo sync will trigger a savepoint before new pods roll.
- To force a savepoint manually:
  ```bash
  kubectl -n flink exec deploy/flink-kubernetes-operator -- \
    kubectl-flink savepoint flink-kafka-roundtrip
  ```
  (Operator CLI must be present in the image; otherwise use the REST endpoint exposed by the operator service.)

## Credentials and buckets
- Kafka: SCRAM user `flink` (secret reflected via `kubernetes-reflector`).
- S3: the MinIO tenant credentials are reflected to `flink` as `observability-minio-creds`; bucket `flink-checkpoints` is created by the observability buckets job.

## Monitoring / alerts
- Operator metrics exposed on Service `flink-operator-metrics` port `8080` and scraped by `ServiceMonitor`.
- JobManager/TaskManager metrics exposed on port `9249` and scraped by `PodMonitor flink-job-metrics`.
- Alert rules live in `argocd/applications/observability` (lag, checkpoint age, restarts); adjust thresholds as workloads evolve.
