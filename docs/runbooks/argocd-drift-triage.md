# Argo CD drift triage

Use this read-only audit to distinguish retained resources (such as upgrade backups and PVCs) from drift that needs
investigation. An Application can be `Healthy` and still be `OutOfSync`. Do not sync, prune, remove tracking, or
change auto-sync just to clear a status.

## Run the audit

From the repository root with Bun installed, verify that `kubectl config current-context` is the intended Galactic
context. See [Galactic Kubernetes Access](galactic-kubernetes-access.md) if access is denied.

```bash
bun run packages/scripts/src/galactic/audit-argocd-drift.ts --format markdown
bun run packages/scripts/src/galactic/audit-argocd-drift.ts --format json
```

Live mode lists Applications in `argocd`. For in-cluster Applications that are `OutOfSync` and `Healthy`, it makes
one named `get` per distinct live-only prune candidate. It never requests Secret objects or reads from another
destination cluster. It does not invoke Argo or Kargo operations or change Kubernetes objects. It needs Application
list access and get access to the candidate resource kinds. A failed Application list fails the command; a failed
candidate lookup is reported as `metadata_unavailable`, not confirmed retention.

For offline triage, pass a file containing the JSON shape returned by `kubectl -n argocd get applications -o json`.
Store captures in a private directory: the raw Application objects can contain sensitive configuration.

```bash
bun run packages/scripts/src/galactic/audit-argocd-drift.ts --fixture applications.json --format json
```

Fixture mode never calls `kubectl`. An Application list alone cannot prove retention. To replay verified retention,
add a top-level `liveResources` array alongside `items`, containing only `apiVersion`, `kind`, and `metadata`
(`name`, `namespace` for namespaced objects, and the tracking and sync/compare options annotations). Each entry must
describe the corresponding live object from the same cluster as the snapshot. Do not include full resource bodies.
For example, a minimal entry for a PVC that Argo lists under `status.resources` might be:

```json
{
  "apiVersion": "v1",
  "kind": "PersistentVolumeClaim",
  "metadata": {
    "name": "backup-pvc",
    "namespace": "forgejo",
    "annotations": {
      "argocd.argoproj.io/tracking-id": "forgejo:/PersistentVolumeClaim:forgejo/backup-pvc",
      "argocd.argoproj.io/sync-options": "Prune=false,Delete=false"
    }
  }
}
```

The report is sorted by Application and resource identity, with no timestamps. It includes Kubernetes identifiers,
status codes, Kargo tracking results, and fixed recommendations, not raw resource bodies, annotation values, repository
URLs, or error messages from Kubernetes. JSON returns an `applications` array with a `finding` for each Application
that is not both `Synced` and `Healthy`. Markdown (the default) counts those same Applications, not the number of
affected resources. Exit status 0 means the report was produced, not that the cluster is clean.

## Interpret the finding

| Classification                | Evidence and next step                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retained_prune_false_orphan` | The Application is healthy, and all reported resource differences are live-only prune candidates with a self-referencing tracking ID for this Application and resource-level `Prune=false`. Leave them in place. Review backup integrity, retention, and ownership before proposing any tracking change.                                                 |
| `kargo_promotion_pending`     | An Application on verified Stage branch tracking is comparing a different Git commit from its last recorded deployment on the same source configuration. Check the exact Stage, Freight, and generated branch under [release automation](../release-automation.md#evidence). This signal does not prove that a Kargo promotion is queued or in progress. |
| `manual_autosync_disabled`    | The Application is healthy but out of sync and has no automated policy, or explicitly sets `automated.enabled: false`. Check whether manual sync is intentional and review the desired/live diff; autosync being off does not make drift benign.                                                                                                         |
| `rollout_progressing`         | Argo reports progressing health or a running sync. Check the operation and the workload against the expected revision; investigate stalled progress.                                                                                                                                                                                                     |
| `degraded_workload`           | Health, comparison, or configuration needs investigation, or drift was not explained by the other classes. This can include an Application whose workloads are still `Healthy`. Inspect Argo conditions, workload health, and the desired/live diff before considering any remediation.                                                                  |

Health and comparison errors take precedence over a seemingly benign diff. Mixed retained and desired-state differences
are not classified as retained-only. Argo's `requiresPruning` supplies evidence that the resource is live but no longer
desired; neither a backup-like name nor `Delete=false` proves `Prune=false`. A resource with `IgnoreExtraneous` does
not explain the Application's `OutOfSync` status by itself. This audit does not discover objects outside Argo's
reported resource differences, and a live list and subsequent resource reads are not atomic. Recheck the relevant
evidence if an Application is reconciling.

## Read Kargo revision tracking

Static GitOps Applications have no Kargo authorization or Kargo branch. The auditor checks the active
`spec.source` or `spec.sources` for Kargo Applications, including healthy ones:

- `verified`: At least one Git source tracks `kargo/<stage>`, and every Kargo-prefixed target exactly matches a
  Stage authorized in `kargo.akuity.io/authorized-stage`. Unrelated static sources can use their own revisions.
- `mismatch`: The authorization is readable but the configured branch does not satisfy that contract.
- `unverifiable`: A Kargo branch has no valid authorization, or the authorization value is malformed.

For the pending-promotion finding, the auditor checks that Argo compared the current sources (including renderer
settings), that the latest deployment history entry uses those same sources, and that only the authorized branch
revisions differ. Missing history is not evidence of a pending promotion. Use Kargo's promotion records for rollout
decisions; do not hand-edit the generated branch or override the live Application revision.

References: [Argo CD tracking IDs](https://argo-cd.readthedocs.io/en/stable/user-guide/resource_tracking/),
[prune and retention behavior](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/#no-prune-resources),
and [Kargo Stage authorization](https://docs.kargo.io/user-guide/reference-docs/promotion-steps/argocd-update).
