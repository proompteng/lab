# Broker and native archive stalls, 2026-11-09

The native archive was spending seconds extending data files on Ceph after its WAL moved to NVMe.
At 07:26 UTC one insert waited in `IO/DataFileExtend` and another waited for its relation extension lock.
A 40-second, 20 Hz sample recorded 90 insert extension waits, 11 extension lock waits, 78 local WAL sync
waits and six synchronous replication waits. These are wait samples, not query percentiles.
Trace `e4eff745c4b0ae469948c372adff7de0` contains a 6,011 ms insert in a 6,347 ms append.

Direct `pg_test_fsync -s 1` probes used temporary sibling directories outside PGDATA and pg_wal, then removed them.
The existing NVMe WAL volume returned an 8 KiB fdatasync in 291 microseconds. The Ceph data volume took
60,708 microseconds for one write and 1,554,745 microseconds for two writes. Other Ceph sync methods took up
to 3.97 seconds. These short probes establish the device difference at that time, not a latency SLO.
The archive contains 119 GB; changing only WAL did not remove the data-file extension bottleneck.

Trace `fa251e1281f84be8b9427785d62ca3dd` spent ten seconds before its first SQL child, then 963 ms inserting
and 63 ms committing. Connection delay must not be reported as eleven seconds of commit I/O.
A packet capture caught a five-second DNS retry at 08:17:13–18 UTC for the invalid search expansion
`bayn-db-rw.bayn.svc.cluster.local.svc.cluster.local`. All 2,346 captured DNS questions eventually completed;
the next-slowest completed in 3.42 ms. Bayn pods use `ndots:1` to resolve qualified names before search expansion.
Short names retain normal search behavior. DNS servers, credentials, TLS identities and endpoints stay the same.

Eight alternating pairs of read-only positions requests, 15 seconds apart, compared default and retained
Undici proxy pools in the same live controller. After warmup, default requests created two connections each and
needed 196–204 ms; retained requests created none and needed 66–68 ms. All returned HTTP 200,
with account quota remaining at least 178. Production retains idle connections for up to 30 seconds;
the existing scope still destroys the pool. This proves handshake savings, not elimination of the earlier
27-second response-body stall.

## Native archive NVMe migration

Use CNPG physical replication and instance reconstruction. No archive schema, client protocol, second implementation
or new storage class is introduced. The financial database is outside this migration. The final archive has two
instances on Turin and Altra with data and WAL on existing `local-path` NVMe paths. Required synchronous `ANY 1`,
hard host anti-affinity, fsync, checksums, WAL archiving and backups remain.

At preflight the existing paths had 2,140 GB free on Turin, 3,522 GB on Altra and 1,700 GB on Ryzen.
Local-path capacity is not a quota: check mount identity, free bytes and competing allocations before each rebuild.
Keep the pinned PostgreSQL image and existing generated credentials.

1. Ship the temporary three-instance manifest through reviewed main, Kargo and Argo. Ryzen is a temporary third
   failure domain. Hard host anti-affinity keeps all three instances on separate hosts. New 200 GiB data and
   32 GiB WAL claims use `local-path`; existing claims retain their original classes and bytes.
2. Wait for the third instance to finish physical bootstrap and reach streaming with negligible replay lag.
   Read `pg_stat_replication`, slots, `synchronous_standby_names` and PVC node/path mappings. Check archived WAL
   and retained capture prefixes before retiring any original instance.
3. With the original primary and new off-host synchronous standby healthy, retire the old Ceph standby:
   `kubectl cnpg --context galactic-tailscale -n bayn destroy bayn-native-arrival-db <number> --keep-pvc`.
   Preserve its detached claims until final verification. Let CNPG reconstruct its replacement on NVMe.
4. Once that replacement is caught up, promote it with the same plugin's `promote` command. Verify its off-host
   synchronous standby before retiring the former primary. Reconstruct that instance on NVMe.
   Never retire an active primary or two instances together.
5. Ship the final manifest: two instances, required 100G affinity, no Ryzen toleration, and annotation
   `cnpg.io/reconciliationLoop: enabled`. Immediately before syncing it, pause only this cluster's reconciliation
   with `cnpg.io/reconciliationLoop=disabled`, retire the temporary Ryzen standby with `destroy --keep-pvc`,
   then sync that reviewed final revision to resume at two instances. PostgreSQL keeps serving on both 100G hosts.
   Do not simply scale three healthy instances down: CNPG selects the highest-numbered standby, not necessarily Ryzen.
6. Verify physical separation, NVMe data/WAL mounts, required synchronous replication, fsync/full-page writes,
   checksums, archived WAL and capture prefixes. Exercise new durable appends and controller reads. Compare live
   population histograms, traces, logs and sampled DB waits while recording arrival rate and backup activity.
7. After successful verification, remove only detached migration claims and their identified retained WAL paths.
   Remove diagnostics and forwards. Do not touch control-database claims or unrelated storage.

On failure, stop retiring instances. Preserve the healthy primary, off-host synchronous standby and original claims.
Investigate without permitting asynchronous commits. A missing synchronous standby must block writes.

References: [CNPG storage recreation](https://cloudnative-pg.io/docs/1.30/storage/#re-creating-storage),
[CNPG durability](https://cloudnative-pg.io/docs/1.30/replication/#data-durability-and-synchronous-replication),
[Kubernetes pod DNS](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/).
