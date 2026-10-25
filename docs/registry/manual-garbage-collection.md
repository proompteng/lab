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
It skips collection when the plan is empty. The controller's four-minute collection
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
A durable receipt records the selected tags and original blob file identities.

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

The Job verifies each receipt's inode, size and timestamp before deleting blobs,
and validates quarantined tag links before deleting their metadata.
Absent quarantined files are safe to skip on retry. A failed or interrupted purge
preserves the receipt and remaining files. Retry the same batch after inspecting
the saved output; do not delete live blobs or change the claim. A kernel lock
prevents overlapping purges. A one-hour process deadline and the registry Pod's
lifecycle bound the purge. The runner removes its temporary script; interrupted
receipts remain resumable after the Pod is replaced.

After deletion, audit protected references and blob sizes, pull a retained image,
and read filesystem free space. If the mount lacks `discard`, trim only this
claim's verified CSI global mount. Match the PV's CSI volume handle and ext4 RBD
device before `fstrim`; never trim an unrelated filesystem. Do the trim with
registry writes enabled. Report filesystem free-space change separately from
RBD trim output and physical Ceph capacity.

See [ApplicationSet maintenance holds](../../argocd/applicationsets/README.md#storage-maintenance-holds)
and [Distribution's GC requirements](https://distribution.github.io/distribution/about/garbage-collection/).
