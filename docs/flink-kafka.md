# Flink + Strimzi Kafka Platform Notes

Current state: the Flink Kubernetes Operator is installed in namespace `flink`; no sample job is deployed by default. You add jobs by creating Flink CRDs managed by the operator.

## Versions

- Flink runtime: 2.1.1 (Flink 2.x, using the Java API from Kotlin code).
- Flink Kubernetes Operator: 1.13.0 (supports Flink versions up to 2.2 per CRD).

## Building jobs (Kotlin calling Flink’s Java API)

- Job sources live under `services/dorvud/flink-integration`. Kotlin modules call Flink’s Java DataStream API; the fat jar is produced via Gradle.
- Build and push your job image (defaults shown):
  ```bash
  bun run flink:build
  ```
  Environment overrides:
  - `FLINK_IMAGE_REGISTRY` (default `registry.ide-newton.ts.net`)
  - `FLINK_IMAGE_REPOSITORY` (default `lab/<your-job>`)
  - `FLINK_IMAGE_TAG` (default `git rev-parse --short HEAD`)

## Deploying a new Flink job (CRD-driven)

Create a `FlinkDeployment` manifest and add it to the Flink overlay so Argo CD applies it.

1. Add a file such as `argocd/applications/flink/overlays/cluster/<job-name>.yaml`:

```yaml
apiVersion: flink.apache.org/v1beta1
kind: FlinkDeployment
metadata:
  name: my-flink-job
  namespace: flink
spec:
  image: registry.ide-newton.ts.net/lab/my-flink-job:flink2.1.1
  flinkVersion: v2_1
  serviceAccount: flink
  flinkConfiguration:
    state.checkpoints.dir: s3://flink-checkpoints/my-flink-job/checkpoints
    state.savepoints.dir: s3://flink-checkpoints/my-flink-job/savepoints
    taskmanager.numberOfTaskSlots: '2'
  jobManager:
    replicas: 1
    resource: { cpu: 1, memory: '2048m' }
  taskManager:
    replicas: 2
    resource: { cpu: 1, memory: '2048m' }
  job:
    jarURI: local:///opt/flink/usrlib/app.jar
    entryClass: com.example.Main
    parallelism: 2
    upgradeMode: savepoint
```

2. Register it with Kustomize: append the new file to `argocd/applications/flink/overlays/cluster/kustomization.yaml` resources list.

3. Let Argo CD sync, or apply once manually:

```bash
PATH=/tmp/helm3dir:$PATH kustomize build --enable-helm argocd/applications/flink | kubectl apply -f -
```

Supporting secrets/configs: create any job-specific `ConfigMap`/`Secret` in the `flink` namespace and reference them via env or pod templates inside the `FlinkDeployment` spec.

## Argo CD flow / sync order

1. ApplicationSet entry `flink` (sync wave 3) points to `argocd/applications/flink/overlays/cluster`.
2. Strimzi `KafkaUser` `flink` (app `kafka`, wave 2) reconciles first so SCRAM secrets are available and reflected into `flink`.
3. MinIO creds are reflected to `flink`; observability buckets job creates `flink-checkpoints`.
4. Flink operator CRDs + controller deploy in namespace `flink`.
5. Your `FlinkDeployment` CRs (added in step 1) bring up JM/TM pods using your image.

## Validation checklist (for a new job)

- `argocd app get flink` → `Synced`/`Healthy`.
- `kubectl get flinkdeployments.flink.apache.org -n flink` shows `Ready` for your job.
- Job metrics exposed on port `9249` if enabled; scrape via PodMonitor of your choosing.

## Credentials and buckets

- Kafka: SCRAM user `flink` (secret reflected via `kubernetes-reflector`). Create additional users/topics as needed.
- S3: MinIO tenant creds are reflected to `flink` as `observability-minio-creds`; bucket `flink-checkpoints` exists for checkpoints/savepoints.

## Monitoring / alerts

- Operator metrics: Service `flink-operator-metrics` on port `8080` (scraped by ServiceMonitor).
- Add job-specific PrometheusRules in `argocd/applications/observability` (none are installed by default after removing the roundtrip sample). Adjust lag/checkpoint/restart alerts per workload.
