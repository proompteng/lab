# Cleanup audit: workflows and scripts

Audited `.github/workflows/`, `scripts/`, and `packages/scripts/src/` at `0af41c37c`, and checked GitOps for
leftovers from recorded retirements. Removed five orphan scripts. No workflows or GitOps manifests met the
deletion bar, and all protected paths were left unchanged.

## Deleted files

Before deletion, each file had **zero inbound matches** for its full path, filename, and extensionless basename.
The searches used `rg --hidden --no-ignore --text -ilF` from the repo root, excluding only the candidate itself,
`.git/`, and installed `node_modules/`. This included all workspace manifests, CI and build files, GitOps,
runbooks, and tests. None of the deleted entry points exported symbols.

- `scripts/kafka-tail-topic.sh`: The helper passed a consumer heredoc to `kubectl exec` without `-i`, so the script did
  not reach the client Pod. The [maintained Kafka reader](../packages/scripts/src/kafka/tail-topic.ts) is called by the
  market-data smoke check and covered by its own tests.
- `packages/scripts/src/bumba/ensure-worktree.ts`: Bumba's [repository activities](../services/bumba/src/activities/index.ts)
  read Git objects at the requested ref without resetting a worktree. The only outside mention of the old worktree path is
  a literal [Temporal test fixture](../packages/temporal-bun-sdk/tests/workflow/primitives.test.ts) that never accesses it.
- `packages/scripts/src/tengri/update-release.ts`: The manual writer predates the
  [Tengri Kargo Stage](../argocd/applications/kargo/stages.yaml). The ApplicationSet tracks `kargo/tengri`; writing image
  pins and enabling the app on `main` is not a release path.
- `packages/scripts/src/tengri/validate-release.ts`: The CLI rejected the ApplicationSet's `preservedFields` on the
  audited commit. Native release checks run in [Tengri CI](../.github/workflows/tengri-images.yml).
- `packages/scripts/src/tengri/validate-rendered-release.ts`: It runs the same obsolete validation before reading the
  rendered manifest. The shared library and its manifest fixture tests remain.

## Retained and deferred

- **Agents retirement:** `d0f536d41` removed the dedicated Graf, Synthesis deep-alpha, and Anypi eval resources,
  not the Graf or Synthesis applications or the Anypi runner. Graf and Synthesis CI are still called by
  [queue service validation](../.github/workflows/queue-service-validation.yml).
- **Workflows:** Event triggers and external or manual dispatch count as callers. Kept the Vecteur manual publisher
  and the external Analysis workflow; removal needs confirmation from the publishing and upstream CI owners.
- **Autotrader:** `aa161e9f1` removed the scheduled deployment. `scripts/autotrader/` still has internal imports
  and test consumers; confirm any remaining manual/replay use with the owner before removing it as a unit.
- **Ecran, Juge, and Riposte:** Kept the broken image builders and disabled `argocd/applications/ecran/` manifests.
  The [cleanup backlog](repository-cleanup-todo.md#broken-image-builders) still references them and calls for
  checking registry consumers, live workloads, and recovery use before removal.
- **Legacy provisioning:** Kept the Harvester, Rancher, and K3s assets listed in the
  [cleanup backlog](repository-cleanup-todo.md#legacy-harvester-rancher-and-k3s-assets) pending owner verification
  of remote state and recovery dependencies.
