# Build-push latency audit — Wave 19J

Scope: `bayn-build-push`, `agents-build-push`, and their shared Nix OCI build path. This wave narrows Bayn's push
trigger. Agents already selects an explicit set of input paths without a manifest wildcard. No cache settings,
runner pools, or Agents workflow change in this wave. The timing sample uses completed main pushes created on
2026-11-27 UTC, before the runner placements in the reviewed source.

## Avoid starting work for unrelated manifests

[Bayn's Nix recipe](../../nix/images/bayn.nix) builds both the trading and research images. The
[dependency source](../../nix/images/bun-workspace-deps-source.nix) collects manifests for Bun workspace discovery,
but the [runtime derivation](../../nix/images/bayn-runtime-root.nix) installs with `--filter '@proompteng/bayn'`
and prunes manifest and lock metadata outside `node_modules` from the fixed-output dependency tree. The root
`package.json` owns workspace discovery, root dependencies, and patches; `services/bayn/package.json` owns Bayn's
dependencies and build scripts. Resolving both roots in `bun.lock`, including transitive workspace links, reaches
no other workspace. The frozen research input comes from a [pinned Git revision](../../nix/images/bayn-frozen-control.nix),
and the [broker feed](../../nix/images/bayn-broker-feed.nix) is a Dorvud Gradle build, not a Bun workspace.

[Bayn's trigger](../../.github/workflows/bayn-build-push.yml) now selects the root manifest explicitly and still
covers the service manifest through `services/bayn/**`. Of the 41 manifests in the audited Bun graph, 39 unrelated
ones no longer launch a run on their own. Keep `bun.lock` as a trigger: a change there can update a reachable
dependency without editing either manifest. The [planner](../../packages/scripts/src/bayn/plan-publication.ts)
diffs from the last verified cohort publication, not from the preceding push. It returns `image=false` when
only unrelated lock entries changed and no cohort inputs are pending. A reachable resolution or integrity change
still builds the cohort, as does an unpublished source change carried forward by a lockfile-only push. Missing
proven publication history still selects the full cohort. The graph regression checks that the trigger covers
the current installed workspace closure; update the trigger if Bayn adds a linked workspace.

## Locate time on the publication path

These are GitHub Actions job and step timestamps for two successful cohorts per workflow. The table reports
`started_at - created_at` across successful platform jobs and step time on the **last finishing platform job**,
which blocks the cohort. Job duration also includes checkout, setup, verification, other steps and cleanup.

| Main push                                                                        | Platform pickup range | Last platform job (historical pool) | Nix build | Registry push | Attic warm | Job duration |
| -------------------------------------------------------------------------------- | --------------------: | ----------------------------------- | --------: | ------------: | ---------: | -----------: |
| [Bayn 45997162309](https://github.com/proompteng/lab/actions/runs/45997162309)   |                2–16 s | Research ARM64 (Ceph)               |     185 s |          31 s |       15 s |        306 s |
| [Bayn 46077042094](https://github.com/proompteng/lab/actions/runs/46077042094)   |                1–14 s | Research ARM64 (Ceph)               |     394 s |          24 s |       15 s |        524 s |
| [Agents 45977120903](https://github.com/proompteng/lab/actions/runs/45977120903) |                 2–5 s | Codex runner ARM64 (Ceph)           |   2,476 s |         104 s |       21 s |      2,739 s |
| [Agents 46082213454](https://github.com/proompteng/lab/actions/runs/46082213454) |                 2–3 s | Control plane AMD64 (Ceph)          |   1,255 s |          86 s |       42 s |      1,641 s |

Bayn's `changes` job ran for 20 s and 17 s in those runs, after 38m 46s and 3h 4m 10s from workflow creation to
job creation. That interval is before job pickup, not ARC queue time. Registry upload also varied: in the second
Bayn run, the AMD64 trading image spent 350 s pushing after a 47 s Nix build. Build-step time includes both
substitution and local build work; neither those durations nor a successful warm step measures the cache hit rate.
These four older runs identify where to look, not a tmpfs versus Ceph comparison or a measured speedup.

## Cache and pool priorities

1. **Distinguish reusable closure hits from image rebuilds.** The
   [shared builder](../../.github/workflows/nix-oci-build-common.yml) uses preinstalled Nix and signed Attic and
   upstream substitutions. It retains a bounded same-build retry for an interrupted Attic NAR stream. Check each
   architecture's `nix-oci-logs-<image>-<arch>` artifact (`timings.tsv`, build log, warm log and status; retained
   seven days). Compare the planned substitute bytes, attempted Attic/upstream paths, locally built derivations and
   retries for the same image, source, seed and pool. Prioritize misses in reusable dependency/runtime outputs over
   misses for revision-stamped archives. Keep fixed-output hash verification: a warm cache can hide a stale hash.
2. **Keep warming bounded and measure it separately.** [`cache-push.sh --build`](../../nix/cache-push.sh) warms
   build outputs as well as the archive; the archive does not reference its build-time inputs. The shared job pushes
   to the registry first, then warms in batches of 64 with one upload job and a 30-minute timeout. Upload failures
   warn without invalidating the registry push. If archive warming adds meaningful time to the slowest builds,
   compare same-revision rebuilds and later dependency reuse before trying a narrower warm set. Preserve the
   reusable outputs, cache trust, immutable image verification, and receipt-before-discovery contract. Do not
   reapply blanket download throttling: the [16/25 vs. 4/8 trial](../runbooks/nix-substitution-concurrency-trial.md)
   did not establish a repeatable improvement.
3. **Keep native archive work on the standard tmpfs pools where it fits.** The reviewed Bayn caller opts in all
   three images; the [Agents caller](../../.github/workflows/agents-build-push.yml) opts in all four on push and
   retains its manual Ceph fallback. Both still finish on `arc-amd64`. The [ARC configuration](../../argocd/applications/arc/application.yaml)
   caps standard tmpfs at 10 AMD64 and 8 ARM64 runners, scaling from zero. Each has 16 GiB scratch including the
   seed, with a 16 GiB memory request and 24 GiB limit shared by scratch and processes. One Bayn plus one Agents
   cohort can request seven archive jobs per architecture before other callers compete. Measure pickup p95 and
   runner bootstrap separately from workflow concurrency waits; check cold-build scratch and cgroup memory peaks,
   evictions and throughput under mixed load. Consider a warm slot only if cold registration is a recurring
   bottleneck and node headroom allows it. Keep the 64 GiB Ceph path for jobs that cannot fit; do not widen pools or
   relax scratch checks based on compressed image sizes.

Compare one change at a time on both architectures using [the ARC acceptance and capacity guide](../../argocd/applications/arc/README.md).
Success is a shorter end-to-end publication critical path without worse failure rates, resource pressure, or any
change to the complete [Kargo publication contract](../release-automation.md). No runner or cache tuning was applied
or measured by this wave.
