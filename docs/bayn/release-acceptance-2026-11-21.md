# Bayn release acceptance — November 21, 2026

This is the release evidence companion to the [profitability and reliability investigation](session-investigation-2026-11-20.md). All times below are UTC. It separates completed CI, published artifacts, observed deployed behavior and financial qualification.

## Financial result and decision boundary

The original November 16–20 PAPER cohort contains 863 fills and 169 flat-to-flat episodes. After the later canonical settlement, gross realized trading was -$1,352.00 and posted broker fees were $64.03. The broker cash change was therefore **-$1,416.03**; subtracting the original-cut known inference estimate gives **-$1,417.717284228**. Unknown earlier usage and unallocated infrastructure, data and research expense remain unresolved. This is a known-cost result, not fully costed net profit.

The [settlement addendum](session-investigation-2026-11-20.md#later-fee-settlement-and-runtime-recovery--november-21-2026) and its [bounded read-only SQL](sql/fee-settlement-2026-11-21.sql) retain the financial cut, accounting reconciliation and automatic PAPER-authority recovery. Operational readiness does not qualify the strategy economically. No new order, paid inference, mandate, assessment or registration was issued by this investigation.

## Final recovery source and CI

[PR #16111](https://github.com/proompteng/lab/pull/16111) merged the reviewed source `437355b8cfdd2ce29578e670079244ddedd58886` at **09:24:44 UTC**, producing main source `acc115c8082a00881fc3d1daef8af08b62458a85`.

- [Bayn workflow 44886428311](https://github.com/proompteng/lab/actions/runs/44886428311) completed successfully at **09:24:18 UTC**: 26 successful jobs and one intentional GEPA skip; no failed or cancelled Bayn jobs. PostgreSQL, all ledger profiles, replay, archive, streaming, TLA and formal checks passed.
- The full final PR rollup had **34 successes and three expected skips**. An older cancelled semantic-title run was superseded by successful run `44886535044`; there were no pending checks or failures, and merge state was CLEAN.
- [Native workflow 44886428286](https://github.com/proompteng/lab/actions/runs/44886428286) passed 30 assertions on each architecture. ARM took 78.942 seconds and AMD 43.722 seconds, within the unchanged 90-second ceiling. Initial readiness recovered in 24.507 and 19.989 seconds after 19 and 14 cancelled probes respectively. Restart, deadline expiry/provider cancellation and process cleanup all passed.
- Automatic code and security reviews completed on `437355b8cf`. Code review reported no findings; the review-thread inventory was empty. The security result exposes completion, without a public finding count.
- Combined local focused validation at `dd816275` passed 433 tests and 13,716 assertions, with 77 explicit environment-gated skips and no failures. Both canonical TypeScript projects, package lint/format and the production build passed. A separate earlier mixed-working-tree full run is retained in the investigation as non-acceptance evidence.

The [CI receipt](bayn-pr16111-437-ci-acceptance.json) preserves the exact pre-merge observation at 09:24:33 UTC. Its OPEN/CLEAN state is historical. The [provenance record](bayn-pr16111-437-ci-acceptance-provenance.json) retains the executed verifier, which checked both fetched workflow and PR heads before writing. Raw API bodies were not retained.

The seven archived assessment graphs also passed the narrow v37 compatibility replay with every stored receipt, registration and cut hash preserved: six INCONCLUSIVE, one REJECTED, all NOT_ASSESSED. The rejected graph retains 550 UNBOUND_CONTROLLER_BUILD findings and INCOMPLETE_SAFETY_AUDIT. This is source-function replay evidence; no historical-read HTTP endpoint or new assessment was invented.

### Recovery behavior and remaining native uncertainty

The authenticated identity probe now has a one-second whole-response timeout inside the original 25-second startup budget. Retriable boot/transport failures reuse one owned child; authentication, version, other HTTP failures and child exit remain terminal. Shutdown allows 25 seconds for the native process's 20-second drain, then escalates to SIGKILL. Waiting for actual process exit does not promise a hard bound for uninterruptible kernel I/O.

The final ARM trace localized one 18.826-second cold context-stage header wait, while its later equivalent call took about 11 ms. The pinned server resolves its cold instance and project graph before that handler. Source inspection found no equivalent faster API preserving the same-session, full-prefix removal contract. This localizes a boundary; it does not apportion the delay among filesystem, database and plugin work, or prove the exact cause of the earlier second-stage CI timeout.

## Bayn and OpenCode acc115 release

Main publication and normal Kargo/Argo acceptance for `acc115c8082a00881fc3d1daef8af08b62458a85` are still pending at this draft's 09:25 UTC cut. The completed CI evidence above must not be read as deployed-runtime acceptance. Bayn and OpenCode are independent publication cohorts; both will receive their own exact-source runtime receipt.

## Build concurrency decision

[PR #16103](https://github.com/proompteng/lab/pull/16103) merged at 09:12:09 UTC as `c42718814285c6d8afde40d095820dd9ca3e328c`. It retains OpenCode workflow-change validation, removes inherited publication secrets from the PR-only caller and records the [Nix substitution trial](../runbooks/nix-substitution-concurrency-trial.md).

The candidate's 4/8 settings were removed. The original effective 16/25 defaults remain. Only one pair per architecture was measured; cache fallback, concurrent storage load and slower complete native tests prevent a repeatable speed or cost claim. The predeclared three-comparable-observation retention criterion was not met. No runner-capacity or Ceph durability policy changed.

## Operations acceptance — 2026-11-21

The Torghut streaming and telemetry changes from [source c217c1dd](https://github.com/proompteng/lab/commit/c217c1ddcce8f87d6c4306de27a1894cf8afe4ec) completed the normal cohort release. Freight `cbe185544ab752b9813e8ec1a5a238393cab7d2c` selected five images from that source. Kargo promotion `torghut.01m7ymgqjef4f1h0m1p6ygmyz6.cbe1855` succeeded at 08:51:33 UTC, producing revision `e65f6af4869304ff8d0893584da0e2ac88e069d9`; Argo became Healthy at 08:57:17 UTC.

[Automatic post-deploy run 44886462886](https://github.com/proompteng/lab/actions/runs/44886462886) passed the existing Argo/domain and market-data freshness checks, then the added streaming telemetry check from 09:00:26 to 09:01:31 UTC. The complete job succeeded at 09:01:41 UTC. Its retained `streaming-telemetry.json` reports `complete: true`, with three successful observations of the same collector UID, process, configuration hash and 12 current targets. Kargo's earlier HTTP smoke verification is a separate, narrower result.

### Restored state and delivery

| Pipeline           | New job                            | Savepoint restored | Fresh completed checkpoint at 09:00 UTC |
| ------------------ | ---------------------------------- | ------------------ | --------------------------------------- |
| Archive            | `922291431717b7c9126c515dc671082a` | 99215 at 08:52:33  | 99221; six completed since restore      |
| Technical analysis | `d736507b3f398766862c3ee492c35014` | 168653 at 08:56:22 | 168655; two completed since restore     |

Both jobs were RUNNING/STABLE. Each recorded one startup checkpoint trigger abort while required tasks were still starting, followed by successful checkpoints. All four TA and eight archive TaskManagers were Ready, with their runtime image IDs bound to the promoted `d63c751a…` index and zero restarts.

The automatic telemetry window retained 41,694 post-relabel samples on every observation. An independent current-target Mimir count at 09:04 UTC matched this: 18,020 TA and 23,674 archive series. The maximum observed scrape duration in the automatic window was 0.227831 seconds against the configured 30-second interval; the oldest scrape was 31.066 seconds old. All 28 observed pending-record series and 354 observed backpressure series were zero. Kafka lag had eight finite zero-valued series and 46 nonfinite series; the nonfinite values were not converted to zero.

During the automatic window, remote-write sent samples advanced from 1,462,279 to 1,587,500 with zero failed or retried samples. Highest observed and highest sent timestamps matched in all three observations. Pending samples were 1,229, 1,246 and 1,774, consistent with an active queue; the later bounded GC comparison observed convergence to 578.

### Collector memory acceptance

The new Alloy Pod `torghut-alloy-8484c5c5bb-snd2s` started at 08:46:52 UTC with the intended 256 MiB request and 512 MiB limit. Its UID/process remained unchanged, with zero restarts and no retained OOM termination. A read-only comparison across a natural GC cycle used the existing local metrics:

| Metric                       | 09:02:49 UTC | 09:04:11 UTC |
| ---------------------------- | -----------: | -----------: |
| GC count                     |           24 |           25 |
| Heap allocated               |    291.52 MB |    280.14 MB |
| Heap in use                  |    334.02 MB |    324.63 MB |
| Next GC target               |    409.74 MB |    407.78 MB |
| Go system memory             |    425.28 MB |    425.28 MB |
| Process RSS                  |    465.15 MB |    465.15 MB |
| Remote-write pending samples |          886 |          578 |

Memory values in this table are decimal MB. Exported GOMEMLIMIT stayed 483.18 MB and GOGC stayed 100. The unchanged RSS and reduced heap across GC support a bounded post-GC plateau. RSS is a process metric; it is not interchangeable with total cgroup memory usage. No forced GC, heap dump, load generation or live configuration change was used.

### Capacity policy and evidence scope

ARC retained its existing minimum five / maximum ten runners **per architecture**. Actual active counts varied: the retained 08:44 UTC snapshot had six AMD and nine ARM Ready registered workers, with four AMD and one ARM Pending. The investigation did not maintain or claim a fixed ten active workers. ARC capacity observations also do not explain jobs requesting GitHub-hosted `ubuntu-latest`.

This acceptance covers the exact deployment, a 65-second automatic telemetry window, fresh post-restore checkpoints, and an 82-second natural GC comparison. It establishes bounded rollout behavior; long-term reliability, peak-market behavior and profitability require their own measurements.

Evidence: the adjacent [sanitized acceptance receipt](session-investigation-2026-11-20-operations-acceptance-c217.json) preserves the exact release identities, fixed telemetry and GC observations, checkpoint results, limits, and SHA-256 hashes of the retained source files. Artifact **14700179852**, `torghut-retained-pipeline-44886462886-1`, in the linked workflow run contains the original automatic acceptance evidence. ZIP SHA-256: `10d0caf496b0f9a8c5786e425d666f81264606f6103c4c0bcf3f24fb56eee344`. GitHub artifacts follow their configured retention period; source hashes establish provenance but do not preserve the original payloads.

## Attic diagnostic rollout accepted — 2026-11-21

[PR #16102](https://github.com/proompteng/lab/pull/16102) merged at **08:49:37 UTC** as source `0e9b29ee77eaa836990a858e785bbcd608b8eb34`. [Main build 44886688127](https://github.com/proompteng/lab/actions/runs/44886688127) succeeded. The focused Rust diagnostic suite actually executed **4/4 tests on each architecture**; amd64 completed at 09:00:01 and arm64 at 09:02:20. Both native image jobs succeeded, and index publication completed at **09:12:56 UTC**.

### Published and running identity

The verified OCI index is `sha256:4af3d83b93c527f1e761f50552b7d66c14ebf5db609813b15067b07130f1c650`. Its source annotation and both platform configs identify the exact main source above.

| Platform | Child manifest digest                                                     | Config digest                                                             |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| amd64    | `sha256:5fa617d1aca69e8347f90e2a3773ef31b3caabc6addcfe44bc901e8b5e1f2ccc` | `sha256:7b111b8e7b8ed91c45502ee935970fec660340610db1ca9cced6ec7afbb11869` |
| arm64    | `sha256:e3db44d59e54a3bde7f2b43e75d1179964c368b92ecd9c0ab430f9f57b161121` | `sha256:c2bb2ee2d3749ede35c2ee2f531a067ec4c5f499ff3a7980b4845f572ea06ab7` |

The new live Pod `attic-555d75c7d6-vb9dp` runs on `turin` / amd64, is Ready, and has **zero restarts**. Its reported `imageID` is the OCI **index**; the separately reported config digest matches the amd64 config in the table. Read-only process inspection returned `/nix/store/jqci907jjpvy329fwnpdh8lafy4bf7sw-attic-0-unstable-2025-09-24/bin/atticd`, matching the server package path in that published amd64 config. The migration init container completed with exit 0 and zero restarts. The deployment has one updated, Ready, available replica, with generation 25 observed at 25.

### Normal delivery and endpoint acceptance

- Freight: `e9f3c02a283efe09d34aa6a18c7624253520ba5d`.
- Promotion `attic.01m7yp8ew3vs6gf4eb1pqn1nkq.e9f3c02`: **09:16:06 → 09:17:25 UTC, Succeeded**.
- Argo delivery revision: `d76bcb9518ad79a20cb581e50773a22bf26433c3`; **Synced / Healthy**, operation succeeded at 09:17:25.
- Smoke analysis `attic.01m7ypbbm8cysn51wh96357kfg.1c53c70`: **09:17:41 → 09:17:47 UTC, Successful**. Kargo Ready, Healthy and Verified conditions are all true.
- EndpointSlice targets only the new Pod, marked Ready and serving, with no terminating endpoint. The GC template uses the same new index.
- At **09:19:52 UTC**, read-only GETs to `/` and `/lab/nix-cache-info` returned **HTTP 200**. The bounded responses had the expected HTML and cache-info shapes (992 and 51 bytes). No raw response, internal address, credentials or request headers are included here.

### Natural error observation and limits

The new process started at **09:17:30 UTC**. A later bounded log observation through **09:23:16 UTC** examined **225 lines** and found **zero Stream error records**, with no parse failures or line/byte cap reached. Limits were 5,000 lines, 2 MiB and 20 allowlisted event records. No failure or traffic was induced, and raw logs were not retained.

This proves publication, normal rollout, process identity and the checked endpoints. It does not exercise a natural production error class, identify the cause of earlier partial NAR transfers, or establish a throughput or latency improvement. The change adds bounded, sanitized cause classification while preserving streaming and original error propagation.

### Exact source and evidence hashes

The companion [sanitized receipt](attic-0e9-runtime-acceptance-20261121.json) contains the full acceptance projection, ten input-receipt SHA-256 hashes, and the exact Git blob identities. Source-file hashes below were calculated from the immutable main source; no additional cluster or registry queries were made for documentation.

| Source file                                                 | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `.github/workflows/attic-build-push.yaml`                   | `5c73b413e32f08662dc51659bff4af25c076f77cfb5f0dd71f4f6a32f0fec51f` |
| `argocd/applications/observability/ci/workflows.json`       | `f003ba6c105bbea71ca7f4b60f86b744a24cfa83aae5571f0ee2c2bac5bb2bc0` |
| `docs/nix-cache.md`                                         | `6d6dd6ed53794a504656aff809c99d5a963ead62c6326b1182ef917cab6ffe72` |
| `nix/images/attic-stream-nars.patch`                        | `39bfea76278b8e7f035147509bc3c88a1789dedc58ce3810c47374b2cc615abe` |
| `nix/images/attic.nix`                                      | `4d2f1e7bea24ed9b9ca68a8f67ef40c71e3b90a325bc8852fd3ad1c120786909` |
| `packages/scripts/src/ci/__tests__/affected-inputs.test.ts` | `e623558504020fba71c4bb93a3728581c3f1f0f40d737fd27750b754166e4e2f` |
