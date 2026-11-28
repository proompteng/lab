# Wave 19K: codebase and cluster pruning audit

Audited `main` at `aa0a2d91f1f20dca27e59634655311676f26d102`. The live Galactic root Application reported
the same revision during read-only inventory on 2026-11-28 UTC.
This change removes repository files only. It does not modify live resources, registry artifacts, release configuration,
or any protected workflow or application path.

## Deleted files

For each candidate, ran whole-checkout `rg --hidden --no-ignore --text -ilF` searches for its path, filename, and
distinctive stem, excluding the candidate itself, `.git/`, installed dependencies, and the tool cache. This included
`.github/`, `argocd/`, `docs/`, `packages/`, `services/`, `apps/`, `nix/`, `scripts/`, and `charts/`, as well as root
workspace and build configuration. Inspected basename collisions, relative references, and CI discovery rules rather
than treating a filename match (or the lack of one) as conclusive.

| Removed file                                                                      | Evidence of no live caller                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-ecran.sh`                                                          | Only inbound match: the cleanup TODO. The build context and `services/ecran/Dockerfile` are absent.                                                                                                                        |
| `scripts/build-ecran-worker.sh`                                                   | Only the TODO; `services/ecran/Dockerfile.worker` is absent.                                                                                                                                                               |
| `scripts/build-ecran-migrator.sh`                                                 | Only the TODO; `services/ecran/Dockerfile.migrator` is absent.                                                                                                                                                             |
| `scripts/build-juge.sh`                                                           | Only the TODO; both `services/juge/Dockerfile` and `services/juge/app` are absent.                                                                                                                                         |
| `scripts/build-riposte.sh`                                                        | Only the TODO; `services/riposte` is absent. The old Ingress hostname is not a builder consumer.                                                                                                                           |
| `scripts/build-docs.sh`                                                           | No path or filename match. Stem matches are Nix CI job IDs, including those in tests and the observability catalog. The [image build](../../nix/images/docs.nix) and `kargo/docs` delivery are unchanged.                  |
| `scripts/build-proompteng.sh`                                                     | No path or filename match. Stem matches are Nix CI job IDs. The [Landing image build](../../nix/images/proompteng.nix) and coordinated Ofz/Tengri/Proompteng release are unchanged.                                        |
| `scripts/build-vecteur.ts`                                                        | No inbound matches. The [manual CI publisher](../../.github/workflows/vecteur-manual-build-push.yaml) already builds the same Dockerfile and publishes the default `18-trixie` image. The image source and publisher stay. |
| `scripts/deploy-dernier.ts`                                                       | No inbound matches. The old build-and-`kn service update` script bypassed GitOps; the [Dernier image workflow](../../.github/workflows/dernier-build-push.yaml) is independent, and the ApplicationSet entry is disabled.  |
| `scripts/index.html`                                                              | No script-directory path references. Bare `index.html` hits belong to other app entry points, generated game exports, or web server routes.                                                                                |
| `scripts/copy_key.sh`                                                             | No inbound path or filename match. The stem in Ofz migration code is a Python symbol, not an invocation.                                                                                                                   |
| `scripts/remote_hosts.txt`                                                        | Only read by its removed sibling `copy_key.sh`; no other inventory or tool points to it.                                                                                                                                   |
| `packages/.gitkeep`                                                               | No full path match. Bare-name hits belong to Discourse and Bumba, not this empty marker. `packages/` has tracked contents and is not dropped by Git.                                                                       |
| `argocd/applications/longhorn/kustomization.yaml`                                 | No inbound render, ApplicationSet, root Application, Kargo, test, or live Application reference. General Longhorn hits are old incidents or the separate Harvester stack.                                                  |
| `argocd/applications/longhorn/longhorn-values.yaml`                               | Only the removed overlay and an incident note point to it. The note now points to the values in Git history.                                                                                                               |
| `argocd/applications/longhorn/patches/longhorn-csi-plugin-tolerations.patch.yaml` | Only the removed overlay renders this patch.                                                                                                                                                                               |

The root Application reads [`argocd/applicationsets/`](../../argocd/applicationsets/README.md), not all directories under
`argocd/applications/`. No live Argo Application source (including multi-source paths) points to the removed Longhorn
overlay. Galactic has no `longhorn-system` namespace, Longhorn StorageClass, or Longhorn PV. The separate
[`tofu/harvester/`](../../tofu/harvester) stack is unchanged and was not certified for retirement.

There is no live `ecran`, `juge`, or `riposte` namespace or Application. A separate read of 697 Pods and 510
Deployment, StatefulSet, DaemonSet, Job, and CronJob objects, including init containers, found zero image references
to the five former builder image repositories. The [cleanup TODO](../repository-cleanup-todo.md#broken-image-builders)
was the only repository reference to those builder files. Registry artifacts and any off-cluster readers are not part of
this deletion.

## Retained contracts

- **Upgrade acceptance:** [ClickHouse](../../argocd/applications/clickhouse-upgrade-acceptance) is referenced by the
  [upgrade runbook](../runbooks/clickhouse-final-stable-upgrades.md) and CI maps.
  [Postgres](../../argocd/applications/postgres-upgrade-acceptance) is an input to
  [the upgrade gate test](../../scripts/cluster-upgrades/postgres_upgrade_gate_test.py) and CI maps.
  [Storage](../../argocd/applications/storage-upgrade-acceptance) is read by
  [the Rook upgrade contract test](../../packages/scripts/src/shared/__tests__/rook-upgrade-contract.test.ts).
  These directories are not orphaned just because they have no ApplicationSet entry.
- **Symphony base:** [`symphony-base`](../../argocd/applications/symphony-base) is used by overlays, CI, and the Kargo
  source contract; it is not a standalone Application.
- **Script directories:** [`scripts/autotrader/`](../../scripts/autotrader) has internal imports and runnable Python
  tests even after scheduled deployment removal; manual/replay retirement still needs owner confirmation.
  [`scripts/hermes/`](../../scripts/hermes) has CI routing, tests, and an active
  [production rollout runbook](../runbooks/hermes-production-rollout.md).
- **Retained builders and workspaces:** Alchimie and Reviseur still have build sources and image consumers in retained
  GitOps definitions. Miel and Kitty Krew have documented builder callers. No whole `apps/`, `services/`, or
  `packages/` component met the deletion bar.

## Owner sign-off candidates

These are proposals for separate PRs, not authorization to retire a workload. Counts are total Pod objects with phase
breakdown. CPU/memory requests are the sums for running application containers, not node usage; usage is a
point-in-time `kubectl top pod` sample. PVC capacity is provisioned capacity, not measured disk usage.

| Candidate and exact desired-state owner                                                                                                                                                         | Namespace         |                       Pods | CPU / RAM request; sampled usage        | Bound PVC capacity              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------: | --------------------------------------- | ------------------------------- |
| **Codex devbox** — [platform](../../argocd/applicationsets/platform.yaml) `devbox`, [overlay](../../argocd/applications/devbox), `devbox-release:devbox`                                        | `codex-devbox`    |                  1 Running | 8 cores / 64 GiB; 3m / 2242 MiB         | 500 GiB, `codex-turin`          |
| **OpenClaw** — [platform](../../argocd/applicationsets/platform.yaml) disabled `openclaw`, [overlay](../../argocd/applications/openclaw)                                                        | `openclaw`        |                          0 | None                                    | 85 GiB, `openclaw-rootdisk-rbd` |
| **Restate example** — [platform](../../argocd/applicationsets/platform.yaml) `restate-example`, [overlay](../../argocd/applications/restate-example), [service](../../services/restate-example) | `restate-example` | 3 (1 Running, 2 Succeeded) | 100m / 256 MiB; 1m / 30 MiB             | None                            |
| **pgAdmin** — [platform](../../argocd/applicationsets/platform.yaml) `pgadmin`, [overlay](../../argocd/applications/pgadmin)                                                                    | `pgadmin`         |                  1 Running | No container requests set; 1m / 267 MiB | 10 GiB, `pgadmin`               |
| **Olden** — [product](../../argocd/applicationsets/product.yaml) disabled `olden`, [overlay](../../argocd/applications/olden), [workspace](../../apps/olden)                                    | `olden`           |                          0 | None                                    | None                            |
| **Ecran/Juge** — [product](../../argocd/applicationsets/product.yaml) disabled `ecran`, [overlay](../../argocd/applications/ecran)                                                              | `ecran` absent    |                          0 | None                                    | None                            |

Recommended PRs and gates:

1. **Codex devbox:** Ask the workstation owner to confirm there are no active sessions and approve an idle/resize
   policy or a retirement. If retiring, migrate and verify the workspace disk first, then stop compute through the
   owning overlay. A subsequent PR can remove the platform entry and dedicated
   [Warehouse](../../argocd/applications/kargo/warehouses.yaml), [Stage](../../argocd/applications/kargo/stages.yaml),
   promotion policy, and image inputs if the owner confirms there are no other devbox users.
2. **OpenClaw:** The VM is absent and the DataVolume still owns the bound disk. Obtain sign-off on an export and
   restore test before removing the disabled platform entry, its ignore-difference rule, the overlay, and
   OpenClaw-specific validation references. Do not assume that deleting the entry reclaims the retained disk; that
   requires a separate approved data disposition.
3. **Restate example:** Keep end-to-end smoke coverage. First move the Greeter registration and smoke check to a
   bounded test environment and prove it there. After confirming there are no production callers or in-flight
   invocations, retire the example registration and workload, then remove the entry, bundle, and source along with
   their CI and network-policy inventory references. Leave the core Restate application alone.
4. **pgAdmin:** Have database operators confirm a replacement and export any needed server definitions or
   settings. Retire the Ingress and workload through the owning overlay after approval, preserving `pgadmin` PVC
   until recovery is verified. Then remove the platform entry and overlay in a separate PR.
5. **Olden:** Confirm product and publishing owners do not use the workspace or image. Remove the disabled product
   entry, overlay, workspace, package aliases, docs generation, and app-specific CI in one coordinated PR; regenerate
   `bun.lock` and adjust the enabled-app contract fixture as applicable.
6. **Ecran/Juge:** Confirm recovery and external image needs with owners. Remove the disabled `ecran` element,
   its overlay, and the retained fixture and documentation references together. Registry retention is a separate decision.

Before any live retirement, re-read the owning Application and native workloads, confirm dependencies and data
retention, and stage the desired-state removals so Argo can reconcile them while it still owns the resources. The
product and platform ApplicationSets preserve resources on Application deletion; removing an element alone is not
evidence that a Pod or PVC was removed.
