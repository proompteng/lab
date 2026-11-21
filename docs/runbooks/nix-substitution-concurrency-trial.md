# Nix image substitution concurrency trial

Status: Candidate configuration. Performance acceptance is pending a comparable normal build. Passing workflow
contracts or a fully cached build does not establish a performance improvement.

## Scope and hypothesis

The native `build-platform` job in `.github/workflows/nix-oci-build-common.yml` sets
`max-substitution-jobs = 4` and `http-connections = 8`. The preceding setup action writes these settings to the
runner's user configuration and exports the same configuration through `NIX_CONFIG` for subsequent steps.
The publication job retains its existing configuration.

This bounds parallel Nix substitutions and HTTP connections within each Nix process. The hypothesis is that fewer
simultaneous cache downloads and store extractions reduce burst queueing on the shared Ceph metadata devices.
It does not reduce the bytes needed for a closure or bound separate Nix processes, runner bootstrap copies, compiler
parallelism, registry uploads, or application startup I/O. Four substitutions and eight connections are trial values,
not a measured optimum or a cluster-wide concurrency limit.

The existing ARC runner count, CPU settings, 100Gi Ceph claims, placement, complete seed-copy checks, 45Gi reserve,
cache signatures, source-build fallback behavior, timeouts, and Ceph replication and scrubs remain unchanged.
Read [ARC ownership](../../argocd/applications/arc/README.md) and the
[Ceph telemetry definitions](ceph-performance-telemetry.md) before interpreting the comparison.

## Baseline evidence

At 2026-11-21 07:14:01 UTC, both native image runners reported Nix 2.28.5 with
`max-substitution-jobs = 16`, `http-connections = 25`, `max-jobs = 1`, and `cores = 20`.
The installed setting descriptions and the [Nix 2.28 configuration reference](https://nix.dev/manual/nix/2.28/command-ref/conf-file.html)
agree that substitution concurrency is separate from local build concurrency. Command-line options override
configuration files; `NIX_CONFIG` is read after the system and user files. Inspect the actual execution path rather
than assuming that a configuration string reached a daemon.

Read-only checks at 07:22 UTC identified the same ARC image index on both architectures,
`sha256:f9780eb6f08991b4821e84e33d30ad15c82e48e1d429fdf87b36bb8d527cd8a8`, with a trusted local Nix store
and no daemon socket. An invocation-only configuration readback at 07:26 UTC on each architecture accepted the
candidate's 4/8 limits and retained `max-jobs = 1`, `cores = 20`, `fallback = false`, the existing timeouts, and
`fsync-metadata = true`. It did not write configuration files, start builds, or alter running-job environments.
This proves setting support and precedence, not actual concurrency or performance under a build.

During the earlier cache incident, the recording rules evaluated at 06:37:30 UTC showed:

| Observation                                                        | Value                     |
| ------------------------------------------------------------------ | ------------------------- |
| Turin OSD 0–2 mean client write latency over five minutes          | 6.10–9.29 seconds         |
| Turin OSD estimated mean queue wait over five minutes              | 4.48–7.50 seconds         |
| Shared Turin BlueStore DB device `nvme2n1` busy ratio / mean queue | 0.9983 / 15.55            |
| That device's mean write latency / OSD BlueFS fsync means          | 47.46 ms / 116.8–120.3 ms |
| `replicapool` / `cephfs-data0` logical write throughput            | 55.57 / 37.22 MB/s        |

`ceph osd metadata` identified `nvme2n1` as the DB device for all three Turin OSDs. The other host's three OSDs
share `nvme1n1`. These are counter-derived means, not operation percentiles. The observations identify shared
queueing; they do not isolate Nix substitution concurrency as its cause. Ceph reported healthy during the sampled
windows. Later latency improved while scrub throughput increased, which does not support reducing scrubs.

## Branch trial boundary

Keep this candidate unmerged until a meaningful comparison supports it. The reusable workflow is
`workflow_call` only. Bayn and product image dispatches enforce `main`; preserve those gates.
The preceding coverage-only commit adds OpenCode's own workflow and this shared workflow to its existing
pull-request path filter. That job builds the exact PR head on both native architectures. Its publication options
retain their false defaults;
the common workflow's platform push, index publication and Attic warming conditions exclude pull requests.
The product workflow retains its existing path filter and main-only native jobs.

Use that ordinary OpenCode PR check for a prospective comparison after the pending release has merged. Rebase
both phases onto the same accepted release source first. Push only the coverage correction for the baseline,
retaining the current 16/25 defaults. Wait for both native jobs and retain their log artifacts before adding the
separate 4/8 candidate commit. Neither phase automatically merges or publishes images. Apart from normal source
identity, keep the runtime and dependency closure identical, and verify actual seed and cache state for each run.
Do not overlap the two phases or cancel the baseline by pushing the candidate early. A single pair is an initial
observation; it does not replace the repeated comparable observations required below.

The existing `arc-runner-build-push.yml` dispatch can execute a reviewed candidate branch on both native
architectures. On a branch it publishes ordinary SHA-tagged registry artifacts, sets `latest` false, skips Attic
warming, and creates no Kargo alias. It does not promote a runner image or change the running fleet. This is a real
image build with registry side effects, not a read-only probe. Schedule it only after the release work already using
the runner pool has reached its required gates.

Inspect recent normal ARC build logs and their substitution counts before dispatching. If the same seed and target
closure are already present, or only one cached final archive needs fetching, the run cannot test the concurrency
hypothesis. Record that limitation and leave the candidate unmerged. Do not purge caches, invalidate a closure,
change dependency versions, or create synthetic work to manufacture misses.

The two most recent normal ARC runs inspected on 2026-11-21,
[44636294048](https://github.com/proompteng/lab/actions/runs/44636294048) and
[44633477285](https://github.com/proompteng/lab/actions/runs/44633477285), each had one upstream and one Attic
substitution per architecture in the native build window. The newer run's Attic fetch was a single final archive
(1295.11 MiB arm64 / 1443.78 MiB amd64 unpacked); no exhausted downloads were logged. Two paths cannot exercise
the proposed four-versus-sixteen substitution bound. These runs are not a representative performance baseline.

OpenCode run [44878792846](https://github.com/proompteng/lab/actions/runs/44878792846), at source
`6219a1926c9a5d1878c7c1cf34053c9bf799939d`, exercised a larger closure. Each native build step logged 90 distinct
substituted store paths: six from Attic and 84 from the upstream cache, with no repeated path/source pairs or
download-failure lines. Its planned 89-path fetch batch was 412.04 MiB download / 3348.93 MiB unpacked on arm64
and 440.04 / 3441.44 MiB on amd64. The full build steps took 280 and 219 seconds, respectively, and each logged
16 local derivation builds. These historical runs show that an ordinary OpenCode PR can exercise the proposed
bound; they are not a matched baseline for a warmed candidate. Use the prospective coverage-only phase above.
No candidate build has been dispatched or measured. Leave performance acceptance inconclusive until comparable
ordinary workload evidence exists; do not merge the candidate on the strength of cache hits.

## Comparison recorded before execution

Use the same real image attribute, architecture, dependency lockfiles and runner seed image in each pair. Record
the exact baseline and candidate Git commits and workflow definitions. Prefer fresh ordinary runner PVCs with the
same verified seed; a reused runner's extra store paths make it a different cache state. Record Pod UID, node,
claim, image digest and the client RBD mapping while the Pod exists. Device numbers can be reused after deletion.

For every baseline and candidate observation, retain:

1. Effective Nix version and the four selected settings above from the process's configuration path. Identify
   local-store versus daemon execution and any command-line overrides. Never export the full configuration or
   environment because it can contain access tokens.
2. Planned fetched paths and bytes, actual Attic/upstream substitution counts, local derivation builds, cache errors
   and retries, and the image output path. The existing build log and `nix/ci-nix-oci-summary.sh` provide the available
   counts. Mark missing evidence as missing. Do not compare a substituted final image with a local image build.
3. Existing `build-image-<arch>` timing, total native job duration, conclusion and artifact validation results.
   Separate runner startup/queue time, cache acquisition, native tests, image construction and optional uploads.
4. Exact UTC acquisition windows, simultaneous active runner work and pool throughput. Compare equal-duration
   windows and keep the surrounding load visible rather than attributing every change to the candidate.
5. Per-OSD client write means, estimated queue wait and BlueFS fsync means; metadata-device busy ratio, mean queue
   and write means; mapped client RBD write means and queue. Use the same recording windows in both cases.

Useful existing recording rules are:

```promql
ceph_storage:osd_write_latency_seconds:mean5m
ceph_storage:osd_queue_wait_seconds:estimated_mean5m
ceph_storage:bluefs_fsync_seconds:mean5m
ceph_storage:host_disk_busy_ratio:rate5m
ceph_storage:host_disk_queue_depth:mean5m
ceph_storage:host_disk_write_seconds:mean5m
ceph_storage:rbd_pod_write_bytes_per_second:rate5m
```

Filter host metrics by the verified node and device. A missing or zero-operation latency series is not a zero
latency result. Do not add physical device, replica, and logical pool bytes together as independent demand.

## Acceptance and recovery

Judge each architecture and comparable cache-state group separately. A passing source/manifest test proves
configuration correctness; it does not satisfy these operational criteria:

- All existing image validation, signature, native test, timeout and release gates pass without retries masking a
  terminal failure. Transfer errors per fetched path and exhausted downloads do not increase. A zero-error baseline
  requires a zero-error candidate; different or unknown fetch volumes make the error comparison inconclusive.
- Comparable acquisition windows show a repeatable reduction in queueing and mean client write latency without
  moving the delay into longer total builds. One successful run or a lower metric under lighter load is insufficient.
  Retain at least three comparable observations per architecture and report all of them, including failures.
- Comparable total native build duration does not regress by more than 10%, preserving the existing
  [build-performance contract](../nix-enabled-app-build-performance-rollout-plan.md). Report acquisition and total
  duration separately so throttling is not presented as a speedup merely because a storage graph is lower.

If matched observations are unavailable, transfer failures increase, queueing does not improve repeatably, or the
duration contract fails, leave the candidate unmerged. After an authorized merge, recover by reverting these two
build-job settings through the normal PR path; future jobs return to their prior limits. Do not change a running
job's environment, delete active Pods, or relax storage durability as recovery.

Reducing fan-out cannot add storage service capacity. Persistent queueing at the lower concurrency requires a
separate measured capacity or workload-isolation decision for the shared BlueStore DB devices. It is not evidence
for a lower runner count, disabled scrubs, weaker replication, or weaker fsync guarantees.
