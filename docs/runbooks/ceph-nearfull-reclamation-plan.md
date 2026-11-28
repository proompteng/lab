# Galactic Ceph nearfull reclamation plan

Use this read-only planner during `OSD_NEARFULL` to find detached restore/rehearsal PVCs and potentially obsolete upgrade
or restore checkpoints. It ranks evidence for an approval request; it cannot establish that a backup is obsolete or that
any object is safe to remove. It never deletes, patches, or creates anything.

## Run the planner

From the repository root with Bun dependencies installed, confirm the Galactic identity and use an explicit context:

```sh
kubectl config get-contexts galactic-lan
kubectl --context galactic-lan -n rook-ceph auth whoami
bun run packages/scripts/src/galactic/plan-ceph-storage-reclamation.ts --context galactic-lan --format markdown
```

Use `--format json` to compare plans or feed the result into a report. Markdown is the default. Live mode requires
cluster-wide list access to the inventory below, `get` on the `rook-ceph-tools` deployment, and `pods/exec` access in
`rook-ceph`. It runs only Ceph reporting commands in the toolbox. An unavailable list, malformed input, or paginated
fragment stops the plan instead of being treated as an empty inventory. A live capture spans several reads; it is not
an atomic cluster snapshot.

## Interpret the report

| Section                    | Meaning                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Zero-risk                  | Read-only verification only. There is not enough evidence to shortlist the object; no credit.       |
| Approval required          | Ranked by reported logical size. Investigate retirement, dependencies, and ownership first.         |
| Protected                  | Excluded from reclamation and from all capacity savings.                                            |
| Pool raw / OSD utilization | Current usage versus the illustrative approval-required scenario, with a strict OSD target of <75%. |

- A PVC must be a restore/rehearsal artifact at least 14 days old, with GitOps retention metadata or a clone/restore
  source. The planner checks nonterminal Pods, Deployment and StatefulSet templates (including scaled-down workloads
  and StatefulSet claim ordinals), clone references, and snapshots. An idle claim without credible provenance remains
  read-only. Bayn storage/evidence and CloudNativePG-managed storage are always excluded.
- A snapshot must be at least 14 days old and carry one-off checkpoint naming or metadata and both GitOps retention
  flags (`Prune=false,Delete=false`). Scheduler/backup markers, owner references, and CNPG metadata take precedence.
  A PVC or claim template referencing the snapshot (including a cross-namespace restore) blocks it, even if detached.
  Reassess the checkpoint after any separately approved retirement of dependent restores.
- Only a uniquely bound Galactic RBD PV with a `Delete` reclaim policy, or a ready RBD snapshot with matching
  `Delete` content and a verified source PV, can enter the modeled scenario. Retained, pre-provisioned, unbound, or
  otherwise unverifiable backing gets no credit. The Kubernetes
  [snapshot deletion policy](https://kubernetes.io/docs/concepts/storage/volume-snapshots/#delete) applies to the
  bound content, not to the current snapshot class.
- Requested/provisioned capacity and snapshot restore size are **not** allocated or exclusive bytes. The hypothetical
  scenario uses reported PVC capacity or snapshot restore size times the live replica count, counts only the largest
  eligible entry per source image, and caps the sum at the pool's observed raw usage. Without any removal the expected
  savings are zero. Even with approval and removal, actual savings may be zero: sparse images, shared clone/snapshot
  extents, and asynchronous [Ceph snaptrim](https://docs.ceph.com/en/latest/rbd/rbd-snapshot/#delete-a-snapshot)
  affect the result.
- OSD percentages spread each pool's hypothetical raw savings in proportion to capacity among its up/in OSDs under a
  resolvable replicated CRUSH root. This is not PG placement or a promise of relief on a specific OSD. Unsupported
  placement, missing stats, or an inconsistent modeled distribution withhold the OSD forecast. An OSD reported under
  75% in the scenario still needs live verification.

## Replay captured evidence

```sh
bun run packages/scripts/src/galactic/plan-ceph-storage-reclamation.ts --fixture ceph-inventory.json --format json
```

`--fixture` is mutually exclusive with `--context`. It makes no cluster calls. Supply one JSON object with an ISO UTC
`asOf` capture timestamp and the raw JSON fields below. Use unfiltered lists; leave an observed empty list as
`{"items":[]}` and never substitute it for a failed read. Raw workload JSON can contain sensitive configuration; use
sanitized fixtures, keep them out of Git, and do not attach them to approval tickets.

| JSON keys                                                  | Evidence                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pvcs`, `pods`, `deployments`, `statefulSets`, `snapshots` | Full all-namespace lists of each resource (`kubectl get … -A -o json`)                         |
| `pvs`, `snapshotContents`                                  | Full cluster-scoped PersistentVolume and VolumeSnapshotContent lists                           |
| `cephDf`, `cephOsdDf`, `cephPools`, `cephCrushRules`       | JSON from `ceph df`, `ceph osd df tree`, `ceph osd pool ls detail`, `ceph osd crush rule dump` |

## Before requesting removal approval

1. Refresh the plan. For each exact namespace/name, verify the workload owner, live and desired consumers (including
   scheduled Jobs or custom controllers), GitOps retention, dependent restores/clones, and rollback/backup requirements.
2. Ask the storage owner to verify backing image usage and exclusive extents where available. Keep the report's
   modeled savings separate from measured savings when stating whether an OSD could reach the target.
3. Route any proposed removal and the exact list of resources through the normal destructive-change approval process.
   This planner is not the execution path. After separately authorized work, reread Ceph stats after any trimming
   and recheck the nearfull OSD rather than assuming the model was accurate.
