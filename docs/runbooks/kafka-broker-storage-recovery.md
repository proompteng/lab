# Kafka storage migration and recovery

Kafka has three controller-only nodes in `pool-a` and three broker-only nodes in `pool-b`.
Keep the existing cluster ID, node IDs, directory IDs, original PVC names and non-JBOD mount paths when moving data.
A new cluster or translated consumer offsets cannot preserve the immutable offsets recorded by Kafka clients.

## Storage and placement

The [Kafka application](../../argocd/applications/kafka/README.md) owns the `kafka-nvme` StorageClass and six
static local PVs. Each PV uses `Retain`, an explicit local path and required host affinity.
One controller and one broker belong on each host:

| Host | Controller, 30 GiB | Broker, 200 GiB |
| --- | --- | --- |
| Altra | `/var/mnt/local-path-provisioner/kafka-nvme/controller` | `/var/mnt/local-path-provisioner/kafka-nvme/broker` |
| Turin | `/var/mnt/turin-nvme-intel/kafka-nvme/controller` | `/var/mnt/turin-nvme-transcend/kafka-nvme/broker` |
| Ryzen | `/var/mnt/local-path-provisioner/kafka-nvme/controller` | `/var/mnt/local-path-provisioner/kafka-nvme/broker` |

Local PV capacity is a reservation, not a filesystem quota. Verify the mount device, filesystem, free bytes and
other reservations before preparing a path. Never format a disk, reuse an unrelated directory or allocate on
Ceph's NVMe DB/WAL devices. Turin's CI must drain to Ryzen before its Transcend disk receives Kafka data.

## Establish the recovery boundary

Use an explicit Kubernetes context and namespace for every operation. Capture the Kafka resource, NodePools,
StrimziPodSets, exact pod/PVC/PV UIDs, source image handles, cluster and directory identities, complete topic
inventory, partition cuts, consumer offsets and replication state outside Git. Do not capture Secrets.

Rehearse the exact copy, PVC handoff and operator adoption on a disposable cluster with the same Kafka and
Strimzi versions before production. Include numbered records, committed group offsets, writes during recovery,
operator restart and an operator-managed pod recreation. A Pod becoming Ready does not establish data preservation.

Pause reconciliation only for the bounded maintenance interval. The Kafka Application's
`argocd.argoproj.io/skip-reconcile` annotation survives ApplicationSet reconciliation; changing its automated
policy alone does not. Preserve and restore its previous annotation and policy. A Kafka pause annotation alone
does not stop the independent StrimziPodSet controller. Stop the operator during the handoff and keep Kafka serving.
Do not disrupt production nodes while rehearsing an operator pause.

## Move one stopped node

1. Require healthy controller quorum, all brokers available and full ISR before stopping a node. Save the desired
   Pod from its StrimziPodSet. Stop only that node gracefully and confirm it is gone before mounting its data elsewhere.
2. Change the exact source PV to `Retain` and read it back before deleting any claim. Keep its source claim mounted
   read-only for the copy. Bind the temporary destination claim to the exact target `volumeName` on the stopped node's host.
3. Copy the entire filesystem with sparse files, ownership, modes and extended attributes preserved. Flush the target.
   Compare the complete file inventory, lengths, SHA-256 hashes and `meta.properties` before Kafka starts.
   A partial copy, count-only comparison or missing identity is a failed gate.
   Exclude only an empty root `lost+found` administration directory from the Kafka manifest. A nonempty or
   symlink recovery directory aborts the copy; all Kafka file attributes, including security labels, remain strict.
4. Release the original claim and temporary target claim only after the verified copy. Rebind the target PV to the
   original PVC name with its new UID and explicit `volumeName`. Verify both sides of the binding and host affinity.
5. Recreate the saved desired Pod, preserving storage type, volume name, mount path, log directory and node ID.
   Do not reuse a live Pod's stale `nodeName`. Kafka's startup can delete metadata when its configured metadata path changes.
6. Confirm the original cluster/node/directory identities. Wait for controller catch-up or every broker partition
   to return to full ISR before moving another node. Never move two controllers or two brokers concurrently.

Kafka changes active files during startup and catch-up. The full-copy hash gate belongs before startup;
a later filesystem hash mismatch alone cannot diagnose data loss. Keep both copy receipts and application-level reads.

## Adopt and verify

After all copies, the reviewed desired NodePool classes and each StrimziPodSet's `strimzi.io/storage` annotation
must describe the same non-JBOD NVMe storage. Ordinary edits to a NodePool storage class are rejected by Strimzi.
Validate the complete handoff before restarting the operator, then restore normal GitOps reconciliation.

Require successful subsequent reconciliation and an operator-managed recreation that keeps the correct NVMe binding.
Compare cluster and topic IDs, all managed and unmanaged topics, partition assignments, retained offsets, committed
consumer positions and record witnesses. Check full ISR, controller quorum and replica lag. Exercise a producer and
consumer through the unchanged bootstrap listeners and verify real application ingestion and consumer progress.
Ryzen has a slower network link than Altra and Turin; measure its catch-up and client behavior rather than inferring
performance from the storage device or health indicators.

## Recovery and retirement

A retained source is a recovery source for that individual node at its copy time. Six rolling source copies are
not a coherent whole-cluster snapshot. Never restore all old volumes together. Recover one node while the other
members remain authoritative, or reverse-copy the current quiescent NVMe data before rebinding to a recovery volume.
Do not scale a pool down to replace a disk: that changes node identity and can remove replica assignments.

Retire only the six captured old Kafka Ceph PVs after copy, reconciliation, recreation, data and client gates pass.
Verify they have no current PVC, Pod or VolumeAttachment users. Delete their exact backing images through the CSI
reclaim path, then prove both Kubernetes objects and Ceph images are absent. Keep all unrelated Ceph pools, claims
and database WAL devices intact. Remove temporary proof resources and paths, and restore the saved reconciliation state.

References: [Strimzi 1.2 recovery from persistent volumes](https://strimzi.io/docs/operators/1.2.0/deploying.html#assembly-cluster-recovery-from-persistent-volumes-str),
[Strimzi Kafka startup](https://github.com/strimzi/strimzi-kafka-operator/blob/1.2.0/docker-images/kafka-based/kafka/scripts/kafka_run.sh#L55).
