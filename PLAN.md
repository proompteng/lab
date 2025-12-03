<!-- codex:plan -->
### Objective
- Deliver a Flink 1.20.x app-mode job (managed by Flink K8s Operator 1.13.x) that ingests Alpaca Kafka feeds, computes 1s micro-bars plus TA indicators, and publishes exactly-once `ta.bars.1s.v1`/`ta.signals.v1` topics consumable by torghut with ≤500 ms p99 latency.

### Context & Constraints
- Base branch `main`, feature branch `codex/issue-1915-364b81d2`, issue #1915; work in repository paths under `/workspace/lab`.
- Kafka via Strimzi 0.49.x in namespace `kafka` using SCRAM/TLS secrets reflected to workloads; avoid plaintext creds and align with reflector annotations already used in `argocd/applications/kafka/strimzi-kafka-cluster.yaml`.
- Deploy into namespace `torghut` through Argo CD kustomization (`argocd/applications/torghut/kustomization.yaml`); create new subfolder `argocd/applications/torghut/flink-ta/` for operator/job manifests.
- Checkpointing to object storage (MinIO/S3) with 10s interval, transaction timeout ≥ checkpoint timeout + failover; ensure JM/TM network to Kafka and bucket.
- Inputs from Alpaca forwarder (issue #1914) trades/quotes/1m bars with `is_final`; outputs must be stable schemas with `event_ts`, `ingest_ts`, `seq`, `is_final`, `window{start,end}`; partitions per symbol initially, RF=3, lz4.

### Task Breakdown
- Create working branch `git checkout -b codex/issue-1915-364b81d2` from `main` and capture baseline `git status` for cleanliness.
- Define data contracts: add schemas and envelope docs under `docs/torghut/flink-ta.md` (and `schemas/ta/` Avro/JSON files) describing `ta.bars.1s.v1`, `ta.signals.v1`, optional `ta.status.v1` fields, types, subject names, dedupe keys, watermarks, and ordering guarantees; include sample payloads for bars and signals.
- Provision Kafka artifacts: add `KafkaTopic` manifests for `ta.bars.1s.v1`, `ta.signals.v1`, `ta.status.v1` plus `KafkaUser` (e.g., `torghut-flink`) with SCRAM/TLS and reflector annotations in `argocd/applications/kafka/`; update `argocd/applications/kafka/kustomization.yaml` and retention/partition configs to match guardrails.
- Scaffold Flink job module at `services/flink-ta/` using Maven wrapper (Java 17, Flink 1.20.x, FLIP-27 KafkaSource and KafkaSink, Prometheus metrics); add shaded JAR build and Dockerfile that copies the fat jar for app-mode execution.
- Implement stream topology under `services/flink-ta/src/main/java/...`: read Alpaca trades/quotes/bars, assign watermarks on `event_ts` with ~2s lateness, dedupe trades by id and quotes/bars by (symbol,event_ts), aggregate 1s micro-bars, compute EMA12/26, MACD+signal/hist, RSI14, Bollinger20/2, VWAP (session and rolling), spread/imbalance, realized volatility; emit bars/signals with `KafkaSink` `DeliveryGuarantee.EXACTLY_ONCE`, transactional id prefix, acks=all, lz4, and optional status side-output.
- Add state/checkpointing config (rocksdb state backend, 10s checkpoints, minimum pause, externalized on cancel, aligned txn timeout) driven by env vars for bucket URI, checkpoint dir, Kafka bootstrap, SASL username/password, and CA truststore; surface metrics/labels and configure PodMonitor in manifests.
- Create tests: indicator unit tests and `MiniClusterExtension` integration validating 1s bar aggregation, watermarking lateness handling, and exactly-once sink behavior; store fixtures under `services/flink-ta/src/test/resources/`.
- Add Kubernetes/Argo manifests in `argocd/applications/torghut/flink-ta/`: kustomization, Flink Operator application (or reference existing if already installed), FlinkDeployment (app mode) with JM/TM sizing, secret/ConfigMap mounts for Kafka creds and bucket config, service account/RBAC, PodMonitor/Service for metrics; include update to `argocd/applications/torghut/kustomization.yaml`.
- Wire downstream usage: document torghut consumer expectations and sample `kafka-python`/`confluent-kafka` read in `services/torghut/README.md` or `docs/torghut/flink-ta.md`, noting topic names and schema fields; no runtime torghut changes unless minimal config pointer needed.
- Validation script: describe and run `./mvnw -f services/flink-ta/pom.xml clean verify`, `docker build -t <registry>/flink-ta:dev services/flink-ta`, optional local mini-cluster smoke, and cluster checks (`kubectl get flinkdeployments -n torghut`, `argocd app get torghut-flink-ta`, consume topics with SASL/TLS) to prove acceptance criteria.

### Deliverables
- New Flink TA job code, tests, Maven wrapper, and Dockerfile in `services/flink-ta/`.
- Kafka topics and user manifests under `argocd/applications/kafka/` with updated kustomization.
- Argo CD kustomization for torghut Flink operator/job in `argocd/applications/torghut/flink-ta/` and inclusion in `argocd/applications/torghut/kustomization.yaml`.
- Data contract documentation and schemas for `ta.bars.1s.v1` and `ta.signals.v1`, plus operational README for deployment/config.
- Optional helper script in `packages/scripts/src/torghut/` for building/pushing the job image and triggering Argo sync.

### Validation & Observability
- `./mvnw -f services/flink-ta/pom.xml clean verify` passes; shaded jar present in `services/flink-ta/target/` and tests assert indicator correctness and dedupe behavior.
- `docker build -t <registry>/flink-ta:dev services/flink-ta` succeeds and container starts app-mode entrypoint.
- Cluster: `kubectl get flinkdeployments -n torghut` shows Ready; `argocd app get torghut-flink-ta` Synced/Healthy; checkpoints land in configured bucket; sink transaction metrics show no failures.
- Data checks: authenticated consumer of `ta.bars.1s.v1` and `ta.signals.v1` sees fields `event_ts`, `ingest_ts`, `seq`, `is_final`, `window`, indicators populated; restart JM/TM and verify no duplicate committed outputs (read_committed).
- Performance: run documented load harness (e.g., `kafka-producer-perf-test` or custom driver) to confirm p99 `now - event_ts` ≤500 ms and watermark lag within budget.

### Risks & Contingencies
- Missing or incorrect bucket/creds for checkpoints; mitigate by provisioning torghut-scoped secret/ConfigMap and fall back to PVC if object storage unavailable.
- Kafka secret reflection to torghut may fail; prepare manual Secret copy via Kustomize `SecretGenerator` if reflector annotations insufficient.
- Operator/Flink version skew with cluster CRDs; be ready to pin compatible image tags or adjust CR fields (e.g., `jobManager`/`taskManager` layout, podTemplate paths).
- Upstream Alpaca topic schema drift; make source field mapping configurable and document assumptions with TODOs for issue #1914 alignment.
- Latency budget risk under high symbol fan-out; expose metrics (watermark lag, task backpressure, sink txn duration) and document tuning knobs (parallelism, buffer timeout, allowedLateness).

### Communication & Handoff
- Store this plan in `PLAN.md` and reference in the codex progress comment; capture required secrets/env (Kafka SASL user/pass, CA cert, checkpoint bucket URI/prefix, transactional id prefix).
- Document deploy/run steps and topic schemas in `docs/torghut/flink-ta.md` for torghut consumers and operators; note any manual approvals needed for bucket or Kafka user creation.

### Ready Checklist
- [ ] Dependencies clarified (feature flags, secrets, linked services)
- [ ] Test and validation environments are accessible
- [ ] Required approvals/reviewers identified
- [ ] Rollback or mitigation steps documented
