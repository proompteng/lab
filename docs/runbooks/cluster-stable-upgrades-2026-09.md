# Galactic stable upgrades and recovery

This runbook records the September 2026 upgrade campaign and the recovery rules
needed to operate its resulting configuration. Release discovery stopped at
**2026-09-10 12:00 UTC**. These versions are a dated inventory, not a promise that
future upstream releases have been installed. Recheck committed source and live
workloads before another rollout, following [documentation authority](../documentation-authority.md).

**Runtime closeout verified at 2026-09-10T13:43:28 UTC.** The selected upgrades,
fresh storage canaries and their normal cleanup are complete. Ceph is
`HEALTH_OK`; all 95 active Ceph storage consumers are ready, all six CSI node Pod
UIDs and the baseline volume identities are preserved. The compatibility limits
below remain part of the selected version set.

## What was selected

“Latest stable” means a published stable artifact usable by its owning chart and
consumers. Do not independently advance every bundled image just because a newer
tag exists. Distinguish upstream support, upstream test coverage, and local
acceptance. None of them alone establishes the other two.

| Area                   | Versions at the release cutoff                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cluster platform       | Talos 1.14.0; Kubernetes 1.37.0; CoreDNS 1.14.7                                                                                                                    |
| Storage                | Rook 1.20.7; Ceph 20.2.4; Ceph CSI operator/driver chart 1.0.4; Ceph CSI 3.17.1; local-path provisioner 0.0.37                                                     |
| CSI helpers            | Provisioner 6.2.0; resizer 2.1.0; attacher 4.12.0; registrar 2.17.0; snapshotter 8.6.0                                                                             |
| Observability          | Grafana 13.2.1; Loki 3.7.7; Mimir 3.2.1; Tempo 3.0.3; Alloy 1.19.2; gateway nginx 1.31                                                                             |
| Metrics infrastructure | kube-state-metrics 2.20.0; metrics-server 0.9.0; node-feature-discovery 0.19.0                                                                                     |
| Database operators     | CloudNativePG 1.30.0; Barman plugin 0.15.0; Altinity operator 0.27.3; Cockroach operator 2.18.4; Redis operator 0.26.0                                             |
| Database servers       | PostgreSQL 18.6 on all 12 production CNPG clusters; ClickHouse 26.3.16.10001.altinitystable; Keeper 26.8.2.7; Cassandra 5.0.9; Elasticsearch 8.19.21; Redis 8.10.1 |
| Database tools         | pgAdmin 9.17; Redis exporter 1.91.1; TigerBeetle 0.17.9; Bilig Zero 1.9                                                                                            |
| Kafka                  | Strimzi 1.2.0; shared Kafka 4.3.1; Mimir's existing Kafka 4.3.1; Kafka UI 1.5.0; Karapace 6.2.3                                                                    |
| Other messaging        | NATS 2.14.6; NACK 0.24.0; NATS box 0.19.7; NATS exporter 0.20.2                                                                                                    |
| Flink                  | 2.2.1; Kafka connector 5.0.0-2.2; JDBC connector 4.1.0-2.2; S3 Hadoop 2.2.1; Java 21                                                                               |
| Workflow runtimes      | Temporal 1.31.2; Temporal UI 2.54.0; Restate 1.7.9; Restate operator 3.0.1                                                                                         |
| Delivery               | Argo CD 3.5.2; Argo Workflows 4.1.2; Argo Rollouts 1.10.0; Kargo 1.11.4; Lovely 1.2.5                                                                              |
| Networking             | Istio 1.31.0; Traefik 3.7.13; MetalLB 0.16.1; kube-router 2.11.1; Sidero Flannel 0.28.5; Tailscale 1.102.3; cloudflared 2026.9.0                                   |
| Identity and secrets   | Keycloak 26.7.3; Dex 2.45.1; cert-manager 1.21.1; External Secrets 2.10.0; Sealed Secrets 0.39.1; Reflector 10.0.65                                                |
| Compute and GPU        | KubeVirt 1.9.0; CDI 1.66.1; NVIDIA GPU Operator 26.7.0; NVIDIA device plugins 0.20.0                                                                               |
| Model serving          | vLLM 0.29.0-cu129; Ollama 0.33.3; Open WebUI 0.11.3                                                                                                                |
| Developer services     | Coder 2.36.4; Forgejo 16.0.3; Forgejo runners 13.1; Docker 29.8; ARC 0.14.2                                                                                        |
| Other applications     | Hermes 0.21.1; Seerr 3.4.1; Flipt 2.12.0; JupyterHub 5.5.2 / chart 4.4.2 / proxy 5.3                                                                               |

This inventory includes components already current during the final audit as
well as components changed by the campaign. Repository-owned application images
retain their source commits and immutable digests on their normal delivery
branches; the table is not a replacement for that provenance.

## Compatibility limits and explicit overrides

- **Rook/CSI:** Rook 1.20 supports Kubernetes 1.31–1.37 and Ceph 19/20, but the
  Ceph CSI 3.17.1 test matrix lists Kubernetes 1.34–1.36. Local Kubernetes 1.37
  storage proof does not mean every upstream project tested that exact pairing.
  Provisioner 6.3.0 and resizer 2.2.1 were published and temporarily selected in
  Git, but never activated. Their overrides were withdrawn through reviewed GitOps in favor of the
  chart's 6.2.0/2.1.0. Snapshotter 8.6.0 remains an explicit earlier override;
  the chart default is 8.5.0. See the [CSI compatibility and acceptance runbook](ceph-csi-final-stable-sidecars.md).
- **Flink:** 2.2.1 is the newest selected engine with released Kafka and JDBC
  connectors and verified saved-state compatibility. Flink 2.3 had no released
  Kafka connector at the cutoff. See [Flink's 2.3 Kafka documentation](https://nightlies.apache.org/flink/flink-docs-release-2.3/docs/connectors/datastream/kafka/)
  and the [Flink upgrade runbook](flink-2-2-upgrade.md).
- **Temporal visibility:** Elasticsearch remains on 8.19.21. Temporal's
  [supported visibility matrix](https://docs.temporal.io/self-hosted-guide/visibility)
  lists Elasticsearch 7 and 8, not 9. A standalone Elasticsearch 9 release is
  not sufficient reason to change Temporal's backend.
- **Unavailable images:** attacher 4.13.0, registrar 2.18.0, and the Sidero
  Flannel 0.28.9 image had newer source tags but no published official container
  tags. Registry lookups returned `MANIFEST_UNKNOWN`. Keep the listed published
  versions; do not change publisher or use staging images to match a tag.
- **Talos networking:** Talos owns the Flannel DaemonSet; Argo owns its cluster
  configuration, including MTU 1400. Do not run a bulk Omni manifest sync that
  replaces the separately owned configuration as a side effect of an image audit.
- **GPU:** Talos-owned driver/toolkit integration was preserved. vLLM uses the
  CUDA 12.9 image with the installed NVIDIA driver, and the existing model,
  quantization, memory limits, and scheduling were retained.

## Observability and Kafka topology

The observability stack is upgraded. Tempo 3 and Loki 3 were staged alongside the
old services, checked for historical reads and new writes, cut over through
reviewed routes, then drained before old compaction ownership was retired. The
old Tempo 2/Loki 2 workloads are no longer active. Mimir's final patch is 3.2.1;
its 13 Pods returned that native version, 75 historical series were unchanged at
a fixed pre-rollout timestamp, and fresh metrics arrived after the new Pods
started. Grafana UI login was not requalified by resetting credentials; native
observability queries and data ingestion were the acceptance boundary.

| Consumer | Kafka bootstrap service                                           | Topic                           | Ownership                                          |
| -------- | ----------------------------------------------------------------- | ------------------------------- | -------------------------------------------------- |
| Tempo 3  | `kafka-kafka-bootstrap.kafka.svc.cluster.local:9093`              | `observability.tempo.traces.v1` | Shared Kafka cluster                               |
| Mimir    | `observability-mimir-kafka.observability.svc.cluster.local.:9092` | `mimir-ingest`                  | Pre-existing broker bundled with the Mimir release |

The separate Mimir broker predates this campaign. It was upgraded while preserving
its existing data and identity; a second Kafka cluster was not introduced for
Tempo. This topology is not a technical requirement for Mimir. Grafana's
[production Helm guidance](https://grafana.com/docs/helm-charts/mimir-distributed/latest/run-production-environment-with-helm/)
says the bundled single broker is for demos and recommends an external Kafka
backend for production. **Mimir's broker remains an availability limitation.**
Moving it to shared Kafka requires a separate data/offset migration and cutover;
changing only its bootstrap address would not transfer existing ingest records.
The version upgrade does not claim that this existing topology is production HA.

Related procedures: [Tempo](tempo-3-migration.md), [Loki](loki-3-migration.md),
[Mimir](mimir-3-2-upgrade.md), [Mimir Kafka](mimir-kafka-4-3-upgrade.md),
[Grafana](grafana-13-upgrade.md), and [RGW TLS recovery](mimir-rgw-tls-recovery.md).

## Recorded native acceptance

| System                 | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ceph and CSI security  | Ceph 20.2.4, `HEALTH_OK`, three monitors, six OSDs up/in, 601 clean or clean/scrubbing PGs, generation 3 AES256K CSI keys, AES256K-only allowed ciphers, no muted health warnings. Existing RBD/CephFS mounts migrated before prior keys were retired. Fresh RBD/CephFS provisioning, online 1 GiB to 2 GiB expansion and exact marker readback passed with the chart helper versions.                                                                          |
| PostgreSQL             | All 12 production CNPG clusters run 18.6 (19 Pods at final inventory). The major-upgrade rehearsal compared 79,233,549 rows across 18 databases and 1,173 relations. Final Buzz/Jangar/Torghut proof checks original cluster identities, metadata, grants, application logins, writes, replication and fresh backup/WAL archival. Retained PostgreSQL 17 rehearsal clones are recovery evidence, not production clusters awaiting upgrade.                      |
| ClickHouse             | Rehearsed 438,765,097 rows; upgraded through 25.8 to 26.3.16.10001.altinitystable. Both replicas preserved CHI/PVC/table identities, schema and grants. Each passed 24 native MergeTree checks; 11 replicated tables had no queued replication work or lost parts. Five application logins and historical queries passed. A quorum-two canary returned the exact UInt64 value on both replicas and was removed.                                                 |
| Keeper                 | Native 26.8.2.7, retained identity/PVC and ClickHouse coordination. An isolated znode was checked and deleted only after matching its data, stat, ACL, version and lack of children. The existing single-peer topology remains single-peer.                                                                                                                                                                                                                     |
| Flink                  | All three existing deployments retained their UIDs and restored real upgrade savepoints. Nineteen Pods reported Flink 2.2.1, all jobs ran, fresh fully acknowledged checkpoints and heartbeats advanced, and 59 Kafka partitions retained identity and non-regressing positions. Idle archive-partition recovery was checked against its actual restore seek. Kafka 4 checkpoint fixtures deserialize with the Kafka 5 connector; 77 focused tests passed.      |
| Final support services | Temporal UI served HTML, namespace and workflow APIs. Cloudflared reported its new version and four tunnel connections. Restate operator reconciled the existing Ready deployment. Both NVIDIA device-plugin DaemonSets were ready and existing GPU consumers survived the plugin rollout.                                                                                                                                                                      |
| vLLM                   | The normal Flamingo deployment runs the exact 0.29.0-cu129 image. Full acceptance recorded 36 successful measured requests, no errors/aborts/preemptions, chat/thinking/tool calls and 180K/220K/229K context checks. Twenty functional gates passed; the extra improvement-gate entry was explicitly not applicable. Measured throughput stayed within 1% of the 0.28 baseline. Model configuration, PVC identities, Plex and Saigak consumers were preserved. |
| Network policy         | kube-router 2.11.1 passed positive and negative connectivity canaries with 63 NetworkPolicy identities/specifications preserved.                                                                                                                                                                                                                                                                                                                                |

The final infrastructure readback found 83/83 Argo Applications Synced/Healthy,
three Ready Talos 1.14 / Kubernetes 1.37 nodes, all 19 production PostgreSQL
instances ready, and no Application maintenance/skip-reconcile holds. The old
Tempo/Loki runtime images were absent. This is recorded in
`final-cluster-closeout-state.json`.

Infrastructure status is a separate check: Argo `Synced/Healthy`, Pod readiness,
and HTTP readiness do not replace these native proofs. No trading strategy was
activated as part of this campaign, and Bayn execution authority was preserved.
This document makes no profitability or trading-session acceptance claim.

## Delivery record

The table links the principal reviewed transitions. Intermediate preparation,
backup and compatibility changes remain linked from their component runbooks and
PR histories. Each final image deployment used its existing delivery owner;
repository image releases used successful main builds and normal Kargo promotion.

| Change                                                                   | Reviewed merge                                                                                                                                                         | Merge commit                                                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes 1.37                                                          | [#14372](https://github.com/proompteng/lab/pull/14372)                                                                                                                 | `425f93bd0c42d18c101250c5eff3e3f8b4d1f8fc`                                                                                         |
| Ceph 20.2.4 and Kargo stable                                             | [#14380](https://github.com/proompteng/lab/pull/14380)                                                                                                                 | `806a70878cccc1af3be790cc1e6a80341275bc7f`                                                                                         |
| Controllers/network and application preparation                          | [#14382](https://github.com/proompteng/lab/pull/14382), [#14384](https://github.com/proompteng/lab/pull/14384)                                                         | `32cf5353988f2ff43e27d78223fed628ee6ea388`, `e6240b280a7e35c4f178c482b0e027d39216e883`                                             |
| Existing Ceph mounts, prior-key retirement, AES256K-only                 | [#14395](https://github.com/proompteng/lab/pull/14395), [#14418](https://github.com/proompteng/lab/pull/14418), [#14419](https://github.com/proompteng/lab/pull/14419) | `aff434ada09358dbe14d7e4b4115c46f92eea9bf`, `479f25dfc079f92a7ed8a269d950ebcbab693efe`, `ac7edcd5833a860f340977662b7d6298a8ca12c9` |
| Tempo 3 cutover / Tempo 2 retirement                                     | [#14425](https://github.com/proompteng/lab/pull/14425), [#14428](https://github.com/proompteng/lab/pull/14428)                                                         | `2b903135801a0bc85fb080a1fd451ed5b5bae3b6`, `67922edfca90c20a0a60c8458acfd001ff7967d6`                                             |
| Grafana 13                                                               | [#14427](https://github.com/proompteng/lab/pull/14427)                                                                                                                 | `f2c9e65e140ce96e0a889c2d797dc1b50d87db8c`                                                                                         |
| Mimir Kafka                                                              | [#14435](https://github.com/proompteng/lab/pull/14435)                                                                                                                 | `7fc5482cc7d44432079499321d1602a1d406308d`                                                                                         |
| Loki 3 cutover / old compactor retirement                                | [#14436](https://github.com/proompteng/lab/pull/14436), [#14438](https://github.com/proompteng/lab/pull/14438)                                                         | `9f5bfd3e52b5ed318b4dc50eb07419132ed72102`, `d471acac52844dcf4b432aef7ac046da1c5f7597`                                             |
| Hermes / Forgejo / notebooks                                             | [#14442](https://github.com/proompteng/lab/pull/14442), [#14447](https://github.com/proompteng/lab/pull/14447), [#14453](https://github.com/proompteng/lab/pull/14453) | `25d403645e0ed7f05af80291b24e2b6c7d1df67b`, `075f5658f56ca6abfe4948544288891b6170585d`, `23cbda765d9543243f3f0749311e91814031dc12` |
| Elasticsearch / Cassandra 5                                              | [#14470](https://github.com/proompteng/lab/pull/14470), [#14475](https://github.com/proompteng/lab/pull/14475)                                                         | `b3e08b35f2228c55779697e02f971176b6aef711`, `b902817c521d9b42a0235eb780c6e3e4c77217de`                                             |
| kube-router                                                              | [#14489](https://github.com/proompteng/lab/pull/14489)                                                                                                                 | `65499c9fc4236efddfd61d9e4e1bc03adacfbbb4`                                                                                         |
| Keeper                                                                   | [#14493](https://github.com/proompteng/lab/pull/14493)                                                                                                                 | `9cb93a0d6932b2accd43bccebf8908b5be96d365`                                                                                         |
| Final PostgreSQL 18 majors                                               | [#14497](https://github.com/proompteng/lab/pull/14497)                                                                                                                 | `3ac124556625b26bc4a200f8b6062656a19265ce`                                                                                         |
| ClickHouse 25.8 intermediate / 26.3 final                                | [#14500](https://github.com/proompteng/lab/pull/14500), [#14505](https://github.com/proompteng/lab/pull/14505)                                                         | `6c4b1b65fdea90f009a5d89ad2644eea555c09cd`, `61a65d3d3473c8e7d2cbbb9767e9197cbcd09608`                                             |
| CNPG health / Kafka CRD normalization / rehearsal closeout               | [#14501](https://github.com/proompteng/lab/pull/14501), [#14503](https://github.com/proompteng/lab/pull/14503), [#14504](https://github.com/proompteng/lab/pull/14504) | `6c473f9749af5af81414a652a374691c197e82ae`, `b66ec7e7522823759c9c5ceb02ecc8bf13b35771`, `da185da13b0bd2070a18dede2a4c514e91f1c462` |
| Flink 2.2.1                                                              | [#14506](https://github.com/proompteng/lab/pull/14506)                                                                                                                 | `b34a5f417601297555b2fbb29a27cb81b20c06e9`                                                                                         |
| Mimir 3.2.1 / Temporal UI / cloudflared / Restate operator / GPU plugins | [#14507](https://github.com/proompteng/lab/pull/14507)                                                                                                                 | `0cdb4515bdfc2ee4b8c357cc4286eb9ef9cd7787`                                                                                         |
| vLLM 0.29                                                                | [#14508](https://github.com/proompteng/lab/pull/14508)                                                                                                                 | `d6b09c8d64bba83f59dc54854ffda694e53a59d1`                                                                                         |
| Optional CSI helper values, subsequently withdrawn                       | [#14509](https://github.com/proompteng/lab/pull/14509)                                                                                                                 | `952a4ac6f5b9e03e7cf7d08da5529fbc5c5d3142`                                                                                         |
| CSI chart defaults                                                       | [#14511](https://github.com/proompteng/lab/pull/14511)                                                                                                                 | `b1d674fe9e4843bfa732275398101c55728e0702`                                                                                         |

Flink's final source commit passed all five required image-cohort builds before
Kargo delivered image digest
`sha256:f15bc6e036c36f1e0f2f88fc6cfd14c7505e75e836b0f1ad00113682c326f748`
on generated revision `9af06b993e6c073c8bae7a55f8efc3b507c236fb`.
vLLM's accepted upstream image is
`vllm/vllm-openai:v0.29.0-cu129@sha256:7ef5a35d1ef8ce2cf9d671dd91eec6e367c5849262e0362b4d3d4a26be0d87d2`.
Concurrent application/Bayn delivery changes are not evidence of this campaign's
work and do not authorize strategy activation.

## Evidence and retained recovery resources

Private operational receipts live under
`$CODEX_HOME/artifacts/cluster-upgrades-20260910`. Keep raw queries, logs, backups,
secrets, keys and traces out of Git. The committed procedures and merge commits
are the durable committed record; receipts establish the dated runtime result.
`final-documentation-receipts.json` contains SHA-256 hashes of the retained final
receipts and distinguishes native `PASS` records from raw Argo health readbacks.

| Evidence                                                           | Receipt or procedure                                                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Final ClickHouse identity, grants, checks and replicated canary    | `clickhouse-production-26-3.json`                                                                                                      |
| ClickHouse native backup and CSI checkpoints                       | `clickhouse-production-26-3-checkpoints.json`                                                                                          |
| Keeper version/coordination and exact canary removal               | `keeper-production-acceptance.json`, `keeper-production-canary-cleanup.json`                                                           |
| PostgreSQL application/metadata proof and new archive checkpoints  | `postgres-production-acceptance.json`, `{buzz,jangar,torghut}-final-postgres-checkpoint.json`                                          |
| Flink cohort CI, savepoints, exact delivery and native restoration | `flink-final-cohort-ci.json`, `flink-old-savepoints.json`, `flink-production-delivery.json`, `flink-production-native-acceptance.json` |
| Final support/GPU and Mimir historical/new-data proof              | `final-support-native-acceptance.json`, `final-mimir-native-acceptance.json`, `final-nvidia-native-acceptance.json`                    |
| vLLM full workload acceptance                                      | `final-vllm-native-acceptance.json`; full baseline and final reports under `flamingo-final-benchmark/`                                 |
| CSI baseline and final canaries                                    | `final-csi-native-before.json`, `final-csi-canaries.json`, `final-csi-canary-cleanup.json`, `final-csi-native-after.json`              |
| Kafka topology                                                     | `final-observability-kafka-topology.json` from the live Mimir and Tempo ConfigMaps                                                     |

Retain old PostgreSQL archives and clone checkpoints, ClickHouse backups and
snapshot content, and Flink canonical/upgrade savepoints. Database major recovery
requires the matching old image and a compatible restored data set; never run an
old major binary over an upgraded data directory. Review the freshness of a
checkpoint before recovery, because restoring it loses subsequent writes.

Nine failed historical ClickHouse/Keeper rehearsal Pods and their PVCs remain as
evidence. Their seven Job controllers were retired with orphan propagation and
UID/resource-version checks; four successful proof Jobs were retained. Do not
delete the failed Pods or recovery volumes to make a health helper green. The
strict CSI helper returned exit 1 because it reports these nine terminal Pods as
unready consumers. That check is recorded as failed, not passed. Separate native
acceptance confirmed their exact retained UIDs, no running containers, and all
95 active Ceph storage consumers ready. See `final-csi-strict-helper-result.json`
and `final-csi-native-after.json`; preserve the historical evidence.

For production data paths, preserve PVC/PV/volume-handle identities. Never
force-delete Pods, PVCs, PVs or VolumeAttachments during closeout. CI/ARC runner
resources are outside this storage-cleanup scope. Bayn execution authority and
credential identity are unchanged. The retained OpenClaw disk is not permission
to create a VM or discard its data.

## Repeatable rollout and recovery procedures

Use the `galactic-lan` context and an explicit namespace. Release state comes from
the merged source, the owning Argo Application, and actual running workloads.
Application images continue through their normal build, Kargo Freight/Stage, and
generated branch; the image pins in those branches are not edited manually.

## Database preparation

The PostgreSQL image plan is in
`scripts/cluster-upgrades/postgres-upgrade-image-plan.yaml`. The corresponding
helper validates each phase without changing source or the cluster.

1. Configure `spec.backup.volumeSnapshot.className` on the eight clusters that
   did not have snapshot configuration, preserving their current images. CNPG
   1.30 rejects snapshot Backup requests until this configuration is present;
   a default VolumeSnapshotClass does not replace the Cluster configuration.
2. After the configuration is live, add the prepared Backup resources. Their
   sync wave precedes the Cluster image wave. The Argo CNPG Backup health check
   requires `phase: completed` and `stoppedAt` before later waves advance.
   These cold primary snapshots temporarily stop writes to the affected primary.
3. Converge PostgreSQL 17 clusters to 17.11 in their existing Debian family and
   PostgreSQL 18 clusters to 18.6. The four clusters with existing backup systems
   may enter this phase after a fresh completed backup is verified.
4. Check fresh backups, extensions, image/OS compatibility, and `pg_upgrade`
   prerequisites with `postgres-upgrade-preflight.sh` before the PostgreSQL 18.6
   major transition. Change Barman archive names from `buzz-db-live` to
   `buzz-db-pg18`, `jangar-db-live` to `jangar-db-pg18`, and `torghut-db-live` to
   `torghut-db-pg18`, preserving the old archives. Bayn is already on PostgreSQL
   18 and keeps its existing archive.
5. Use `postgres-upgrade-postflight.sh` to verify the running major, expected
   image, SQL access, and extensions. Take a new base backup in each new archive.

The Redis/Open WebUI preparation Jobs request Redis SAVE before taking retained
CSI snapshots. Their server/application image changes follow a separate check
that those snapshots are ready. Preserve the source claims and backup resources
through every rollout. Recovery of a database major uses the matching snapshot
or backup and old image; do not downgrade binaries over an upgraded data directory.

## Storage and controllers

Rook/Ceph daemon upgrades precede CSI key rotation and its one-node-at-a-time
DaemonSet rollout. Verify all six OSDs up/in, active and clean PGs, intended
daemon/CSI images, key generation, attachments, and existing consumer mounts.
Run the manual `storage-upgrade-acceptance` Application for remount and RGW
conditional-write evidence after those prerequisites pass.

Talos 1.14 includes the [AES256K backport](https://github.com/siderolabs/pkgs/commit/84c1b8752ef16f78f5893fe3b0de7a9288c58d7d)
in both architectures of its Linux 6.18 kernel. The upstream Linux 7.0 minimum
does not apply to this patched kernel. Kernel key decoding was verified on all
three live nodes before requesting CSI generation 3 with `keyType: aes256k`.
Retain both previous AES generations while existing volumes remain mounted.
Run RBD and CephFS write/remount acceptance on every node with the new keys;
then move existing mounts to generation 3 and verify no kernel clients still
use the old identities. Only then retire the prior keys and restrict
`security.cephx.allowedCiphers` to `aes256k` in a separate reviewed change.
Never remove old keys while mounted clients still depend on them. Rotation
does not require changing PVC identities or data. Rotating service-key
warnings persist until the old keys leave the retained-key window, including
expired keys; verify that warning clears without muting it.

If a generation-3 mount fails, stop the consumer migration and preserve both
old generations. Do not lower the generation counter or restrict ciphers.
Recover through a reviewed new generation with a supported key type and
enough prior-key retention to preserve every mounted client's identity.

For NVIDIA GPU Operator, reconcile the reviewed CRDs before the full Application
when the installed schema cannot parse fields in the new ClusterPolicy. Preserve
Talos-owned drivers/toolkit and both node-specific NVIDIA device plugins. The
AMD source is `devices/ryzen/manifests/k8s`; its Application owns the existing
plugin/labeller resources without managing `kube-system` namespace metadata.

Argo Redis uses reconstructible cache data in emptyDir. Its StatefulSet explicitly
sets rolling-update partition zero and maxUnavailable one, because removing an
old recovery patch alone can leave a partition retained by another field manager.
Verify all three Redis/Sentinel Pods, master/replica links, Argo reconciliation,
and registry pulls before declaring the control-plane upgrade accepted.

## Observability and upstream mirrors

Create and verify the retained three-partition Kafka topic before adding Tempo 3.
Keep the old Tempo/Loki services and storage until historical queries and newly
written traces/logs work through the new services. Switch producers and Grafana
through a later reviewed source change, then drain old writers and hand over
compaction before retiring the old releases.

Publish the pinned Hermes upstream OCI index with the main-only mirror workflow
before shipping private Hermes image references. Verify its exact manifest,
attestation, and source-revision receipt. Hermes's separate toolchain build still
uses Kargo; the mirror workflow does not publish Kargo discovery tags.
