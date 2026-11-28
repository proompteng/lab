# Agent Shell workspace migration to Ceph

Status: Storage staging only. The independent `agents-workspace` Application owns
the new claim; copying and attaching it to Agent Shell remain gated below.

## Scope and evidence

The staged claim is `agents/agents-shell-workspace-ceph-20261112`: 256Gi,
`ReadWriteOnce`, `rook-ceph-block`. Its manifest is included by the independent
[workspace Kustomization](../../argocd/applications/agents-workspace/kustomization.yaml).
Staging does not change the Deployment, image, `/workspace` emptyDir, bootstrap,
existing `agents-shell-workspace` claim, or any active session.

On 2026-11-12, kubelet accounting measured 39.28GiB and 2.74 million inodes in the
workspace, plus 5.37GiB in the container writable layer. The old 20Gi claim cannot
hold that workspace. The 256Gi target leaves room for the verified copy, recovery
material and subsequent work; remeasure capacity and free inodes before copying.
Agent Shell's local dependency installs coincided with system-disk pressure and
etcd WAL stalls. Moving this workspace addresses that measured disposable writer;
it does not establish cluster or ten-runner throughput qualification.

## Separate storage ownership

Putting a staging PVC in the existing Agents directory would not be harmless. The
`agents-build-push.yml` workflow includes `argocd/applications/agents/**`, so this
PVC and an Agents Kustomization change would build all four Agents images. The Agents
Warehouse binds those images to the selected Git commit, and the automatic
`agents-release/agents` Stage updates all image pins, including Agent Shell.
That indirect rollout would replace the active emptyDir Pod.

The root Application instead owns the declarative
[`agents-workspace` Application](../../argocd/applicationsets/agents-workspace.yaml),
following its existing standalone Application convention. This new owner tracks
`main`, uses the default Project and manual sync, and renders exactly the protected
PVC. It has no Namespace creation or management options and renders no Namespace
or workload. Existing Agents manifests, image triggers, Warehouse/Stage contracts
and the old PVC's ownership remain unchanged.

The six staging paths were checked against all current main push workflows and
the pull-request classifier: only hosted Argo lint, Kubernetes schema and script
validation apply; no native/image workflow matches. Recheck that routing if the
change set or workflow definitions change. Do not add workflow exclusions, weaken
Freight/source matching or pause unrelated delivery. The existing Agents
Application still accepts only its Stage-generated Kargo revision; a scoped sync
of arbitrary `main` is not a config-only route for that Application.

## Stage without replacing the source Pod

1. After review and CI, merge the six staging paths through the normal
   [GitOps delivery path](../release-automation.md). Verify the exact committed
   revision and rendered diff: the root adds only the `agents-workspace`
   Application, its child renders only the new PVC, and the existing Agents render
   is unchanged. Use a standard scoped root sync for that Application if required,
   then manually sync `agents-workspace` at the reviewed revision with pruning
   disabled. No Namespace or workload may be created or changed by these syncs.
2. Confirm the new claim is Bound to `rook-ceph-block`, has 256Gi capacity and the
   expected access mode. Keep its `Prune=false,Delete=false` protection. Do not
   attach it to the running Deployment or delete/reuse the old 20Gi claim.
3. Record source Pod UID, image digest, owner, current Application/Stage revisions
   and target PVC/PV identities. Check Ceph capacity/quorum and all etcd members.
   Staging is complete at this boundary; copying and cutover need the gates below.

## Coordinate owners and retain evidence

The service has no global graceful-drain protocol. SIGTERM invokes `shutdown()`,
which kills running commands. [Activity retention](agents-shell-activity.md)
documents that process restart also clears in-memory completion receipts,
idempotency keys and output buffers. The 30-second Pod grace period is not a job
drain guarantee.

- Obtain a coordinated hold on new commands, installs, session creation and Git
  operations from every active owner. Let their commands finish naturally. Do not
  cancel jobs, close sessions, remove worktrees or alter another owner's files.
  Confirm both shell jobs and shorter native operations have finished, and repeat
  that check immediately before the final copy and cutover. If any owner cannot
  drain, leave the source Pod running and defer cutover.
- Each owner exports needed receipts, command outcomes and retained output to an
  approved durable destination before restart. Record any retention gap; do not
  treat an audit receipt as proof that all output reached Loki. Do not replay
  side-effecting commands merely because an old request key is absent after restart.
- Inventory session IDs and their owner bindings, branch/ref/object IDs, dirty and
  untracked file manifests, and linked-worktree paths without printing credentials
  or inspecting other owners' file contents. Preserve unpublished Git objects as
  well as pushed branches. Owners verify their own inventories.
- Inventory required temporary output separately. `/tmp`, tool caches and other
  writable-layer state are outside `/workspace`; preserve needed outputs and
  executable/toolchain dependencies before losing the old Pod. Do not copy mounted
  ServiceAccount or secret volumes into the workspace. Review future scratch/cache
  routing separately; this claim alone does not move container-root writes.

## Copy and verify before cutover

Use a separately reviewed, authenticated copy transport into an isolated helper
that mounts only the new PVC. Preserve existing identities and permissions; do not
add hostPath access, privileged Pods or host mounts. No helper or copy is installed
by the staging change. Verify the target is the new, unused claim before writing.

Copy the complete, quiescent `/workspace` tree. Preserve numeric ownership, modes,
timestamps, symlinks, hard links, sparse files and relevant ACLs/xattrs; a partial
copy or unsupported attribute is a failed gate. Keep the same absolute paths,
including `/workspace/lab/.git`, `/workspace/worktrees/lab` and
`/workspace/.agents-shell` (session metadata and home). Do not relocate the shared
Git directory or omit dependency trees merely because they can be downloaded.

Use one copy worker and an initial aggregate transfer cap of 10MiB/s. This is an
operational starting limit, not a proven safe throughput. Bound checksum/verification
reads separately; a network bandwidth flag does not bound all source disk I/O.
Observe source disk reads/writes/queueing, API latency, all-member WAL warnings and
Ceph latency/quorum throughout. Stop only the migration worker if new >1s WAL
stalls, sustained API degradation, quorum loss or critical Ceph read latency recur.
Keep the source unchanged and resume only after reviewing the cause and rate.

Before any Pod replacement, require all of the following:

- Complete copy with zero errors; matching file counts, sizes, content hashes and
  required metadata/link relationships against the quiescent source. Recheck that
  no source mutations occurred. Partial or live-copy output is not a cutover image.
- Matching Git refs/object IDs and connectivity, linked-worktree `.git` pointers,
  dirty/untracked inventories, and persisted session owner/path records. Validate
  every owner's unpublished work against that owner's recorded manifest.
- Enough free bytes and inodes on the target, and UID/GID 1000 access with existing
  permission boundaries intact. Do not broaden access to make verification pass.
- A second verified recovery copy or supported snapshot of the populated claim,
  plus separately preserved temporary output and receipts. Record and verify its
  restore procedure before discarding the source emptyDir. An untested copy and
  the unrelated old 20Gi claim are not rollback evidence.

## Later, separately reviewed cutover

The cutover change uses the existing chart settings:

```yaml
agentsShell:
  workspace:
    volumeMode: persistentVolumeClaim
    existingClaim: agents-shell-workspace-ceph-20261112
    bootstrap:
      enabled: false
```

This block is a later change, not part of staging. Preserve runtime functionality,
toolchain, UID/GID, security, placement, probes and service routing. Editing the
Agents values triggers the normal four-image delivery cohort and can automatically
replace the Pod after Kargo promotion. Complete the owner hold, verified copy,
recovery proof and review of that automatic rollout boundary **before merging the
cutover**, not merely before a later manual sync. Require the normal successful
immutable image cohort, selected Freight and Stage-generated Kargo revision;
review the exact image digests and resulting live diff. Do not manually retain an
old image pin or sync the Agents Application to arbitrary `main` to bypass that
delivery contract.

Rendering with `existingClaim`
suppresses the chart-created old PVC, so explicitly retain/protect that old claim
in the reviewed cutover rather than allowing it to be pruned. Disable bootstrap
because its dirty-check fallback can move the shared checkout and reclone it,
invalidating the linked-worktree layout that was preserved.

Reconfirm the owner hold, zero active operations, copy/backup proofs and exact live
diff, then perform the normal reviewed Argo reconciliation. Recreate destroys the
old emptyDir; there is no rollback to its bytes afterward. Keep new admissions
held until the replacement serves the same auth identities, session IDs, paths,
Git refs and owner-verified dirty/untracked files from the intended RBD filesystem.
Verify normal command/output capture and source-disk/Ceph behavior before reopening
work. Do not claim receipt/idempotency continuity across the process restart.

If acceptance fails, keep admissions held and preserve both target and recovery
material. Recover the service using the verified Ceph data or its tested restore
path at `/workspace`, with bootstrap disabled. Do not revert to an emptyDir or
silently clone a new repository. Do not delete either claim, the recovery copy or
retained outputs until every owner has accepted recovery and cleanup is authorized.
