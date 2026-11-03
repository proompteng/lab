# Registry cleanup

Use the existing `registry-data` claim in namespace `registry`. Cleanup has three
phases: prepare with uploads open, quarantine under a bounded read-only hold, then
physically delete quarantined files with uploads open. Preparation and purge use
the committed `registry-maintenance` container in the existing registry Pod.
Do not run Distribution's
full `--delete-untagged` scan under an unbounded maintenance window.

The former `prune-images.ts` CLI is removed. Its creation-date ordering, bare-hash
tag matcher and manifest-digest deletion are replaced by upload-time retention,
current build-tag recognition, explicit protections and tag removal.

## Daily cleanup

The GitOps-managed `registry-cleanup` CronJob runs at **03:23 America/Los_Angeles**
every day. `concurrencyPolicy: Forbid` prevents overlapping scheduled runs.
The Job has a two-hour deadline, no automatic retry, one retained successful run
and three retained failed runs. Inspect its status and logs in namespace `registry`.
The 24-hour starting deadline lets Kubernetes catch up the most recent missed run
after maintenance suspension or a controller interruption. Older missed runs are
skipped. This start deadline is separate from the two-hour execution deadline.

`scheduled.py` resumes receipted quarantine purges, prepares online, refreshes
protected references immediately before collection, then purges with uploads open.
It skips collection when the plan is empty. Online maintenance first uses the existing
five-minute singleton Deployment rollout contract, then requires exactly one
non-terminating Pod with every container ready. Missing container statuses, extra
Pods and an expired readiness deadline still fail closed; this is not a phase retry. The controller's four-minute collection
ceiling, helper deletion and upload-restoration checks also apply to scheduled runs.
Interrupted collections retain their receipt for the next run after writes are restored;
an unresolved maintenance hold requires operator recovery.

The Job has no registry PVC mount. Its service account can list only the image-owning
workload and release resources in `packages/scripts/src/registry/protected_resources.json`.
The ClusterRole has no wildcard resources, CRD discovery or write access. Namespaced
Roles permit registry Pod exec, collector Pod management and patching only the named
registry Deployment and the `argocd/registry` Application. It cannot read Kubernetes
Secrets or Valkey resources. Installing an unrelated CRD does not change cleanup access.
Before introducing a new private-image owner, add its resource to the protection
contract and the matching list-only RBAC rule. Tests require the rules to match.
Missing retained manifests or blobs also fail preparation before uploads are stopped.
Online preparation has a 45-minute execution budget. The Job retains its two-hour
deadline; seven minutes of termination grace covers helper deletion and the
five-minute restoration wait if it is interrupted during collection.
Resolve a stale reference at its owning resource rather than bypassing protection.

The manual phases below use the same committed implementation for recovery or
an explicitly requested cleanup outside the daily cadence.

## Prepare with uploads open

Roll out the reviewed registry Deployment through GitOps before using these commands.
The added maintenance container causes one singleton `Recreate` restart; wait for
all three containers to be Ready. Sync only the registry Application at the reviewed
commit. Preserve the claim during rollout and recovery. If a rollout fails, restore
the last reviewed Deployment through GitOps after the maintenance process exits;
quarantine receipts remain on the existing claim for retry.

Use Python 3.14 and an authenticated `kubectl`. Record the existing PVC UID/PV,
registry node and Application UID. Stop if another maintenance owner, node pin,
read-only override or Argo sync is active. Keep the existing claim.

Run preparation from the repository root:

```sh
python3 packages/scripts/src/registry/prepare.py \
  --context galactic-lan --plan /tmp/registry-plan.json \
  --references /tmp/registry-references.json
```

The runner snapshots the configured image owners across namespaces. This includes
built-in workloads, idle AgentProviders, workflow templates, scale-to-zero services,
image catalogs and retained Kargo artifacts even when they have no Pod or Job.
Every configured read is required; a denied or unavailable source aborts preparation
before collection. Raw cluster objects are not saved. Unrelated custom resources
are outside the protection contract and are never queried.

The maintenance container reads the existing claim through a read-only mount. The runner verifies
transferred input hashes, saves the plan locally and removes its temporary inputs.
It records the claim UID/PV in the plan. It never changes registry
files or disables uploads. Preparation fails on unsupported manifests or missing
retained content.

Keep at least five recent build tags per repository, all uploads from the last
seven days, unknown human tags, live workload references and retained Kargo
Freight, Stage history and promotions. Retain every platform and attestation
reachable from those roots. Recent untagged manifests also retain their layers.
The plan records file identities, upload timestamps, manifest bytes and candidate
sizes. Cached manifests are checked against their content digest before reuse.
Recent revision links whose manifest payload is already gone do not retain an
untagged image. Missing content referenced by retained tags, protected images or
retained image indexes still fails preparation before collection.

## Quarantine within four minutes

Refresh protection references immediately before collection, then run:

```sh
python3 packages/scripts/src/registry/protected_references.py \
  --context galactic-lan --output /tmp/registry-references.json
python3 packages/scripts/src/registry/collect.py \
  --context galactic-lan --plan /tmp/registry-plan.json \
  --references /tmp/registry-references.json --seconds 240 --max-blobs 2000
```

The controller creates an owned helper on the current registry node and verifies
input hashes. It acquires the Application hold with UID/resourceVersion checks,
pins the registry to that node and sets the complete override
`REGISTRY_STORAGE_MAINTENANCE_READONLY={"enabled":true}`. The bootstrap
ApplicationSet must preserve the hold and owner annotations.

Collection requires `GET /v2/` = 200 and upload initiation = 405. It rereads current
tags, recent manifests and fresh protections, recomputes retention, validates the
complete retained graph and rejects changed candidates. A prepared tag remains
eligible only if five newer build tags still exist. Human tags and recent uploads
cannot be selected by editing the plan.

Eligible tag directories and verified orphan blobs move atomically into
`docker/registry/v2/_gc_quarantine/<batch>/<digest-prefix>/<digest>` on the same
claim; tag metadata uses `tags/<hash-of-repository-and-tag>` inside that batch.
A durable version 3 receipt binds the batch name and directory inode to the prepared
PVC UID/PV. It records original blob signatures and an inventory of every quarantined
tag metadata file (signature and SHA-256) and directory inode before any rename.
Preparation and collection retain their full device/inode/size/mtime checks.

Renaming keeps the allocated blocks intact. Neither blob payloads nor tag metadata
are physically deleted while uploads are disabled. Empty CAS directories and historical
revision/layer links can remain; they do not retain the removed blob payloads.

The collection deadline includes read-only rollout and frozen validation. On
completion, failure or timeout, the controller deletes its helper and confirms
deletion **before** restoring uploads and removing its owned Argo hold. Deployment
restoration has a separate five-minute readiness timeout. If helper deletion cannot be
confirmed, it leaves writes disabled and the hold intact. Never infer process
exit from an exec disconnect. A timeout can leave a partial quarantine batch;
its receipt remains valid for online deletion. After a collector deadline, the
controller first confirms helper deletion and complete upload restoration, then
checks its own durable receipt. A valid receipt permits online purge of the partial
batch with `collectionTimedOut: true` in the completion log. A missing or invalid
receipt still fails the run; failed validation never authorizes deletion.

The result records the quarantine identifier and moved bytes. The controller
checks the PVC UID/PV is unchanged. Verify a completed push and a full retained-image
pull after restoration. Source changes to the upload budget require their separate
shared-storage qualification.

## Reclaim blocks online

After uploads are restored, use the identifier from collection:

```sh
python3 packages/scripts/src/registry/purge.py \
  --context galactic-lan --quarantine-id registry-collect-<identifier> \
  --output /tmp/registry-purge.log
```

This runs eight deletion workers in `registry-maintenance`. Its only writable
claim mount exposes `docker/registry/v2/_gc_quarantine` at `/quarantine`; the live
CAS mount is read-only. The Pod has no service-account token and the container has
no added capabilities. Preparation and purge do not create another RWO attachment,
so a registry restart cannot leave the claim held by a separate maintenance Pod.
Reuploading the same digest
creates a new live file; deleting the quarantined inode cannot remove it.

The runner reads the Bound claim's UID/PV and passes them to the quarantine-only
process. Purge requires those identities to match the receipt, along with its batch
name and directory inode. Only in this persisted quarantine phase does comparison
ignore `st_dev`: Linux device numbers can change across volume remounts. Inode,
size, nanosecond mtime and SHA-256 content must still match. Blob content is checked
against its CAS digest; tag files against the frozen inventory. Symlinked paths,
new metadata, changed files, invalid receipts and the wrong claim/PV fail closed.
The live CAS stays read-only to the purge container.

Absent receipted files are safe to skip on retry, including an interrupted tag
metadata deletion that already removed `current/link`. Remaining files and directory
inodes must still match; a missing link is not authority to recursively delete a tag.
A failed or interrupted purge preserves the receipt and remaining files. Finalization
atomically renames an emptied batch to `.purged-<batch>` before removing its receipt;
the scheduler also resumes these receipt-only or empty finalizers. Unexpected contents
are never recursively deleted. No reclamation is credited for files absent on retry.

Failed purge logs include phase, exit status (or timeout), and the final 8 KiB of
stderr in the CronJob log, not only the ephemeral `/work` log. Script cleanup failure
on a replaced Pod does not mask the original purge error. Do not delete live blobs
or change the claim. A kernel lock
prevents overlapping purges. A one-hour process deadline and the registry Pod's
lifecycle bound the purge. The runner removes its temporary script; interrupted
receipts remain resumable after the Pod is replaced.

### Version 2 recovery gate

Version 2 is not accepted for deletion by the version 3 implementation. It did not
persist a PVC UID/PV, batch directory inode or complete tag metadata inventory.
Those facts cannot safely be invented by copying current metadata into a receipt.
There is no parallel legacy purge path or automatic receipt upgrade.

Batch `registry-collect-071cdc9382ed` remains behind this gate. The 2026-11-02
scheduled run reported 2,000 quarantined blobs and 596 tags before purge failed.
The supplied readback found unchanged inode/size/mtime but changed device numbers
on five blobs. Version 2 compares device numbers for tags first, then blobs; an
isolated remount regression reproduces `Quarantined tag changed`. The original
remote stderr was only in the terminated Job's emptyDir, so the exact first live
file/error cannot be recovered from its available stdout. No live bytes have been
reclaimed by this repair, and the original receipt must remain intact.

If collection-time provenance is unavailable, do not manufacture a version 3 receipt.
An explicitly authorized recovery can restore the data first, then let the current
retention protocol create a new collection-time receipt. Use the reviewed recovery
tool from the repository root:

```sh
python3 packages/scripts/src/registry/recover.py \
  --context galactic-tailscale --batch registry-collect-071cdc9382ed \
  --plan /tmp/registry-restore.json
python3 packages/scripts/src/registry/recover.py \
  --context galactic-tailscale --plan /tmp/registry-restore.json --apply
```

The first command is read-only. It verifies every remaining blob's original
inode/size/mtime and full content digest, the recorded tag links and supported tag
metadata. It binds the restoration plan to the current Bound claim/PV, batch inode
and original receipt hash. This authorizes restoration only, never deletion.

Apply shares the existing four-minute maintenance hold, helper and write-restoration
protocol. It rechecks the complete plan before moving data, restores missing CAS
entries with durable hard links, and restores tag directories without replacing
current tags. Existing destinations stay intact; old conflicting copies are retained
under `.restored-<batch>`. The original receipt, recovery plan and emptied batch are
also archived there. No legacy receipt becomes valid purge input. Audit reports must
distinguish restored data, archived conflicts and bytes later reclaimed by normal GC.

Preparation occurs with uploads open; apply causes the existing singleton read-only
and write-enabled rollouts. Keep its plan for retry. After interruption, helper
deletion is confirmed before uploads reopen; rerun the same plan to resume verified
remaining moves. Changed files, missing data, new destinations, unexpected files,
symlinks or a different claim stop recovery. Never discard or rebaseline the evidence.
After restoration, run the existing scheduled cleanup protocol and verify its actual
prepare/collect/purge results. The archive remains evidence, outside automatic purge.

The source repair is a generated ConfigMap change delivered by the registry
Application's existing GitOps path; it changes no images, PVC, RBAC, retention,
worker counts or timeouts. Verify the CronJob's new `registry-cleanup-scripts-*`
reference after reconciliation. Rollback is the reviewed source revert through
GitOps; preserve every receipt and stop rather than trying to consume a newer
receipt with older code. A successful run of the **scheduled cleanup protocol**, with resume-purge,
prepare/collect and completion results as applicable, is the live reclamation gate.
Serving readiness alone is not that proof. If the next schedule or required
inspection is unavailable, report it. An explicitly authorized recovery may retry the
existing CronJob template outside its cadence after confirming no other run is active.

After deletion, audit protected references and blob sizes, pull a retained image,
and read filesystem free space. If the mount lacks `discard`, trim only this
claim's verified CSI global mount. Match the PV's CSI volume handle and ext4 RBD
device before `fstrim`; never trim an unrelated filesystem. Do the trim with
registry writes enabled. Report filesystem free-space change separately from
RBD trim output and physical Ceph capacity.

See [ApplicationSet maintenance holds](../../argocd/applicationsets/README.md#storage-maintenance-holds)
and [Distribution's GC requirements](https://distribution.github.io/distribution/about/garbage-collection/).
