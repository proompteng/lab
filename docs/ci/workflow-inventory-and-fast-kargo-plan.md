# Workflow inventory and config-only Kargo fast path

The inventory describes this checkout after Wave 18B. The fast path is a proposal, not a change to production delivery.
[Release automation](../release-automation.md) remains authoritative.

## Workflow audit

Audited all **100** tracked workflows (80 `.yml`, 20 `.yaml`) at the `fab5bb476` main baseline. For each workflow,
checked its events, local calls, and target against `apps/`, `services/`, `argocd/applications/`, and the release
contract. Where there is no app directory, the table identifies the actual owner, such as a package, platform tool,
manual verifier, or upstream publisher. Checked suspected orphans by filename, workflow name, and target with `rg`
across the repository, including hidden CI files, test fixtures, Kargo and ApplicationSets, and the active GitHub `main`
rules. The rules listed no required workflow or status context for a removal candidate; that alone is not evidence of
retirement.

**Removed: none.** No workflow has both a retired target and no remaining contract. In particular:

- `docker-build-common.yaml` has no checked-in workflow caller, but `packages/schematic` still emits a reference to it.
- Karapace lives under `argocd/applications/kafka/`. Sag has `services/sag/` and `argocd/sag/`; its verifier explicitly
  checks the disabled product ApplicationSet entry before attempting a live check.
- Vecteur's operator-dispatched publisher still builds `services/vecteur/`; Analysis's external dispatch and OCI
  validation are intentional. Neither is an orphan just because it has no PR trigger.
- W18A's `bayn-ci.yml` and W17-6's `auto-ontology-validate.yml` are unchanged.

### Retained inventory

Filenames are relative to [`.github/workflows/`](../../.github/workflows/). Owners are the principal source or GitOps
entry point, not an exhaustive trigger list.

| Workflow                                   | Owner or anchor                                     | Purpose                                    |
| ------------------------------------------ | --------------------------------------------------- | ------------------------------------------ |
| `agentctl-ci.yml`                          | `services/agents/agentctl`                          | CLI package validation                     |
| `agentctl-release.yml`                     | `services/agents/agentctl`                          | CLI binary and npm release                 |
| `agents-build-push.yml`                    | `services/agents`, `argocd/applications/agents`     | Four-image Agents release                  |
| `agents-ci.yml`                            | `services/agents`, `charts/agents`                  | Unit, static, and Kind checks              |
| `agents-sync.yml`                          | `services/agents`                                   | Sync Agents bundles to Auto Ontology       |
| `analysis-shared-ci.yml`                   | External Analysis, `argocd/applications/analysis`   | Admitted external validation and publish   |
| `arc-placement-acceptance.yml`             | `argocd/applications/arc`                           | Manual runner placement/qualification      |
| `arc-runner-build-push.yml`                | `argocd/applications/arc`, `nix/images`             | ARC runner image release                   |
| `arc-tmpfs-acceptance.yml`                 | `argocd/applications/arc`                           | Manual runner scratch and build checks     |
| `argo-lint.yml`                            | `argocd`, `scripts/argo-lint.sh`                    | Main-branch Argo workflow lint             |
| `attic-build-push.yaml`                    | `argocd/applications/attic`, `nix/images`           | Cache server and GC image release          |
| `auto-ontology-validate.yml`               | `docs/*/ontology`, `packages/scripts/src/agents`    | Validate Auto Ontology knowledge bundles   |
| `bayn-broker-feed-validation.yml`          | `services/dorvud`, `services/bayn`                  | Broker-feed validation before publication  |
| `bayn-build-push.yml`                      | `services/bayn`, `argocd/applications/bayn`         | Three-image Bayn release                   |
| `bayn-ci.yml`                              | `services/bayn`                                     | Bayn validation and required result        |
| `bayn-formal.yml`                          | `services/bayn`                                     | Reusable formal verification               |
| `buf-ci.yml`                               | `proto`                                             | Protobuf lint and generated bindings check |
| `bumba-ci.yml`                             | `services/bumba`, `argocd/applications/bumba`       | Atlas/Bumba checks and image release       |
| `buzz-relay-build-push.yml`                | `argocd/applications/buzz`                          | Build pinned upstream relay and publish    |
| `buzz-relay-cache.yml`                     | `argocd/applications/buzz`                          | Seed relay compiler cache                  |
| `cdk8s-manifests.yml`                      | `packages/k8s`                                      | Generated GitOps manifest contract         |
| `codex-ci.yml`                             | `packages/codex`                                    | Codex library tests and build              |
| `codex-devbox.yml`                         | `services/devbox`, `argocd/applications/devbox`     | Bootstrap validation and image publish     |
| `common-monorepo.yml`                      | Monorepo Bun callers                                | Reusable lint, test, and build jobs        |
| `convex-deploy.yml`                        | `packages/backend`, `argocd/applications/convex`    | Manual Convex deployment                   |
| `dernier-build-push.yaml`                  | `services/dernier`                                  | Dernier image release                      |
| `dernier-ci.yml`                           | `services/dernier`                                  | Dernier tests                              |
| `docker-build-common.yaml`                 | `packages/schematic`                                | Reusable Docker build template target      |
| `dorvud.yml`                               | `services/dorvud`                                   | JVM feed/analysis validation               |
| `facteur-ci.yml`                           | `services/facteur`                                  | Facteur build and tests                    |
| `feature-flags-ci.yml`                     | `argocd/applications/feature-flags`                 | Feature flags recovery contract            |
| `flamingo-ci.yml`                          | `argocd/applications/flamingo`                      | Serving identity checks                    |
| `forgejo-image-publish.yml`                | `argocd/applications/forgejo`, `scripts/forgejo`    | Verify and mirror pinned upstream image    |
| `froussard-ci.yml`                         | `apps/froussard`, `argocd/applications/froussard`   | Froussard checks and image release         |
| `galette-ci.yml`                           | `services/galette`                                  | Galette build and tests                    |
| `golink-ci.yml`                            | `services/golink`, `argocd/applications/golink`     | GoLink checks                              |
| `graf-build-push.yaml`                     | `services/graf`                                     | Graf image release                         |
| `graf-service.yml`                         | `services/graf`                                     | Graf JVM validation                        |
| `headlamp-ci.yml`                          | `services/headlamp`, `argocd/applications/headlamp` | Manifest/native checks and image release   |
| `hermes-agent-mirror.yml`                  | `scripts/hermes`, `argocd/applications/hermes`      | Mirror pinned upstream source              |
| `hermes-toolchain-build-push.yml`          | `argocd/applications/hermes`, `nix/images`          | Verified Hermes toolchain image release    |
| `jangar-build-push.yaml`                   | `services/jangar`, `argocd/applications/jangar`     | Main-only image release                    |
| `jangar-ci.yml`                            | `services/jangar`, root PR planner                  | Reusable runtime/Atlas/closure checks      |
| `jangar-guardrails.yml`                    | `packages/scripts/src/jangar`, Kargo policy         | Release workflow lint and policy checks    |
| `jangar-post-deploy-verify.yml`            | `argocd/applications/jangar`, `kargo/jangar`        | Verify promoted rollout                    |
| `karapace-schema-sync.yaml`                | `proto`, `argocd/applications/kafka`                | Validate or sync schemas                   |
| `kata-firecracker-extension.yaml`          | `devices/galactic/extensions/kata`                  | Build signed Talos runtime and catalog     |
| `khoshut-ci.yml`                           | `services/khoshut`, `argocd/applications/khoshut`   | Khoshut checks                             |
| `kubeconform.yml`                          | `argocd`, `kubernetes`                              | Main-branch manifest schema checks         |
| `manual-docker-build-push.yaml`            | Registry mirror, `packages/scripts/src/shared`      | Manual OCI-by-digest mirror                |
| `miel-ci.yml`                              | `services/miel`                                     | Miel build and tests                       |
| `nix-bun-dependency-closure.yml`           | `nix/check-bun-dependency-closure.sh`               | Recompute native Bun closure hashes        |
| `nix-oci-build-common.yml`                 | `nix/images`, shared OCI helpers                    | Reusable native image build and publish    |
| `nuc-omni-serve.yaml`                      | `devices/nuc/omni`                                  | Omni route ownership check                 |
| `ofz.yaml`                                 | `services/ofz`, `argocd/applications/ofz`           | Authorization validation and cohort image  |
| `oirat-ci.yml`                             | `services/oirat`, `argocd/applications/oirat`       | Oirat checks and image release             |
| `opencode-build-push.yml`                  | `services/opencode`, `argocd/applications/opencode` | Main-only OpenCode image release           |
| `opencode-ci.yml`                          | `services/opencode`                                 | Migration and native image check           |
| `orbit-salvage-ci.yml`                     | `apps/orbit-salvage`                                | Godot project validation and export        |
| `otel-ci.yml`                              | `packages/otel`                                     | Telemetry library tests and build          |
| `product-nix-images.yml`                   | `apps/{app,docs,landing,synthesis}`, GitOps         | Product image builds and publisher         |
| `pull-request.yml`                         | `.github/ci`, repository PR and merge queue         | Changed-area router and `ci-pr` gate       |
| `queue-service-validation.yml`             | Root PR gate, component workflows                   | Fan in reusable merge-queue checks         |
| `reestr-ci.yml`                            | `apps/reestr`                                       | Reestr validation                          |
| `registry-cleanup-ci.yml`                  | `packages/scripts/src/registry`, registry GitOps    | Cleanup/purge guard and HAProxy tests      |
| `relay.yml`                                | `services/relay`, `argocd/applications/relay`       | Relay validation and image release         |
| `restate-images.yml`                       | `services/restate`, `argocd/applications/restate`   | Restate images and cache proof             |
| `ricochet-rush-ci.yml`                     | `apps/ricochet-rush`                                | Godot project validation and export        |
| `sag-build-push.yaml`                      | `services/sag`, `argocd/sag`                        | Sag image release                          |
| `sag-post-deploy-verify.yml`               | `argocd/sag`, product ApplicationSet                | Verify Sag rollout when enabled            |
| `schematic-ci.yml`                         | `packages/schematic`                                | Workflow generator checks                  |
| `scripts-ci.yml`                           | `packages/scripts`, `scripts/jangar`                | Repo script and release contract tests     |
| `semantic-commits.yml`                     | Repo PR and merge-queue policy                      | Validate commit subjects                   |
| `semantic-pull-request.yml`                | Repo PR policy                                      | Validate PR titles                         |
| `shellcheck.yml`                           | Tracked shell scripts                               | Main-branch shell lint                     |
| `signal-publisher-build-push.yml`          | `services/signal-publisher`, Torghut GitOps         | Signal image and closure checks            |
| `signal-publisher-ci.yml`                  | `services/signal-publisher`                         | Signal publisher PR checks                 |
| `spire-migration.yml`                      | `argocd/applications/spire-server`                  | SPIRE datastore migration guard            |
| `symphony-build-push.yaml`                 | `services/symphony`, Symphony GitOps                | Shared Symphony image release              |
| `symphony-ci.yml`                          | `services/symphony`, Symphony GitOps                | Symphony validation                        |
| `symphony-post-deploy-verify.yml`          | `argocd/applications/symphony`, `kargo/symphony`    | Verify Symphony rollout                    |
| `synthesis-ci.yml`                         | `apps/synthesis`, `argocd/applications/synthesis`   | Synthesis application checks               |
| `temporal-bun-sdk-protos.yml`              | `packages/temporal-bun-sdk`                         | Scheduled/manual proto regeneration        |
| `temporal-bun-sdk.yml`                     | `packages/temporal-bun-sdk`, `apps/docs`            | SDK validation and npm release             |
| `temporal-static-libraries.yml`            | Temporal SDK Rust bridge                            | Manual native SDK library release          |
| `temporal-worker-images.yml`               | `services/temporal-worker`, Temporal GitOps         | Build and sign Temporal worker images      |
| `tengri-images.yml`                        | `services/tengri`, `services/nanoagent`             | Validate, build, and sign cohort images    |
| `tengri-validation.yml`                    | `services/tengri`, `services/nanoagent`             | Reusable native validation                 |
| `tengri.yaml`                              | `services/tengri`, `apps/landing`                   | Desktop browser acceptance                 |
| `torghut-build-push.yaml`                  | `services/torghut`, Torghut GitOps                  | Torghut main image release                 |
| `torghut-ci.yml`                           | `services/torghut`, Torghut GitOps                  | Torghut runtime and manifest checks        |
| `torghut-hyperliquid-feed-build-push.yaml` | `services/dorvud`, Hyperliquid feed GitOps          | Hyperliquid feed image release             |
| `torghut-notebook-build-push.yaml`         | `services/torghut`, Torghut GitOps                  | Notebook image in the release cohort       |
| `torghut-notebooks-ci.yml`                 | `services/torghut`                                  | Notebook validation                        |
| `torghut-post-deploy-verify.yml`           | `argocd/applications/torghut`, `kargo/torghut`      | Verify Torghut rollout                     |
| `torghut-schema.yml`                       | Torghut GitOps, ClickHouse schema tests             | Native schema contract                     |
| `torghut-ta-build-push.yaml`               | `services/dorvud/technical-analysis`, Torghut       | TA image in the release cohort             |
| `torghut-webull-feed-build-push.yaml`      | `services/dorvud`, Webull feed GitOps               | Webull feed image release                  |
| `torghut-ws-build-push.yaml`               | `services/dorvud/websockets`, Torghut               | WebSocket image in the release cohort      |
| `vecteur-manual-build-push.yaml`           | `services/vecteur`                                  | Manual Vecteur image build and publish     |

## Jangar PR ownership

At the audited base, a diff confined to Agents manifests, Agents charts, or observability manifests already missed
Jangar's native `pull_request.paths`. The remaining overlap was Jangar's architecture inventory: it reads Agents
routes and controllers, and those paths and the generated Markdown triggered the same workflow as Jangar runtime
source. The root router also duplicated those path rules, but did not invoke the standalone Jangar workflow.

- The root CI workflow is [`pull-request.yml`](../../.github/workflows/pull-request.yml), with a `ci-pr` **job**.
  Its Jangar decision now uses the existing `affected-inputs` action on the PR merge base and head. Jangar source,
  shared runtime packages, Jangar scripts, the Jangar app and bootstrap manifests, and relevant build inputs select
  the existing lint/typecheck, dependency-closure, and Atlas jobs. Lockfile-only changes select these jobs only when
  they affect the resolved Jangar workspace graph or lockfile settings.
- `ci-pr` requires the selected reusable workflow to succeed. A missing impact decision or a selected workflow that
  failed, was cancelled, or skipped fails the gate. Merge-queue guardrails remain in place.
- The [`jangar-inventory` target](../../.github/ci/impact-map.yml) runs the lightweight Bun inventory check for the
  generated document and its Jangar and Agents source inputs. Agents or observability configuration still goes to its
  owning manifest and service checks; it does not schedule the Jangar runtime jobs. Jangar publishing is unchanged.

## Proposed config-only fast path

Keep one publisher, one Kargo Warehouse and Stage per existing release, and one owner of `kargo/<stage>`. Cache the
**runtime build**, not the release decision. A config-only commit gets a new eligible OCI index built from already
qualified runtime layers. Kargo still promotes a new Freight whose source identifies the exact reviewed config.
Retagging the old index, adding an independent Git promotion stream, or copying a config commit directly to the Kargo
branch would not meet the current source/receipt contract.

### 1. Admit only a proven config-only delta

Pilot one repo-owned, single-image Stage in a non-production test of the [Jangar publisher](../../.github/workflows/jangar-build-push.yaml)
and renderer. Add the fast path to that publisher, not a separate release workflow. Start with an allowlist as small
as metadata changes in `argocd/applications/jangar/service.yaml`. At publish time:

- Use the exact reviewed `main` SHA, its commit timestamp, and evidence of passing required checks for the landed
  change. Compare against the last successfully published release for this target, not just the previous push. Verify
  that release's digest against its receipt and require its source SHA to be a `main` ancestor of the candidate.
  Jangar's path-filtered Git subscription must be able to discover the candidate SHA exactly.
- Require a nonempty, complete Git diff containing only allowlisted `.yaml` or `.yml` files under the target's
  `argocd/` renderer inputs. Inspect both sides of renames and reject removals, mixed pushes and unresolved history.
  Exclude Kargo and ApplicationSet controls, images and chart versions, identity/permissions and credentials, hooks,
  migration and activation inputs, and shared or cross-Stage overlays. Do not infer safety from the suffix alone.
- Render the exact candidate with its pinned toolchain, run the owning manifest/schema checks, and compare with the
  last verified deployment. Require unchanged resource identities, image repositories, and digest bindings before
  the Stage substitutes its receipt. Check the semantic diff against the allowlist. An unsupported diff or cache miss
  uses the existing full publisher. Missing or failed required checks block release rather than falling through.

### 2. Reuse qualified layers and publish a new immutable release

1. Have the normal publisher record a trusted build-input hash and qualified layer/config digests for every supported
   architecture. Compute the hash from the actual runtime derivation's source, dependency closure, toolchain/base
   artifacts, generated inputs, and build options. Exclude only the known source/time fields supplied at final
   packaging; if any revision-dependent value is embedded in a layer, rebuild rather than claiming equivalent bytes.
   Verify that the candidate's inputs match this receipt and the base index and all blobs still exist by digest.
2. Reuse the **same** compressed layer descriptors and rootfs DiffIDs. Assemble new platform config and manifest
   bytes with the candidate's RFC3339 source commit time (`org.opencontainers.image.created`) and full
   `org.opencontainers.image.revision`. Update any explicitly revision-bound image config fields (Jangar sets
   `JANGAR_VERSION` and `JANGAR_COMMIT`); require all other runtime config to match. This creates a derived image,
   not a modification of an existing digest. See the [OCI image configuration spec](https://github.com/opencontainers/image-spec/blob/main/config.md).
3. Use the existing publisher's final OCI index checks and signing/attestation requirements. Check both native
   manifests, exact source/revision annotations, all required receipts, and the retained verification artifact. For
   receipt-bearing images, use the current run's real `ai.proompteng.github-actions-run-id` and terminal build
   qualification result (`success`) for `ai.proompteng.github-actions-build-conclusion`, not the base run's receipt
   or an assertion about a still-running workflow. Make discovery aliases visible only after validation and required
   artifact uploads succeed.
4. Publish `kargo-sha-<40>-run-<github-run-id>` for receipt-bearing releases or `kargo-sha-<40>` otherwise. Preparation
   tags must stay outside Warehouse regexes. Serialize the fast and full publisher for a target, reject superseded
   revisions at publication, and reconcile an uncertain registry write by reading back its digest before retrying.
   Never move an existing tag. Multi-image cohorts stay on the current path until the complete cohort can prove
   equivalence and pass its existing all-image publication gate. The `analysis` and `bilig` exceptions do not use
   this path.

### 3. Promote and measure without skipping gates

After alias readback, use a private [Kargo v1.12.7 refresh receiver](https://github.com/akuity/kargo/blob/v1.12.7/docs/docs/50-user-guide/60-reference-docs/80-webhook-receivers/generic.md)
scoped to the owning Warehouse to remove the one-minute discovery wait. The signal only wakes discovery and grants
no promotion authority. Existing `NewestFreight` selection and the exact automatic policy still choose Freight;
the Stage checks out the matched commit, extracts the receipt from the selected image, updates the renderer inputs,
and pushes the generated branch. Keep `argocd-update` bound to the generated commit, the authorized-stage annotation,
health checks, and exact-branch post-deploy verification. A new image digest can legitimately restart workloads even
if all layers are reused.

Budget for a warm pilot, measured from the reviewed `main` push (including runner queue time):

| Phase                                             |   Budget |
| ------------------------------------------------- | -------: |
| Admit change and resolve cached inputs on runner  |     10 s |
| Render, assemble/validate index and publish alias |     15 s |
| Refresh Warehouse and select eligible Freight     |      8 s |
| Stage checkout, render inputs and Git push        |     12 s |
| Argo sync/health and terminal Promotion result    |     14 s |
| **Warm-path target**                              | **59 s** |

Treat **p95 under 60 seconds to a successful Promotion** as a pilot acceptance target, not a measured property or a
deadline to skip a gate. Record merge arrival, qualified index, alias readback, Freight creation, Stage push, sync,
Promotion completion and smoke timestamps for the same commit/digest. Report time to the generated branch and time
to healthy rollout/live proof separately. Compare the same changes on the normal publisher; include queue time and
report cache misses and slow/failed syncs instead of discarding them. Keep cold starts, unmeasured Stages and rolling
upgrades outside the claimed fast-path population.

Before enabling the pilot, prove a positive config-only release and rejection of a mixed runtime change, wrong or
missing cache receipt, missing platform, stale/failed CI, reused alias, interrupted upload and out-of-order pushes.
Render the generated revision and check the exact promoted index and running platform digest, then exercise the owning
smoke check. If safety or latency falls short, disable the fast branch and use the existing main-only publisher.
Recover a deployed regression by promoting previously verified Freight through Kargo, not by rewriting a branch or
syncing unpromoted `main`.
