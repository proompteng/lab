# September 2026 stable upgrades

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
