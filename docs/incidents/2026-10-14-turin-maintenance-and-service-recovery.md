# Turin maintenance and service recovery on October 14, 2026

Status: recovery in progress. Evidence updated through approximately `16:04Z` on October 14.
This report does not declare the incident closed or all applications recovered.

## What happened

An authorized Kata r6 installation on physical Turin became a prolonged infrastructure outage.
The maintenance drained a host that also carries three Ceph OSDs, one Ceph monitor, trading dependencies,
GPU workloads, and CI capacity. The installer completed, but the first reboot lost the Kingston NVMe
used by the three OSDs for BlueStore DB and WAL. A chassis power cycle restored disk enumeration.
The subsequent boot stalled mounting the ORICO XFS `EPHEMERAL` filesystem during quota checking.

A third restart completed the quota check and returned Turin to Kubernetes. The host recovered with
project quotas still enabled. The staged attempt to disable quotas did not become the active configuration
and must not be credited with the recovery.

Restoring host readiness did not restore all applications. Two Mimir volumes reported ext4 metadata errors.
The private registry had RBD mount timeouts. Kafka had unavailable partitions despite several ready Pods.
Bayn had an unfinished GitOps deployment with old containers still requiring a removed secret key.

## Impact summary

- Turin was drained and remained cordoned until host, disk, storage, GPU validation, and four Kata runtime checks passed.
- Turin's interruption removed three of six Ceph OSDs and one of three monitors. Altra also rebooted while Turin
  was unavailable. Both storage hosts were therefore interrupted during the incident; describing the whole outage
  as uninterrupted operation on the other three OSDs is incorrect. The exact interval of complete storage or etcd
  unavailability has not been established.
- The registry outage blocked missing image pulls and image publication for unrelated applications.
- Bayn's database replica, two ledger replicas, GPU model, and one Valkey replica could not schedule during the cordon.
- Bayn's old application replicas were already unavailable at `07:10:12Z`, before the maintenance drain.
  That existing deployment failure must be distinguished from the additional infrastructure interruption.
- Altra's kernel boot timestamp was `07:49:43Z`, while Turin was still unavailable. The cause and owner of that
  overlapping reboot have not been established. Its timing is confirmed; causation is an open investigation.
- No conclusion about missing trades, accounting loss, data loss, or trading readiness follows from Pod readiness alone.

## Timeline

All timestamps below are UTC on October 14. Pacific daylight time is seven hours earlier.

| Time           | Confirmed event                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| 07:10:12       | Bayn Deployment recorded no minimum availability, before the physical maintenance.                                  |
| About 07:30    | Turin was cordoned and drained for the authorized installer replacement.                                            |
| 07:37:36       | First physical restart requested after successful r6 installation.                                                  |
| 07:41:48       | New Turin boot observed. Kingston NVMe was absent.                                                                  |
| 07:49:43       | Altra kernel boot timestamp during the Turin outage. Cause remains unresolved.                                      |
| 07:53:55       | Turin chassis power cycle requested after disk rescan failed.                                                       |
| 07:57:25       | New Turin boot observed with all four expected NVMe serials present.                                                |
| 08:04 to 08:23 | Repeated observations showed the XFS quota flush blocked with unchanged disk counters.                              |
| About 08:28    | Talos accepted a staged quota-disable configuration. Persistent resource readback showed `false`.                   |
| 08:30:42       | Third restart requested to apply that staged recovery.                                                              |
| 08:34:09       | New boot started the quota check with quotas still enabled.                                                         |
| 08:34:59       | Kernel logged `Quotacheck: Done.` and Talos mounted `/var`.                                                         |
| 08:35:18       | Turin became Ready. CRI, etcd, kubelet, and Tailscale were running.                                                 |
| About 08:38    | Four existing Turin-pinned Ceph Pod instances received a temporary cordon toleration.                               |
| About 08:40    | All four Kata runtime checks passed with guest and host evidence.                                                   |
| About 08:41    | Six original OSDs were up and in, all three monitors had quorum, and all 601 PGs were active. Turin was uncordoned. |
| About 08:44    | Registry RBD snapshot retained before offline filesystem recovery.                                                  |
| 09:09:31       | Turin's committed `EPHEMERAL` growth prevention merged; later active and persistent readback confirmed it.          |
| 09:36:10       | Hermes foreground-process PID-file fix merged.                                                                      |
| 09:52:02       | External Secrets controller memory fix merged.                                                                      |
| 09:53:26       | Existing External Secrets canary refreshed after the normal controller rollout.                                     |
| About 09:56    | Both repaired Mimir claims passed clean checks; original ingester owner and Argo reconciliation restored.           |
| 09:56:12       | Kafka broker 3 finished its natural restart and logged `Kafka Server started`.                                      |
| About 10:09    | All three Mimir ingesters and all three Tempo V3 live stores were Ready.                                            |
| About 10:22    | Registry cleanup was suspended before its scheduled run while the registry volume remained offline.                 |
| About 10:27    | Full registry read-only filesystem check completed with exit 0 after repair.                                        |
| 10:34:26       | Restored registry front door returned HTTP 200 from `/v2/`.                                                         |
| About 10:40    | The current Bayn source image finished normal immutable publication after registry recovery.                        |
| 10:46:26       | Hermes toolchain Kargo promotion finished with `Succeeded`.                                                         |
| About 10:56    | Registry cleanup and Argo reconciliation restored after the missed cleanup deadline had expired.                    |
| 11:08:48       | Bayn committed migrations 97, 98, and 99 in the native PostgreSQL migration table.                                  |
| 11:17:00       | Sealed Secrets web architecture placement fix merged.                                                               |
| By 11:18       | Torghut Kargo promotion succeeded; both Flink jobs reported `RUNNING`; Sealed Secrets web had one Ready replica.    |
| By 11:27       | Both Flink jobs had fresh completed checkpoints; Bayn controllers reported fresh crypto projections with zero lag.  |

## Root cause

### Missing Ceph metadata device

The Kingston serial `50026B76878F0B27` disappeared after the first reboot and returned after a chassis power cycle.
The original OSD identities and data disks were preserved. This proves enumeration recovery, not the cause of the
hardware failure. No OSD was purged, reformatted, or recreated.

### XFS quota flush blocked host startup

A blocked PID 1 thread waited in `xfs_qm_flush_one`, reached through `xfs_qm_quotacheck` and `xfs_mountfs`.
Disk counters stopped changing. `/var` was not mounted even though the volume status said `ready`.
CRI waited for the mount. The Tailscale extension waited for CRI, so the node also could not reach Omni's
Tailscale endpoint. The console's unreachable SideroLink endpoints were downstream symptoms of incomplete boot.

The existing [quota investigation](../../devices/turin/docs/xfs-quota-boot-recovery.md) had documented this failure
class on October 10. Talos's temporary growth mount disables quota accounting and forces a recount on the final mount.
The underlying kernel flush-lock trigger on this host remains unproven.

### Application recovery required more than node readiness

Ceph block availability returned before every filesystem could mount. CSI explicitly required manual ext4 repair
for Mimir ingesters 0 and 1. Their claims are `pvc-4a2a8f0e-5860-4bfe-8a29-78a2557f75eb` and
`pvc-5ec81c52-7be4-44df-98f4-d451e90d6a1b`. The registry claim is
`pvc-7cefa093-bbfd-448c-9b9e-6228bf672374`; its recorded failures were mount timeouts and an operation already in progress.
Repair acceptance requires an RBD snapshot, a stopped owner, no attachments or users, and an unmounted filesystem.

The recovery agent initially attributed nearby CSI filesystem errors to the registry without resolving the
request's volume handle to its PVC. That was incorrect. It led to an offline forced check of the 2 TiB registry
filesystem, extending registry downtime. The registry's own metadata errors were not established by those logs.
The forced check later independently found an invalid upload-directory inode and corrupted directory entries.
That later discovery does not justify the earlier incorrect diagnosis. The check corrected those entries and
restarted its scan. Its one-hour maintenance Pod deadline was insufficient for the restarted scan; the agent sent
SIGINT, waited for exit 32 and the original process to disappear, and continued the offline check from a separate
three-hour Pod. The original volume remained unmounted throughout. The subsequent check uses a bounded 4 MiB
readahead window after the original process was observed blocked in kernel `fadvise` readahead.

The final registry repair exited 1, indicating corrected errors. A separate full read-only forced check then
exited 0. Native feature readback also showed that this filesystem had no ext4 journal. With the owner stopped,
the snapshot retained, and no mount or other device user, `tune2fs -j` added a standard journal. Feature readback
then contained `has_journal`, journal inode 8, and a clean filesystem state; a subsequent non-forced read-only
check also exited 0. The original StorageClass did not disable journaling. Why this particular filesystem lacked
a journal has not been established. The journal reduces one recovery risk; it is not proof against future corruption.

The original registry Deployment and claim were restored. HTTP 200 from `/v2/`, a retained Bayn manifest with its
expected digest, successful immutable image publications, and fresh private image pulls established current service
recovery. They do not prove that every historical registry blob remains valid. Repair cleared an invalid blob link
for `sha256:fcedcb5c61d35b66579470e6b235de3b2613d4dc0523483a7bd727d0587a6add` that pointed at an upload directory.
A complete retained-catalog audit remains open. No tag alias was fabricated or used to conceal a missing artifact.
A later check covered all 33 private image references and image volumes on Running Pods: 105 manifest hash checks
and 1,503 referenced-blob presence/size checks passed. Six initial 404s came from the diagnostic parser retaining
an optional tag in a `name:tag@digest` repository path; canonical repository/digest requests passed. Those parser
errors were not registry corruption. The check did not read every layer byte or audit the full historical catalog.

All registry maintenance Pods and owned offline mappings were removed. The registry's production CSI mount later
reused the same `/dev/rbd12` name; that device number no longer identified a maintenance mapping. The scheduled
cleanup was suspended during repair and restored after its 30-minute starting deadline expired, preventing a delayed
cleanup run from competing with recovery uploads. Argo's original reconciliation policy was restored as well.

Kafka's metadata quorum was available, but the unavailable-partition query still reported partitions without leaders.
Broker 3 had failed initial registration at `08:11:59Z` while the controllers were unavailable, then waited for
log recovery and a graceful log shutdown. A thread dump showed its main thread waiting for log-closing workers
performing filesystem flushes. It exited at `09:51:23Z`, restarted through its existing Pod policy, and reached
`Kafka Server started` at `09:56:12Z`. No data-broker Pod was manually deleted to force that transition.
The unavailable-partition query returned zero after that restart, but replication and fresh ingestion still
required separate acceptance.

Bayn's activation hook was retried from the existing Kargo-generated commit after its dependencies returned.
After Kafka recovery, the controller still failed migration 97 because the old image converted retained orders
before replacing a schema-version-dependent constraint. The Bayn owner had already merged the source repair in
[PR #15033](https://github.com/proompteng/lab/pull/15033); its new image publication was blocked by the registry.
No production constraint was removed manually, no migration was marked complete, and no activation credential
was fabricated. These checks remain part of acceptance rather than being replaced with weaker readiness probes.

The correct source, `fefcf364cbe8683b1a5ce45e0585b79ae7832fe7`, published as
`sha256:b4cce1783a52ddf440413992604e978e021b2a8e601d709077b3ad8145d991cb` after registry recovery.
An older publisher completed first and temporarily occupied Bayn's promotion path. Its Argo operation was terminated
through the native operation control, allowing the already queued correct Freight to proceed. The attempted Kargo
abort conflicted with a resource-version change and was not applied; its previous promotion had already errored.

The correct image initially exceeded its existing 15-minute migration deadline and rolled back. A later startup
completed migrations 97–99 at `11:08:48Z`. Both exact-image controllers then became Ready and reported available
Kafka projections, zero offset lag, and recent BTC, ETH, and SOL quotes. A proposed 30-minute migration budget,
45-minute startup probe, and 60-minute promotion timeout passed isolated tests, but was withdrawn after native
migration completion made it unnecessary for recovery. None of those proposed changes was committed or deployed.
After migration, native Restate inspection found three obsolete paused calls: a broker-observation poll and two
controller calls. The poll held its exclusive object lock, preventing the new observation activation from proceeding.
The controller calls had only input journal entries. The poll journal contained input, an eager state read, and the
read/publish operation. Its pinned historical worker had no Ready endpoints because it required the removed legacy
configuration. Native database guards confirmed OBSERVE authority, an active kill switch, no open orders or
nonterminal intents, and flat broker and accounted positions before intervention.

Graceful cancellation completed the obsolete controller calls but could not finish the poll against the unavailable
historical endpoint. Only that exact read/publish invocation was then stopped through Restate's native kill API.
No service registration, durable object state, financial row, or PVC was deleted. The previous poll's terminal
`[409] killed` result and the controller-call outcomes remained queryable. The financial event counts stayed at
731 order events, 1,620 mutation events, and 412 accounting transactions. These controls follow
[Restate's cancellation and kill semantics](https://docs.restate.dev/services/invocation/managing-invocations).

The next automatically published Bayn source, `e8e2e9ba0b144b6ea5f547903f770fafbc9d03cf`, deployed through Kargo
at digest `sha256:5e41072927a18ae52ecae1012e3c9d1e66425f48c4c4e11fee496f85d2d19a11`.
Two current activation invocations completed successfully, and native controller sequence numbers began advancing.
At `11:42:37Z`, `/readyz` and `/v1/status` returned HTTP 200. Status reported exact accounting: all 412 fills had
matching transactions and receipts, with zero unaccounted fills or unreceipted transactions. This was a recovery
point, not sustained acceptance: readiness subsequently returned 503 for broker and cycle-runner unavailability.

### Bayn cache connection race

A fresh production diagnostic passed authenticated Valkey primary writes, replica reads, deletion, key-prefix
rejection, and unauthenticated rejection. Native server readback showed an online replica and no pending AOF fsync.
The application nevertheless failed broker publication. A retained Tempo trace identified `ValkeyCacheError` caused
by `The client is offline`.

A local TCP regression reproduced the failure: after a command abort closes the shared client, two concurrent callers
race through reconnect. One observes an open but unready socket, fails, and destroys the other caller's connection.
This repeatedly prevents full and compact broker materializations from publishing. It is an application connection
ownership defect, distinct from Valkey server readiness and Ceph's residual warnings.

[PR #15047](https://github.com/proompteng/lab/pull/15047) gives each command ownership of that scoped connection
through reconnect, execution, and cancellation. It preserves the one-second overall deadline, TLS, ACLs and replica
acknowledgement; queued cancellation cannot close the active command's socket. Reconnect happens on the next command
instead of in a competing background retry. The new regression failed before the fix and passed afterward. All 14
Valkey transport/boundary tests, the full Bayn suite (2,949 passed, 394 skipped, zero failures), type checks, linters,
and build passed. Every remote gate, including PostgreSQL persistence and both architecture image builds, passed
before the match-head squash merge `fa7562dde3cf726f7e12cdab4c6987ce3e699867` at `12:22:17Z`.

The main publisher run `38563291542` completed both platforms and the immutable index. Freight
`e4ac9447c3bc122f9d8365c14bfc8c27a7a00c8f` selected image
`sha256:2457655596eaace6cb441defc8e0967eedb1fbda440443c7d27a1a03a21e2b15`.
Promotion `bayn.01m4x62zwcjftctg565q0b90w5.e4ac944` generated
`db887c0c6107b8835ac2eafb4c05b843ad0a4860` and succeeded at `12:29:43Z`. Argo completed its native activation hook
and reported `Synced` and `Healthy`; current public and controller replicas were Ready on both Turin and Altra.

The deployed `valkey-command.js --broker` passed on both hosts, including synthetic cache lifecycle checks and
20 full/compact production reads per host with account, age, database-fence, content-hash and parent-snapshot checks.
The full payload was 731,459 bytes and the compact payload 3,818 bytes. Full-read P95 was 80.95 ms on Turin and
179.50 ms on Altra; compact-read P95 was 13.54 ms and 16.52 ms. These are bounded acceptance samples, not a capacity
or long-term P99 study.

A subsequent two-host readiness window from `12:35:20Z` to `12:39:51Z` passed 19 of 20 checks. The first Turin
sample reported broker-read unavailability; all later samples passed, with unchanged Pod UIDs and no additional
restarts. The failed sample remains part of the result. A new trace showed that some publication attempts still
failed the enforced replica-acknowledgement guard during storage recovery, rather than the old reconnect race.
At `12:43:57Z`, both exact-image endpoints returned ready HTTP 200 and exact accounting, while the native controller
had advanced to sequence 141,993. Capital authority remained none/OBSERVE with read-only broker access.

A second two-host readiness window from `12:52:25Z` to `12:56:55Z` passed 16 of 20 checks. Four samples failed
broker readiness; PostgreSQL, the ledger, and the controller remained available in those retained samples.
Fresh Tempo traces showed enforced one-second Valkey GET and PUT deadlines, a subsequent unavailable observation
fence, and separate successful polls. These are observed failure modes; the underlying transport, scheduling or
storage cause has not been isolated. They do not justify relaxing freshness, replication or command deadlines.
A separate native twenty-read diagnostic still passed during that window, with full-read P95 of 764.81 ms on Turin
and compact-read P95 of 7.80 ms. This variability and the two failed windows leave sustained Bayn readiness unaccepted.
At approximately `12:59Z`, Argo reported Bayn as `Synced` and `Progressing`.

The reviewed cash-spot cutover deliberately has no capital activation request and includes a PAPER-to-OBSERVE clamp.
This account was already OBSERVE with its kill switch active at `07:09:59Z`, before maintenance. Fresh native
reconciliation cleared the kill switch at `11:40:32Z`; maximum and effective authority remained OBSERVE, broker access
remained read-only, and no capital mandate was created. The documented next step for trading is a separately reviewed
PAPER mandate bound to the verified account, image, and current strategy/risk identities. Infrastructure recovery does
not supply that mandate or grant live authority.

### Market-data archive and Sealed Secrets web

The retained market-data archive JVM reported a missing Kafka SCRAM callback class after broker recovery. Inspection
of its actual application JAR found the class present. A user-classloader lifecycle problem is a possible explanation,
not a proven packaging defect. No speculative dependency or authentication change was made. Native Kargo promotion
of the existing published Torghut Freight replaced both Flink jobs through their configured savepoint path.
Both jobs reached `RUNNING` and subsequently completed fresh checkpoints in the existing S3 checkpoint store.
An earlier checkpoint failure remains in the archive job's history. No consumer offset reset or checkpoint deletion
was used to obtain a green status.

Sealed Secrets web repeatedly failed with `Exec format error` after placement on ARM64 Altra. The upstream v3.3.2
image's ARM64 descriptor and config contained an amd64 executable: ELF `e_machine` was 62. Restricting that web
Deployment to amd64 restored it. The Sealed Secrets controller, keys, and sealed credentials were unchanged.

## Five Whys

The failure paths diverge. The chains below stop where evidence ends or where a changeable system cause is reached;
unknown hardware or reboot causes are not filled in with assumptions.

### Host startup and shared availability

1. Trading dependencies, private image delivery, and other services were unavailable because physical Turin did not
   return its storage and workload capacity after maintenance; Altra's overlapping reboot also interrupted the peer.
2. Turin did not return that capacity because `/var` was not mounted, so CRI, kubelet, and Tailscale could not start.
3. The mount did not complete because the XFS project-quota recount blocked in the quota-flush path.
4. A recount occurred because the configured Talos growth path temporarily mounts without quota accounting and forces
   a recount on the final mount, as the existing October 10 investigation had documented.
5. The known risk reached maintenance because preflight did not require that documented growth/mount condition to be
   resolved and verified on Turin. Configuration readback and the known boot-risk check were not an enforced gate.

Action: the Turin-specific `grow: false` change is committed and verified in active and persistent configuration.
Future maintenance must verify that readback and use the existing boot runbook before interruption. The kernel's
underlying quota-flush stall remains unproven, and the prevention change still needs a future authorized boot test.

### Missing NVMe enumeration

1. Turin's three OSDs could not start after the first reboot because their common Kingston DB/WAL device was absent.
2. The device was absent from native enumeration after that boot and returned after a chassis power cycle.
3. The retained evidence does not isolate a PCIe, controller, firmware, power, or physical-device cause. The chain stops
   at that uncertainty; the power cycle is an observed recovery action, not a hardware diagnosis.

Action: retain serial-based inventory and collect PCIe/controller reset evidence during the next authorized
investigation. Do not recreate OSDs or replace data merely because a device number or serial disappears from one boot.
Altra's separately observed reboot is not attributed to this NVMe failure or to the quota mechanism.

### Registry recovery delay

1. Applications and publishers remained blocked after host recovery because the registry remained offline.
2. Registry downtime was extended by a forced offline check of its 2 TiB filesystem and the restarted scan.
3. That check was selected before a registry-specific manual-repair error had been established.
4. CSI errors for the two Mimir claims were attributed to the registry from adjacent truncated log output, without
   binding each error's volume handle to its actual PV, PVC, and owner.
5. The repair decision proceeded on a narrative diagnosis rather than a required volume-specific error binding.
   Offline ownership safeguards protected the repair itself, but did not validate the reason for choosing it.

Action: require the exact error-to-volume ownership binding before selecting offline repair, alongside the existing
exclusive ownership, snapshot, device-identity, and process-exit guards. The registry's later independently found
metadata damage and missing journal do not retroactively validate the initial misattribution.

### Bayn materialization failure after activation

1. Bayn readiness degraded because the broker and cycle runner could not obtain a fresh published observation.
2. Publication failed because the Valkey client was offline, despite passing native server and access checks.
3. Concurrent callers dispatched a command while another caller was reconnecting the same open but unready client.
4. The failing caller destroyed the shared socket, interrupting the other reconnect and repeating the failure.
5. Connection ownership was not enforced across reconnect, request, and cancellation. Tests covered initially ready
   concurrent reads and sequential recovery, but not concurrent recovery or cancellation of a queued caller.

Action: PR #15047 adds that ownership boundary and both missing regressions. The old failure reproduced locally,
all required gates passed, and the immutable rollout completed. Native full/compact reads passed on both hosts.
Both recorded readiness windows, command-deadline failures and residual replica-acknowledgement rejections remain explicit acceptance limits.

### Ofz's independent archive release

1. The new exporter could not acknowledge its bootstrap audit receipt because the old NUC backend rejected the
   required encrypted write. The archive fence prevented a fabricated acknowledgement or platform activation.
2. The reviewed NUC encryption update had not been deployed when the fenced cluster release started its exporter.
3. Deployment was treated as blocked by SSH agent failure even though the existing direct NUC key worked through
   its short alias.
4. The canonical DNS name selected different SSH options because the global 1Password rule excluded only `nuc`.
5. Effective canonical-host configuration and native access were not checked against the known working alias before
   treating an SSH unlock as an external blocker.

Action: the reviewed archive source is deployed and pinned under persistent storage with its original credentials,
and all verified NUC names now select the same existing direct key. Native encrypted retention/readback and the
production audit acknowledgement passed. The separate identity/runtime cutover remains fenced under its owner.

## Contributing factors and maintenance mistakes

The maintenance agent missed the existing October 10 XFS runbook before rebooting. That delayed diagnosis of an
already documented risk. The agent also treated the staged configuration resource as evidence that a hard restart
would apply it. Active configuration and mount readback disproved that assumption.

Recovery updates focused on the devbox before physical Turin and shared services had recovered. The user had to
redirect the work to the host and then explicitly prioritize trading. Future maintenance must define the dependency
recovery order before interruption and report actual application availability throughout the outage.

The CSI log misattribution added another avoidable delay. Every storage error must be bound to a volume handle,
PV, PVC, owning controller, and current device mapping before a recovery action is selected. A nearby log line and
an enumerated `/dev/rbdN` name are insufficient evidence.

## What was not the root cause

- Disabling project quotas did not recover Turin: the working boot completed its quota check with quotas still enabled.
  A staged resource showing `false` was not evidence of the active boot configuration.
- Console SideroLink and endpoint-watch failures did not establish the original boot trigger. They were downstream
  of the blocked mount and unavailable CRI/Tailscale path.
- The initial registry CSI excerpt did not prove registry filesystem damage. The explicit manual-repair errors
  belonged to the two Mimir claims; registry corruption was established independently later.
- The archive JAR did not omit the reported Kafka SCRAM class. Native inspection found it present, leaving the
  runtime classloading failure unproven.
- Passing Valkey server health alone did not explain or resolve Bayn's later failure. The native trace and local
  regression identified a client connection ownership race.
- A Ready host, an accepted invocation, a running Job, or one successful HTTP probe did not establish durable
  application recovery, complete historical telemetry, or permission to trade.

## Recovery actions and corrective changes

[PR #15034](https://github.com/proompteng/lab/pull/15034) merged as
`cfe63e5491577d5fbb12cc0601dc83fd1779095e` at `09:09:31Z`. The committed template was rendered, validated,
reviewed through an Omni dry run, and synced. Active and persistent Turin configurations then both contained
`VolumeConfig EPHEMERAL provisioning.grow: false`. The live volume retained project quota support.
No further host restart was used to validate that change. Its next-boot behavior remains unverified.

Hermes's egress proxy also failed because `/run/squid/squid.pid` survived a container restart in an `emptyDir`.
The file contained PID 1, causing the next Squid process to report another running instance. Recreating that Pod
restored the proxy. [PR #15039](https://github.com/proompteng/lab/pull/15039), merged as
`620509827a95f879d1149369f1ef70496f081445` at `09:36:10Z`, disables the redundant PID file for the foreground
container process. Image publication and Kargo deployment were still blocked by the registry when this source fix merged.

The normal Hermes toolchain publisher and Kargo promotion later succeeded. Production readback confirmed
`pid_filename none` and no PID file. A disposable container using that pinned image and configuration then started
with a retained stale PID 1 file, survived SIGKILL and restart with the same directory, and continued rejecting a
private CONNECT destination. This proves the retained-directory restart behavior without interrupting the serving proxy. [PR #15041](https://github.com/proompteng/lab/pull/15041) also fixed placement of the existing disposable
Hermes network-policy probe by admitting the second amd64 node's existing compute taint. Required cross-node
anti-affinity remained in place. The native probe completed with `network_policy_enforced=true`: baseline access,
denied access after policy enforcement, and restored access after the allow rule, using a fresh private image pull.

[PR #15040](https://github.com/proompteng/lab/pull/15040), merged as
`e090b95105785bbb188c3113dd2239aaa17f1839` at `09:52:02Z`, increases only the main External Secrets controller
memory limit from 256 MiB to 1 GiB. Both old replicas were repeatedly OOMKilled with exit 137. The normal Argo
rollout produced two Ready replicas with no restarts, and the existing canary refreshed successfully at
`09:53:26Z`. All 30 ExternalSecrets reported Ready after that rollout. Webhook and certificate-controller limits,
provider identities and Secret values were not changed.

Both original 20 GiB Mimir ingester volumes were snapshotted, repaired offline, and then passed read-only checks
with exit 0. The temporary mappings were removed and the original three-replica StatefulSet and Argo reconciliation
were restored at approximately `09:56Z`. Ingestion readiness still depended on Kafka consumer and replica recovery.

All Mimir ingesters and Tempo V3 live stores later became Ready. Mimir's Kafka replay rejected some older samples
with `err-mimir-sample-timestamp-too-old`; complete historical telemetry recovery is therefore not established.
No acceptance window was weakened, offset reset, or synthetic backfill performed to hide those rejections.

[PR #15043](https://github.com/proompteng/lab/pull/15043), merged as
`010a9096f726efa75b26897691c5195036bd7082` at `11:17:00Z`, pins only Sealed Secrets web to amd64. The rendered
manifests and server dry run passed before merge; the normal Argo rollout produced a Ready web replica and native HTTP 200.

The Ofz audit exporter failed against the NUC archive's previous unencrypted backend. The already reviewed
`2ad3b50412db8b0d4d0ba4896ca072faf9599b61` source and successfully published Ofz tool image
`sha256:19e448288b6c11cc499c2ab85c75f3b268b5b57ec96c7214db63a5d415609511` were deployed through the existing
NUC deployment procedure. The same credential manifest, backend data, and archive versions were preserved.
The first wrapping key was atomically persisted and its identity pinned. Repeating deployment from the retained
`/var/lib/ofz-recovery/source/<commit>` archive preserved that identity and left all container bind mounts under
the persistent data root. No running service depends on a temporary source directory.

Native verification proved AES256 encryption, version-specific readback, ninety-day COMPLIANCE retention, writer
and custodian deletion denial, and retention-shortening denial. Both production exporters recovered naturally.
The control database showed one audit receipt and one archive acknowledgement after independent TLS readback;
Ofz became `Synced` and `Healthy`. Its SQL platform fence and the separate workspace-creation fence remained intact.

NUC's existing direct SSH key worked for alias `nuc`, while its canonical DNS name still selected the global
1Password agent. The existing Host patterns and the global rule's exclusions were extended only to the verified
NUC DNS name and Tailscale IP. All three names now select the same existing key and `kalmyk` account with
`IdentityAgent none`; canonical-host SSH returned UID 1000 and the deployed source SHA without an approval prompt.

Altra's BMC reports its last restart cause as `chassis power control command`. Its clock reads January 2012, and
its latest SEL entries contain old voltage events, so these records cannot establish a dated October 14 actor or
command. The overlapping kernel boot remains confirmed, while attribution and its exact availability impact remain open.
No Altra power command was issued during this forensic readback.

The requested Turin case-fan setting was restored and read back at 1120 RPM on FAN1, FAN3, FANA, and FANB.
The CPU fan and full-speed pump remained separately controlled; the pump read 3780 RPM. These are observed values,
not a promise of identical RPM under every future thermal condition.

## Final verification

Final acceptance remains open. The following inventory is an interim readback, not incident closure.

At approximately `12:59Z`, the inventory contained 91 Argo Applications. 88 reported `Synced` and `Healthy`, but
three of those had reconciliation paused, leaving 85 with both current health/sync and active reconciliation.
The three non-green Applications were Bayn, Home Stash and Rook-Ceph. The Cloudflare, Keycloak, and Tengri holds
belong to the separate ongoing identity/runtime cutover and must be resolved against that owner's reviewed release;
their cached Argo health is not fresh acceptance. Incident-owned registry and observability holds were removed.

| Service or dependency | Verified state                                                                                                                                                                                 | Remaining acceptance                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Physical Turin        | Ready, schedulable, original node and four NVMe identities; Kata/GPU checks passed                                                                                                             | Next boot with committed growth prevention; NVMe disappearance cause                                                                     |
| Ceph                  | Six original OSDs up/in, three monitors in quorum, all 601 PGs active; zero degraded objects or undersized PGs                                                                                 | 27 remapped PGs and approximately 629,398 misplaced objects still rebalancing; two unmuted BlueStore warnings                            |
| Registry              | Original claim mounted, HTTP 200, publication/fresh pulls restored; all 33 current private image references pass manifest/blob-presence checks                                                 | Full retained-catalog and layer-byte integrity remain unproven                                                                           |
| Kafka                 | Native unavailable-partition query again returned zero after the final Bayn rollout                                                                                                            | Session-specific input freshness; old RF1 simulation topics remain separate                                                              |
| Observability         | Mimir and Tempo Ready; original volumes and reconciliation restored; publication error trace retrieved                                                                                         | Quantify late-sample rejection gap; historical telemetry completeness is unproven                                                        |
| Market data           | Both Flink jobs running from retained savepoints, with fresh completed checkpoints                                                                                                             | Session-specific source freshness and archive progress                                                                                   |
| Bayn                  | Reviewed cache fix published/promoted/deployed; exact 412-fill accounting, natural progress and full/compact reads on both hosts verified; separate successful endpoint and native-read checks | Readiness windows passed 19/20 then 16/20; GET/PUT deadlines and replica guards remain enforced; trading requires reviewed PAPER mandate |
| External Secrets      | Two main controllers Ready without OOM recurrence; canary and all 30 ExternalSecrets Ready                                                                                                     | Routine observation at the deployed memory limit                                                                                         |
| Sealed Secrets        | Web Ready and HTTP 200 after amd64 placement; controller unchanged                                                                                                                             | Upstream packaging defect remains outside the deployed workaround                                                                        |
| Hermes                | Published/promoted toolchain, production PID-file fix, retained-directory SIGKILL regression and cross-node policy proof pass                                                                  | No outstanding incident-specific check at this revision                                                                                  |
| Ofz                   | API/playground/exporters Ready, encrypted immutable NUC archive and production acknowledgement verified                                                                                        | Separate identity/runtime migration and its deliberate fences remain owned by that work                                                  |
| Home Stash            | The long 11:08 importer Job completed normally; subsequent scheduled runs started                                                                                                              | Active CronJobs legitimately report Progressing; observe normal completion rather than deleting work to change health                    |

Ceph redundancy is improving, but a healthy host and active PGs are not equivalent to complete replication.
No Ceph profile, scrub concurrency, media I/O throttle, OSD identity, or health-warning mute was changed to force
acceptance. No recovery ETA is inferred from object count alone. Native slow-operation warning configuration retains
indications for 86,400 seconds with a threshold of one; an alert can therefore outlast the original operation and
can be extended by new slow operations. That policy was preserved. A contemporaneous OSD performance sample showed
17–68 ms average commit/apply latency, which does not establish tail latency or erase the retained warnings.

## Follow-up actions

| Action                                                                      | State and closure evidence                                                                                                                      |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Preserve Turin quotas and prevent the repeated startup growth mount         | Delivered in PR #15034 with active and persistent readback; validate at a future authorized boot                                                |
| Bind CSI errors to exact storage ownership before repair                    | Required recovery procedure; this incident's incorrect registry attribution is explicitly recorded                                              |
| Preserve snapshots and exclusive offline ownership before filesystem repair | Applied to the registry and both Mimir claims; corrected and clean exit codes retained                                                          |
| Restore registry crash recovery                                             | Journal added and verified on the original claim; its original absence remains unexplained                                                      |
| Remove foreground Squid stale PID-file failure                              | Delivered/deployed in PR #15039; production config and pinned-container retained-directory SIGKILL proof passed                                 |
| Fix External Secrets startup OOM                                            | Delivered/deployed in PR #15040 with native canary proof                                                                                        |
| Restore existing Hermes policy test on two amd64 nodes                      | Delivered in PR #15041; native deny/allow proof passed                                                                                          |
| Constrain Sealed Secrets web to its executable's architecture               | Delivered/deployed in PR #15043 with HTTP 200; upstream defect remains open                                                                     |
| Clear obsolete Bayn object ownership and verify accounting                  | Native controls completed; exact accounting and unchanged financial-event counts verified; no capital grant created                             |
| Fix Bayn's concurrent cache reconnect ownership                             | PR #15047 merged and deployed through exact immutable Freight/commit; native reads passed on both hosts; both failed readiness windows retained |
| Complete the reviewed independent Ofz archive update                        | Deployed from retained source; original credentials and wrapping-key identity preserved; production acknowledgement verified                    |
| Make NUC canonical-host SSH use its working direct key                      | Scoped host patterns/exclusions and native UID/source readback verified                                                                         |
| Establish Altra's overlapping reboot cause                                  | Kernel boot confirmed; BMC last-cause result and stale clock recorded; actor and exact impact unresolved                                        |
| Quantify registry integrity and telemetry gaps                              | Open; current pulls and replica readiness do not prove historical completeness                                                                  |
| Close the incident after all application and service-level checks pass      | Still open: intermittent Bayn readiness, Home Stash active work, unmuted Ceph warnings/rebalancing, and separate cutover holds                  |

## Acceptance still required

- Establish sustained Bayn readiness without weakening the command, freshness or replica guards. Preserve the
  native-read successes and both readiness windows (19/20 and 16/20); their failures remain acceptance limits.
  Keep OBSERVE authority until a separately reviewed mandate exists.
- Verify session-specific market-data freshness. The native Kafka unavailable-partition recheck after the final Bayn rollout already passed with zero unavailable partitions.
- Let Ceph finish rebalancing and clear its remaining native warnings; zero degraded objects does not mean every PG is clean. Retain all original OSD identities.
- Confirm Home Stash's active Job completes normally and Argo returns to green between scheduled runs.
- Resolve the separately owned Cloudflare, Keycloak, and Tengri reconciliation holds through their intended release.
- Update this report with final application counts, runtime acceptance times, remaining data-integrity uncertainty,
  and the final disposition of each corrective action before declaring the incident closed.

## Recovery continuation through 16:04Z

The incident remains open. A new Argo inventory at `14:54Z` reported 89 of 91 Applications Synced/Healthy;
three of those still had their separately owned reconciliation holds, leaving 86 actively reconciled and green.
Home Stash's active importer and Rook-Ceph remained non-green. Bayn's current Argo health must also be distinguished
from the failed sustained-readiness checks below.

### Replica acknowledgement and the command budget

A controller failure labelled `market-data` was traced to its same-pass broker reconciliation read, not to a proven
independent Kafka feed failure. The observation fence rejected a cut after Valkey publication failed its replica
acknowledgement. Trace `b215ac54205133bacf4a973114d5410a` retained that exact cause after approximately 328 ms.
Valkey also logged delayed asynchronous AOF fsync operations on both hosts during recovery; those observations do
not isolate the cause of every acknowledgement delay.

[PR #15049](https://github.com/proompteng/lab/pull/15049) added one further acknowledgement wait without replaying
`SET`, retaining the existing one-second command deadline and mandatory positive replica acknowledgement.
Its native regression, all six local checks, required remote PostgreSQL/application gates and both image builds
passed; review completed without findings. It merged as `27bc084125b7833c071914f0fa3575f412c6bddd` at `14:06:39Z`.
Main publisher `38577604315` succeeded. Freight `69528cb9a03d2b68507601b69b894c21eac7bb09` selected immutable image
`sha256:5ae3522729588c71620f2838244386f34a65dee38511f3d60a8e1584d1f6f639`; promotion
`bayn.01m4xc1svychf054mdshg4ttym.69528cb` generated `bf50806e5c12779117754d9501184e0879a31b27` and succeeded
at `14:13:22Z`. Exact-image public and controller replicas ran on both Turin and Altra.

That change did not achieve sustained recovery. The new-source readiness window from approximately `14:21Z` to
`14:27Z` passed 17 of 24 samples. A separate read-only diagnostic using the deployed source's database fences,
content hashes, parent binding and age checks passed 74 of 80 full/compact attempts without retries; all six failed
attempts retained the unavailable-observation fence. This diagnostic used its own scoped connections and made no
financial mutation. The earlier built-in materialization command retries failed samples, so its final successful
sample count must not be interpreted as first-attempt reliability.

Trace `c31f14e5540fee52cbdbfdef78e5e64d` then established that the two-wait limit rejected publication after
633 ms, before the one-second command budget was exhausted. The failure chain is:

1. Public broker readiness failed because a fresh cut was not available through its durable observation fence.
2. The cut was not published because both acknowledgement waits returned zero.
3. Publication stopped before its existing deadline because the recovery implementation also imposed a fixed
   two-attempt limit.
4. Two independent stopping conditions had been encoded where the existing deadline should have been the single
   bound. The attempt count unnecessarily shortened the available budget.

[PR #15050](https://github.com/proompteng/lab/pull/15050) removes that attempt cap and uses 250 ms waits on the same
owned connection for the remaining command budget. It still issues `SET` once, requires positive acknowledgement,
and cancels at the unchanged one-second deadline. Native tests cover a third wait, permanent missing acknowledgement,
and a stalled retry. Review identified loss of the known replication cause at the deadline; the correction retains
that per-operation cause, and its new regressions failed before the correction and passed afterward. All 16 native
binding tests and all six local checks passed, including 2,951 tests with 394 skipped and zero failures.
The current-head remote gates then passed, including PostgreSQL integration and both architecture builds. The
resolved review finding was checked again before merge. Fresh native status from both public replicas proved exact
accounting, zero unresolved mutations and open orders, and unchanged `none`/`read-only`/`OBSERVE` authority.

PR #15050 merged as `c429484a83c09ec23c91b5d2c9f5c073912cbc75` at `15:42:54Z`. Main publisher `38591749045`
completed both platform images and their index. Freight `dd632fe5ab920653a165621a30b362471ee7032c` selected
`sha256:20aaefa46a6b5d784bd3fdb1f14286c4944d6a714e1cefb014c5f00de0a8187d`; promotion
`bayn.01m4xhhvy61rhp3995exgn5whw.dd632fe` generated `1bb31e1bd5551fb7590c6c023f441ba0be7743c8` and succeeded
at `15:50:13Z`. Argo completed the activation hook and ordinary rollout. Exact-image public and execution-controller
replicas ran on Turin and Altra with zero restarts at the recorded baseline.

This deployment still had an early publication failure. Trace `f201645ae4fb92a3228c12a5c10e6653` recorded
`bayn.valkey.put` failing at approximately 1,001 ms, with `Valkey replica did not acknowledge publication` retained
as its cause. Both public replicas recorded a cycle-runner degradation during that startup interval. This proves
the deadline and diagnostic correction ran in production; it does not prove the underlying latency resolved.
A new, explicitly bounded readiness window ran from `15:52:07Z` through `16:01:38Z`, without retrying failed
samples. All 40 sampled readiness checks passed over 9.5 minutes. Separate full/compact first-attempt reads
passed 80 of 80 attempts across the two hosts. These results are retained with their exact scope.

They did not establish sustained recovery. At `16:01:38.837Z`, immediately after the last sampled check, a
new publication failed. Trace `dfbc64d81ef78da63e72214325cffbc9` again recorded a 1,001 ms Valkey deadline
with the known missing-replica-acknowledgement cause. Both public replicas subsequently logged broker degradation
at `16:01:42Z` and `16:01:46Z`. Controller sequence 142,341 failed its same-pass reconciliation read. The
post-window status guard also failed; the first failed payload was not persisted, so the retained controller
trace and public health logs establish the specific fault. Subsequent native snapshots returned Ready with
exact accounting, zero unresolved mutations/open orders, and unchanged capital authority. All four new replicas
retained their original UIDs with zero restarts.

The concurrency and deadline corrections are deployed, but intermittent acknowledgement latency remains an open
recovery problem. Neither the successful sampled window nor the later Ready snapshots erase that failure. No
command/freshness limit, replication requirement, health rule, storage policy or capital gate was weakened.

### Model, telemetry and market-source readback

The independent research model returned HTTP 200 from the permitted research worker, the exact locked Alpha-R1
identity, the allowed synthetic identifier `mom_20`, complete stream termination and actual usage of 101 prompt plus
13 completion tokens. The request completed in approximately 227 ms. Admission and engine running/waiting gauges
returned to zero. Its trace `357f2e4b258c4589a0c9418defd2a851`, matching request log
`86cfa8c988e74dcd969cad949f9d0466`, and completed-request counter were read back from Tempo, Loki and Mimir.
Native GPU readback showed the expected Blackwell device and serving process. This model is independent of the
active Jev path; the smoke request is neither strategy qualification nor capital authority.

An authenticated read-only sample at `14:50Z` collected 200 committed records each from `torghut.quotes.v1` and
`bayn.market-data.crypto.v1`. The sampled AMD and BTC/USD payloads retained original source timestamps in that
same minute. No production consumer offsets were committed or reset. Administrative group lag was unavailable
because the two current groups had no committed offsets; that result is UNKNOWN, not zero. Bounded source samples
do not prove freshness for every asset required by a future decision.

Physical Turin retained boot ID `87a50b3a-79e0-4841-a9dc-dbde248e86a8`, Talos 1.14.0 and kernel 6.18.48, remained
schedulable, and reported no node pressure. Fresh fan readback showed 1120 RPM for the four case fans, 1400 RPM
for the CPU fan and 3780 RPM for the protected pump; CPU temperature was 39 C. The retained Ceph readback showed
all six original OSDs up/in, monitor quorum, zero degraded objects and 24 remapped PGs. Its two BlueStore warnings
remained unmuted. None of these observations closes the outstanding service acceptance or separately owned cutover.

### Fresh dependencies during the final observation window

An authenticated source recheck at `15:48Z` again read 200 committed stock records and 200 committed crypto
records. The last sampled AMD source timestamp was `15:48:11.216890326Z` and BTC/USD was
`15:48:33.140727620Z`. Neither production consumer offsets nor topic state were changed. These remain bounded
partition samples, rather than proof that every required trading asset is current.

Both original Flink job IDs remained `RUNNING`. The archive had 292 completed checkpoints and one retained
historical failure; technical analysis had 292 completed checkpoints and no failures at this readback. Native
checkpoint IDs had advanced to 47,435 and 117,389, respectively, with current completion timestamps.

Fresh Turin sensors reported four case fans at 1120 RPM, CPU fan 1400 RPM, protected pump 3780 RPM, CPU 40 C,
NIC 74 C and DIMM banks 62/59 C. Ceph retained all six OSDs up/in and all 601 PGs active, with no degraded PGs.
It still had 23 remapped PGs, approximately 544,000 misplaced objects and two unmuted BlueStore warnings.
The current importer completed more runs normally; a subsequent scheduled run was active. The three separate
identity/runtime cutover holds remained in place. Final all-application acceptance is still open.

The `16:00Z` application inventory still contained 91 Applications: 89 reported Synced/Healthy, with 86 actively
reconciled and green. The remaining active exceptions were Home Stash's running importer and Rook-Ceph. Cached
Healthy states on the paused Cloudflare, Keycloak and Tengri Applications still do not establish cutover acceptance.
Bayn's subsequent native publication failure also keeps its service-level acceptance open despite current Argo health.

The active Turin `EPHEMERAL` volume configuration was read again during this window. Its partition provisioning
retained `grow: false`, and the original XFS volume remained ready. The host retained the recovered boot ID and
reported Ready, schedulable and no node pressure. Future-boot acceptance remains unverified; no new reboot was
performed to manufacture that proof during trading-service recovery.
