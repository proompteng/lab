# Bayn system audit, 2026-11-08

## Scope and conclusion

Bayn implements one active, long-only equity entry strategy, two entry setups, broker recovery, and exact financial
accounting. It also contains a much larger collection of replay, research, assessment, retained-contract, and reporting
code. These are different workloads. They currently share too much source composition and the same deployable image.

This audit examines the system, not just its diagrams. The source baseline is
`ad8e10731e`, freshly fetched from `origin/main` on November 8. The inventory covers tracked Bayn files. The detailed
reads follow process entry points, market-data acquisition, strategy admission, inference, decision persistence,
submission, cancellation, reconciliation, accounting, controller recovery, research, image construction, and GitOps.

The evidence supports reducing the trading runtime's dependency closure, repeated historical reconstruction, and
large repeated evidence documents. It does not support changing disks, creating storage classes, removing accounting
checks, or deleting retained evidence. No runtime, capital authority, storage, or financial records changed during this
audit. The findings describe that baseline; the source cleanup below records subsequent implemented changes.

The accompanying [file inventory](evidence/2026-11-08-system-inventory.json) lists each tracked Bayn file, line count,
classification, and whether it contributes bytes to each of four locally built runtime entry points. Absence from those
four outputs is not proof that a file is unused: commands, tests, fixtures, research builds, and external callers remain
separate consumers. Git introduction and last-change commits are included for each file so the addition and its
subsequent changes can be inspected directly; file size alone does not attribute a design decision to a particular run.

The [database inventory](evidence/2026-11-08-database-inventory.json) records all 92 tables across the two databases,
their 742 columns and 184 indexes, relation sizes, and approximate row counts. The
[workload inventory](evidence/2026-11-08-workload-inventory.json) records 45 workload/claim resources, their images,
resource budgets, and current volume references. Neither contains account records, credentials or raw broker payloads.

## Source cleanup after the audit

The cleanup uses `8d6000317fad6a611e92cda41a535820c4e7eb69` as its before revision and Bun 1.4.2 for both
builds. These measurements are separate from the Bun 1.4.0 inventory below. The same three entry points, target,
externals and build options produce this comparison:

| Output                   | Before bytes | After bytes | Reduction | Bayn inputs emitting bytes, before → after |
| ------------------------ | -----------: | ----------: | --------: | -----------------------------------------: |
| Status API               |    7,830,266 |   5,821,591 |    25.65% |                                  512 → 210 |
| Execution endpoint       |   10,997,411 |  10,632,952 |     3.31% |                                  546 → 540 |
| Market projection thread |    3,423,572 |   2,284,752 |    33.26% |                                   259 → 53 |

The status composition now imports its resources directly. Its output contains no financial migration modules,
`observe-composition` cycle engine, or execution persistence constructor. Contract consumers import the existing
execution-store contract directly; the construction module no longer re-exports that contract. Risk-policy loading
lives with execution risk policy, independently of cycle startup. The forwarding lifecycle module and resource
aliases are removed, with all callers migrated.

The projection thread now imports the migration deadline independently of the financial migration registry. Its two
archive migrations, 15-minute deadline and failure behavior remain intact. No database schema or migration SQL changes.

Unused artifact schemas, their unused type exports and the unused input-manifest filter are removed. The manifest
filter had no runtime consumers; snapshot verification still checks provenance, hashes, calendars and coverage in
`market-data/verification`. Ledger event and reconciliation types remain. The two planner annotations now derive
weights from `RuntimeStrategyDecision` instead of the unused risk-balanced-trend decision artifact. The unused native
OpenCode origin and bid-breakout helper are deleted.

Reproduce the comparison at each revision with the same compiler, using different output paths:

```sh
npm exec --yes --package=bun@1.4.2 -- bun build services/bayn/src/index.ts \
  services/bayn/src/restate/restate-execution-server.ts \
  services/bayn/src/market-data/streaming/market-projection-worker.ts \
  --target=node --external tigerbeetle-node --external @platformatic/kafka \
  --outdir=/tmp/bayn-cleanup-bundles --metafile=/tmp/bayn-cleanup-metafile.json
```

These are unminified JavaScript byte counts and emitted-module counts. They establish smaller dependency closures;
they do not measure OCI closure, cold startup, request latency or trading returns. Research commands, retained readers,
financial history, reconciliation checks, writer fencing, permissions, storage and trading authority are preserved.

Local validation: the full unit suite passes with Bun 1.4.3, matching the CI unit-test version: 5,031 passed,
1,297 skipped, zero failed across 468 files. Both TypeScript projects, formatting, both lint modes, production and
research builds pass with Bun 1.4.2. The 137 focused behavior tests, 92 delivery tests and research command checks also
pass; the command checks use Node 24.11.1. Skipped tests are not established by local validation and require their
configured CI integration environments.

## System subtraction after the dependency cleanup

This follow-up starts at `b466a9e5e154b5a29ce4184bd672e5925244db98` (PR #15790). It changes runtime work,
not only imports. The measurements below use Bun 1.4.2 on the same machine and fixtures; PostgreSQL tests use a
disposable PostgreSQL 18 instance. They are not production request-latency measurements.

| Area                                                  |          Before |           After | Proof and retained behavior                                                                              |
| ----------------------------------------------------- | --------------: | --------------: | -------------------------------------------------------------------------------------------------------- |
| Jev no-trade decision JSON                            | 1,468,628 bytes | 1,193,564 bytes | One observation supplies the rows; every other document field except its content hash is identical       |
| Jev selected-entry decision JSON                      | 1,491,155 bytes | 1,216,080 bytes | Independent execution-pricing rows remain; streaming snapshots reproduce identically                     |
| Settled reconciliation accrual-history queries        |               3 |               2 | Actual SQL counted on both the initial stable cut and replay; one commit and exact reconciliation remain |
| Research server JavaScript                            | 7,432,445 bytes | 5,083,464 bytes | Same target, externals and compiler; AWS/Smithy emitted modules fall from 171 to zero                    |
| Validated strategy protocol copies per 10,000 lookups |          10,000 |               0 | Direct typed access returns the same object; external schema validation remains at ingress               |

The SEC/macro collector had no active trading or model-research consumer. Remove its eight source/test files,
startup activations, configuration, metric alert and unused TypeScript S3 dependency. Keep the existing capture bucket,
credentials and stored captures: GEPA uses that store through Python. Its environment names now describe research
captures and egress directly; all callers migrate together, with no aliases. The research endpoint serves
`BaynResearchRun` only. Existing public-collector timers must be canceled while their old endpoint remains reachable,
then checked again after registration of the replacement; see the owning
[retirement procedure](../../argocd/applications/bayn/README.md#research-capture-storage).
The two remaining scheduled collector invocations were gracefully canceled on November 8. Readback showed zero
outstanding invocations and the same two state records with an identical SHA-256 fingerprint before and after.
Repeat that readback after replacement-endpoint registration.

New protected-entry decisions persist observation rows once, inside their verified strategy evidence. The existing
financial reader still accepts retained documents and rejects any conflicting extra copy. Stored financial documents
are not rewritten. `shadow-decision.test.ts` compares complete document material, verifies both retained and compact
documents, reproduces their streaming snapshots and rejects a conflicting duplicate. Both fixture cases failed before
the change and pass afterward.

Fee posting returns its verified accrual records to reconciliation. A posting that changes `posted_at` rereads the
records before returning; a settled pass reuses its verified read. Full-history accounting reconstruction, ledger
verification and the writer fence remain. The PostgreSQL regression counted three queries before the change and two
after it; the complete persistence file passes all 40 tests, including posting recovery and replay.

Research-only strategy constructors move to `intraday-replay/strategy.ts`. Already validated protocol values no
longer cross repeated decoders or a fake asynchronous loader. Risk-policy selection is pure `Result` code, lifted
once by its effectful callers. Live and retained sandbox policy hashes and all budget limits remain unchanged.

The acquisition review found concrete consumers for the remaining feeds: Webull evidence reaches model input, and
crypto history supports retained exits and replay. Python, Git, Bun and Crane also have active research/replay
consumers in the shared image. This change does not introduce another image, cache, service or storage class to remove
them. Financial history, capture history and storage allocations are retained. Neither these byte reductions nor the
protocol microbenchmark establish a faster live tick, image startup or improved trading returns.

Local checks for this follow-up: 5,015 unit tests pass, 1,295 skip, zero fail across 464 files with Bun 1.4.3;
the 40 PostgreSQL persistence tests and 49 native Jev persistence tests pass against PostgreSQL 18. The latter cover
all nine native exit/recovery scenarios and retain the conflicting-source rejection check. Both TypeScript projects, formatting, both lint modes,
production and research builds, the research command smoke checks, 92 delivery tests and all seven GEPA tests pass.
The GEPA tests use the pinned upstream source and dependencies. Bayn and OpenCode manifests render successfully.
Skipped integrations still require their configured CI environments.

## Runtime cleanup after PR #15794

This work starts from `45579965308e14c07afd3d8960bc7d089de1986e`. The
[measurement record](evidence/2026-11-08-runtime-cleanup.json) separates current readback from the original inventory.
PR [#15801](https://github.com/proompteng/lab/pull/15801) merges these changes as
`cdb8fadf7c694a43296928253d8b9b61a46e8cec`. All 92 PR checks complete and both actionable review findings are resolved.
The cleanup is deployed in source `3c102b02a902a289700b137868c86563b052cfe4`. Successful main run
`42621043003` publishes both role images with matching immutable source/run receipts. Freight
`412a043e45cf37281dc43d7fc4d0934212534d63` automatically promotes through Bayn's existing Stage to
`kargo/bayn` commit `4bbd5ae14d55f0be6a505d03c703156fc72c9656`; Argo reconciles that exact revision.
The native activation hook succeeds, both native services select deployment `dp_11QCH160kWhe6rCtSgMpChj`,
and both workers and matched completed ticks report the new source. This proves the release and waiting-pass
behavior. A natural current Jev request later completes as `NO_TRADE`, and a new private compact decision passes
the current decoder. Two subsequent natural entries also fill; their current request, submission and recovery
records are joined below. Comparable full-request before/after latency remains unestablished.

The owning-image follow-up, PR [#15811](https://github.com/proompteng/lab/pull/15811), merges as
`784c39819435448a812989b9d3c0a0428a5835d9`. Its 71 terminal checks include 47 successes and 24 skips, with no failures.
The pinned OpenCode qualification now runs in its independent image build; both Bayn role builds drop the duplicate
check and unused CLI build dependency. CLI-only changes no longer schedule Bayn qualification or image publication.
Both OpenCode architectures and all four Bayn role/platform archives pass at the reviewed PR head. These checks
establish source and artifact qualification; the separate release readback above establishes rollout.

- B2: Trading and research have separate artifact contents through the existing Nix builder. Financial reporting
  remains available in the API workload. Qualification and replay move to `bayn-system-assessment` in the research
  artifact; the old command rejects those flags. The two images require the same successful source/run receipts before
  Kargo discovers the cohort. Archive checks verify required commands and reject research tools in the trading image.
  CI run `42596127173` verifies the actual trading and research archives on AMD64 and ARM64 at PR head `66ee055c5b`.
  The trading image retains the two files required by physical candidate-image qualification, including its
  backtest bundle and dependency receipt. Python, GEPA, Git, Bun and registry tools remain research-only.
  Opening capture also remains in the trading image to preserve the frozen plan's physical candidate-build identity.
  It is removed from the research payload; no identity override or weakened capital check is introduced.
  The published ARM64 native artifact has 95,185,246 compressed layer bytes, compared with 392,756,535
  in the preceding ARM64 artifact at `351b522baf`: a 75.765% reduction for that image. The separate research
  artifact has 384,746,220 compressed layer bytes. Actual Linux containers pass the selected native entry-point,
  wrapper and role-path checks, and all four selected research wrappers plus their role-path checks. These are
  published artifacts, not measurements of total cohort storage or image-pull latency. All four platform configs
  report the same source, and both indexes carry the exact successful main run's source/run receipts. PR
  [#15812](https://github.com/proompteng/lab/pull/15812) fixes the shared workflow's deferred-tag validation;
  the receipt validator remains strict. OpenCode proposals already run through
  the independently published OpenCode gateway; its pinned binary qualification belongs to that image build.
- B3: One ordered mutation-history aggregate replaces four lateral reads per intent. All 751 result rows match by
  bidirectional `EXCEPT ALL`, and the 40 PostgreSQL persistence cases pass. Five alternating warm samples after the
  first pair give medians of 24.382 ms before and 17.687 ms after. This is a 27.46% reduction for that query, not for a
  full reconciliation. A second ordered aggregate combines the quantity and cost inventory-debit reads in accounting
  reconstruction: its warm median falls from 121.191 to 72.337 ms with zero row differences. Full accounting
  reconstruction, ledger verification and the writer fence remain mandatory. Matched full-pass timing below shows
  little overall improvement from this first release.
  A subsequent change, merged in PR [#15814](https://github.com/proompteng/lab/pull/15814) as
  `b3aa14bb383fb06bd5d95196e1aad63346f1a08c`, removes one repeated canonical hash per accounting transaction by reusing
  the expected material hash already produced by reconstruction. It still hashes every stored body and verifies its
  claimed hash, every receipt and the full ledger. The active account contains 1,133 transactions. In an isolated
  1,000-record public fixture, seven alternating samples in the same published ARM64 Node runtime have wall medians
  of 48.421/41.581 ms and CPU medians of 48.815/43.726 ms: 14.1% and 10.4% lower respectively. Complete prepared
  output and four corruption failures agree. All 5,026 unit tests, 40 persistence and 49 native-Jev PostgreSQL tests,
  both type checks, all linters and both production/research builds pass; the unit run skips 1,298 cases. This hash
  change is now published and deployed through the existing Kargo Stage. Its isolated result does not establish
  production latency; the separate production readback below retains the slower accounting median.
  All 40 PR checks finish (37 successes, three skips), with completed automatic code/security review and no findings.
- B4: Native startup requests two minutes of Webull M1 pricing bars instead of thirty minutes. Its consumer
  accepts only the latest completed bar with a 10-second availability limit. Markets disabled for new entries also
  request two minutes of pricing history, replacing the unconditional two-hour crypto rebuild. The existing entry
  policy controls this bound; enabling a market restores its full chart history. Current liquidation queries use one
  completed minute and fresh quotes. BTC, ETH and SOL fixtures reproduce the same quotes without entry charts,
  replay their retained evidence, and preserve the exit policy's stale-quote rejection. Equity entry charts,
  subscriptions, capture contracts and explicit historical diagnostics remain intact. The projection adds only the
  pure entry-scope module, with 253 extra emitted bytes. The submission gate now lives in mutation-authority, and its formal
  conformance caller imports it there. This keeps financial authority contracts out of the projection. Kafka and
  independent-worker tests verify catch-up, cancellation and cleanup.
  The latest pre-cleanup starts, still on source `351b522baf`, incorporate 214,850 records in 33.392 seconds on
  Turin and 217,752 records in 87.309 seconds on Altra. Both cover 34 partitions with zero rejections. These natural
  restarts followed independent infrastructure work; arrival volume and background load differ from earlier starts.
  On source `3c102b02a9`, the corresponding natural starts incorporate 9,898 records in 5.065 seconds on Turin and
  9,988 in 7.365 seconds on Altra: about 95.4% fewer records on each node. Both still cover 34 partitions with zero
  rejections. These are one start per node, with different arrivals, background load and an independently changed
  archive replica/retry configuration; the elapsed-time differences are observations, not controlled causal gains.
  Two additional old workers remain because `BaynExecutionBootstrap` is still latest on their old deployment.
  Restate has no remaining invocation for that stateless service, and both current services point to the new
  deployment. Its registration retirement remains a separate reviewed operation under the owning runbook.
  Retain crypto sources while their executable-quote and replay consumers remain. A bounded sample of eight
  arrival chunks contains 137 records over 6.267 seconds: 45 Webull records, 91 crypto raw records and one crypto
  feature record. Serialized arrival bytes are 2,629,511, 158,454 and 42,567 respectively. These include retained
  transport evidence and are not Kafka wire-byte or CPU measurements. A quotes-only acquisition experiment is removed;
  changing a captured source and its partition coverage also changes the replay contract. No traffic saving is claimed.
- B5: New decisions store identical broker state once within the protected document. The planner resolves the full
  state from its own immutable entry observation; a different or refreshed planning cut keeps its separate state.
  Canonical document hashes cover the stored form. Retained full documents still decode, and target planning, risk,
  freezing and status readers use the complete state. All 90 targeted PostgreSQL cases pass. The eight latest sampled
  documents contain identical states: a read-only projection removes 3,834,137 of 38,759,681 JSONB text bytes, or 9.89%.
  This is representation size, not disk savings or a decode-time benchmark. Historical bytes remain unchanged.
  A live sampled historical decision passes the retained Jev financial verifier. It does not satisfy the current
  execution schema, so it cannot establish decode performance for the new representation.
  A new compact decision created at 14:32:06.089 UTC on November 9 passes the current full execution decoder
  inside the existing native API Pod. Independent SQL metadata agrees on its exact content hash and confirms that
  planner input omits its duplicate broker state. The stored JSONB text is 768,254 bytes. Reconstructing equivalent
  full/compact JSON in memory gives 1,183,892/728,580 bytes and wall verification medians of 76.785/64.371 ms
  over three retained alternating pairs; CPU medians are 87.985/68.426 ms. The two JSON encodings are measured
  separately from PostgreSQL's JSONB text rendering. This is one-record representation verification, not request
  percentiles or disk savings. No historical bytes or private document contents are exported or rewritten.
  Cross-record references remain unimplemented; no new reference store or lookup protocol is introduced.
- B6: Read-only metadata records 45,734,297,600 bytes of financial native-arrival chunks and 127,915,597,824 bytes in
  the dedicated archive. The 367 financial epochs were created through October 27; a later snapshot finds 440 dedicated
  epochs, with a newest epoch on November 9 UTC. Their capture-ID sets have no overlap. Financial end records contain
  250 `STOPPED` and 24 `INCOMPLETE` captures; the dedicated archive contains 303 and 20 respectively. These counts do
  not establish complete capture contents or quiescence. Epoch creation time is not last arrival time. Both 20-second
  header-range scans time out, so write quiescence and complete range overlap remain unverified. Existing exports and valuation
  readers retain their source-specific evidence. No rows or volumes are removed or moved.
- B7: The six old 10 GiB Valkey claims and the 2 GiB OpenCode claim still have no Pod consumer. OpenCode explicitly
  retains `Prune=false,Delete=false`. The active Valkey StatefulSet uses two different claims. The inventory does not
  inspect unmounted contents or establish recovery disposal; those claims remain retained.
- B8: The native root selects the native compiler; replay selects its research compiler. Both share one decision,
  risk and persistence implementation. The native bundle no longer emits the experimental evaluator module. All 208
  composition tests pass, including rejection of a research policy at the native entry boundary and its explicit
  replay evaluation. Immutable financial readers remain available.
  After rollout, the retired public-information collectors have zero nonterminal invocations. Their two retained
  Restate state rows have the same aggregate fingerprint as before rollout; neither registration nor state is deleted.
- B9: Matched Restate schedule records resolve the current pre-attempt interval. Three ticks intentionally wait
  29.904–29.972 seconds, start 62–992 ms after their due time, and run for 1.023–1.163 seconds. For the first two,
  `bayn.execution.advance` takes 919.450/916.957 ms, reconciliation persistence 607.923/606.341 ms, and accounting
  verification 274.076/267.426 ms. Nested spans must not be added together. These are waiting passes, not entry
  inference or order-submission waterfalls. The later natural entries below supply filled-path evidence, with
  separate limits on before/after comparability.
  Earlier v38 / Jev 1.13 filled-entry records remain in the measurement JSON and immutable historical figure.
  Current v40 evidence below replaces that historical example in the active request walkthrough.
  Earlier source-bound baselines and the financial-primary wait sample remain in the measurement record. One
  `cea96bc87f` outlier spends 6,922.463 ms inserting a broker event and 1,094.850 ms committing; the same backend's
  PostgreSQL logs independently confirm both durations. A later sample observes brief `WalSync` and `SyncRep` waits
  without a blocking PID, but does not reproduce that stall or establish its underlying cause. Independent DNS/proxy
  changes and archive rollouts also occur between those baselines; their mixed-node medians cannot isolate cleanup.
  The comparable full-history selection contains 30 before and 27 after passes on Altra, all `Waiting`, with exactly
  one reconciliation and accounting verification, matched to the same controller through exact Restate invocation
  ancestry. Three after passes with another outcome are excluded explicitly. Advance medians are 2,179.880/2,159.550 ms,
  persistence 1,651.818/1,574.174 ms, writer fence 1,416.744/1,320.600 ms, and accounting verification
  642.084/616.620 ms. The 0.93% advance difference is small; concurrent archive retry/replica changes prevent attributing
  it to this cleanup. The financial primary remains `bayn-db-2`. Cheap cached waits are not mixed into this comparison.
  In the representative after pass, accounting takes 603.642 ms; about 488.816 ms lies outside its child spans.
  This is untraced wall time, not a CPU measurement. Its 61 SQL client spans include a 109.191 ms cycle insert,
  49.447 ms fee query and 47.837 ms inventory-debit aggregate. These observations motivate measuring the pure
  verifier separately; they do not establish an unmeasured database or CPU cause.
  Before the first usable regular-session input, both pre-release and after observations report
  `SNAPSHOT_UNAVAILABLE` / `ALL_CANDIDATES_EXCLUDED` for 15 candidates. Matching-feature/completed-bar counts
  change from 0/0 to 1/1. These are rejected-observation diagnostics, not proof of upstream producer health;
  unused entry deadlines expire before and after release.
  A natural request observed at 14:31:04.705 UTC then completes under v40 / Jev 1.14.0. Its exact persisted batch
  identity and decision hash match native span attributes inside the source-bound Restate tick. CHART claim to
  receipt is 1,158 ms, handoff is recorded 2,561 ms after observed input, the evaluation receipt interval is 3,329 ms,
  and the batch completes at +4,735 ms. The protected decision is created at +6,741 ms. The native worker advance
  takes 12,204.559 ms, including reconciliation 2,365.138 ms, admission 1,668.637 ms, batch completion 1,577.200 ms
  and decision binding 1,367.110 ms. These inclusive spans are not additive. Durable record intervals can cross
  process clocks and do not isolate model-provider latency. The cycle ends `NO_TRADE`, with no submit, acknowledgement
  or fill in that sample; it establishes a completed strategy abstention.
  Two later v40 / Jev 1.14 BUY entries naturally fill. Their intents match the protected document's
  `bindings.strategyDecisionHash`, cycle, symbol and sealed batch; the document content hash is a distinct identity.
  The 14:46:04.667 UTC request also matches the exact batch and document-hash attributes inside native trace
  `c9d6fb6224290c673ec49ada7304b20c`, pinned to the same deployed source. Its CHART interval is 696 ms, evaluation
  receipt interval 1,105 ms, intent-to-submit interval 3,847 ms and submit acknowledgement 479 ms. The native advance
  takes 11,104.318 ms, including reconciliation 2,334.089 ms, admission 1,100.819 ms, decision/intent binding
  1,201.884 ms, committed-decision read 780.582 ms and submit 571.727 ms. Parent durations include children.
  Four BUY fills have four balanced posted accounting receipts. Their broker source timestamps span
  14:46:18.073649–14:46:25.735427 UTC; broker observation is recorded at 14:46:43.311 and recovery at 14:46:51.268.
  Protective SELL fills linked to the same intent are excluded from this entry timing. Broker and process clocks
  remain separate. These are real filled-path records, not an isolated cause for the later recovery observation or
  a comparable eligible-request before/after distribution. The second filled entry and its two BUY receipts are
  also retained in the measurement record.
  No trading authority, input validation, schedule or provider configuration is changed to obtain these traces.
- B10: The deployment and service READMEs remove superseded activation recipes, the old crypto-entry procedure,
  completed cleanup narratives and the historical WAL-canary table. Current entry scope, projection startup and
  retained archive ownership match source. Unique historical procedures remain linked at immutable Git revisions.
  README-only changes no longer select runtime qualification, native image builds or main image publication.
  Actual source and manifest changes still select their checks; all 64 affected-input tests pass.

### Accounting-hash release and final readback

Successful main run [42638085275](https://github.com/proompteng/lab/actions/runs/42638085275) publishes the native
and research images for `b3aa14bb383fb06bd5d95196e1aad63346f1a08c`. Both indexes and all four platform configs match
the exact source/run cohort. Freight `3676ecc891b9dc7d99d05b7bab82a48b30464036` reaches Argo through Kargo commit
`9f5a2983eb68752ed99a47eb9d0cf1ad70fcb739`. The native hook succeeds, both latest native services select
`dp_14mc4VooMcjbcrwhvtXOQa5`, and both native workers and both status replicas run the selected native digest.
At 16:16:29.910 UTC the active controller records a source-bound `SUCCESS` pass. The active account's transaction
count is 1,175 at the later readback, rather than the 1,133 observed before this release.

The first promotion fails at activation. Trace `1f8e0fdaf8eee6f10b1e6cc077ed7947` identifies the exact rejection:
broker order quantities and fill activities have not converged. HTTP reads succeed, but the observation cannot
publish; accounting verification has not run on that path. This proves the rejecting guard, not the underlying
provider disagreement's cause. After coherent observations publish through the existing quota-accounted runtime,
a retry of the same immutable Freight and unchanged reviewed Stage succeeds at 15:53:11 UTC. No consistency guard,
quota, deadline, authority or credential is bypassed, and no workload or storage is changed by hand.

The retained source-bound sample selects seven before and 21 after full-history passes on Altra. Both windows use
the same controller key, `Waiting` outcome and exactly one reconciliation and accounting verification. One before
`Completed` pass is excluded. After exclusions are two `Completed` passes and one `Waiting` pass with two full
verifications. All 32 retained ticks, including exclusions, have successful advance, reconciliation and accounting
span statuses with no exception events. The financial primary, archive primary, replica counts and claims are
unchanged at the captured boundaries.

| Inclusive stage median             | Before, ms | After, ms |
| ---------------------------------- | ---------: | --------: |
| Worker advance                     |  3,684.071 | 2,423.023 |
| Reconciliation                     |  2,941.412 | 2,060.458 |
| Persistence                        |  2,733.372 | 1,852.378 |
| Maximum writer-fence span per pass |  1,533.408 | 1,469.930 |
| Accounting verification            |    671.021 |   773.120 |

Accounting verification is slower in this production sample. The lower overall median is an observation across
different history, arrivals and load; it cannot be attributed to removal of a repeated hash. The isolated kernel
and SQL comparisons establish less work for their measured inputs. These live samples do not establish a causal
production improvement or an eligible-entry latency distribution. Nested durations must not be added together.

A natural filled request on this release is observed at 16:06:02.329 UTC. Its batch and document hash match native
trace `ae9a9acaf7f08fe416da593eb6812068`, pinned to the exact new deployment on Altra. It uses v40 / Jev 1.14.0 and
the compact planner representation. CHART claim to receipt takes 637 ms, its evaluation receipt interval 1,146 ms,
intent to submit-start 6,225 ms, and acknowledgement 655 ms. The advance takes 12,912.557 ms, including decision
construction 2,528.305 ms, binding 1,806.172 ms, committed-decision reading 1,324.318 ms and submission 742.313 ms.
This advance contains no full reconciliation span. The earlier filled request has two candidate requests and a full
reconciliation; this one has three candidate requests. Their elapsed times therefore do not form a matched full-path
benchmark. Two BUY fills have two balanced posted receipts; they are observed at 16:06:23.689 UTC, with recovery
recorded at 16:06:28.676. The cycle remains active at this capture. A filled intent does not establish a completed cycle.
The request's inference expiry and the protected decision's submission cutoff are distinct contracts.

An additional before entry at 14:40:12.444 UTC matches the later entry's three-candidate batch, v40 protocol,
Jev 1.14.0 model, input schema, Altra node and `Waiting` worker outcome. Trace
`0e4ec6b69b5f2e65566f1533a0bd44ac` matches its persisted batch and document identities through the exact old
Restate deployment. Both entries have two BUY fills and two balanced posted receipts. Their shared native entry
stages have successful span status and no exception events:

| Shared entry stage        | Before, ms | After, ms |
| ------------------------- | ---------: | --------: |
| Observation               |    255.062 |   643.686 |
| Batch plan                |    342.461 |   634.309 |
| Batch admission           |  2,419.035 | 1,243.359 |
| Batch completion          |  1,394.233 |   796.500 |
| Decision construction     |  1,331.522 | 2,528.305 |
| Decision / intent binding |    775.256 | 1,806.172 |
| Committed-decision read   |    762.565 | 1,324.318 |
| Entry submission          |    576.905 |   742.313 |

Within each worker's clock, observation start through submission-span end takes 9,820.380/12,183.575 ms.
The protected documents contain 1,626,245/2,823,900 JSONB text bytes. This compares the same entry-stage shape,
with different input material, document sizes, times and load. It is one pair, not a latency distribution or a causal
benchmark. The complete advances take 12,577.188/12,912.557 ms, but only the before advance contains a full
reconciliation; those parent durations are not equivalent work. The later shared entry pipeline is slower in this
sample. Lower Waiting-pass medians do not establish faster trading requests.

Public collectors still have zero nonterminal invocations and the same two retained state rows and fingerprint.
The old stateless bootstrap registration still pins two workers despite zero nonterminal invocations. Its separately
reviewed retirement remains pending under the owning runbook. No retained records, registrations or volumes are deleted.

![Matched scheduled delay and active worker timing, on separate clocks](evidence/2026-11-08-current-waiting.svg)

The upper panel uses Restate's schedule records. The lower panel uses spans from the matched Bayn process, relative
to its own worker advance. This preserves causal correlation without assuming synchronized clocks across services.

![Measured complete reconciliation passes before and after the deployed cleanup](evidence/2026-11-09-cleanup-before-after.svg)

This comparison uses actual nested spans from one pass near each phase's advance median. Each panel has its own
process clock. The labels distinguish representative stage durations from the separately computed sample medians;
parent durations include their children. It does not contain an inference request or the subsequent hash candidate.

![Current v40 request with durable boundaries and native worker spans](evidence/2026-11-09-current-v40-request.svg)

The current request chart joins the actual batch and decision identities to a completed source-bound Restate tick.
Its two panels keep durable record boundaries separate from worker-relative span timing. `NO_TRADE` is a completed
strategy outcome; it supplies no evidence of a current order submission or broker fill.

![Current v40 filled entry through submission and recovery](evidence/2026-11-09-current-v40-filled-entry.svg)

This chart uses the deployed hash release. The [earlier cleanup-release filled chart](https://github.com/proompteng/lab/blob/55f1aad1e416e03ba4c3a7b9ce14ab2a20b7c4fc/docs/bayn/evidence/2026-11-09-current-v40-filled-entry.svg)
and [v38 illustration](https://github.com/proompteng/lab/blob/b3aa14bb383fb06bd5d95196e1aad63346f1a08c/docs/bayn/evidence/2026-11-09-historical-entry.svg)
remain available at immutable revisions.
Its broker source timestamps use a separate clock. The submitted order's BUY fills are separated from later protective
SELL fills that share its intent, and both document and strategy hashes retain their distinct correlation roles.

The full audit remains open for the explicitly unverified items above. Smaller bundles, a faster SQL query and green
tests do not establish a faster complete trading request or disposal authority for retained data.

## Findings and deletion decisions

| ID  | Priority | Evidence                                                                                                                                                                                                                                                                                                   | Decision and smallest responsible change                                                                                                                                                                                                                                                               | Acceptance evidence                                                                                                                                                                                                         |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | High     | A local build of the read-only API emits bytes from 512 Bayn inputs, including about 986 kB of migrations and execution/decision implementations. Its resources do not acquire mutation stores, but imports still pull them into the bundle.                                                               | Remove execution and migration imports from the status process's dependency closure. Give the existing read-only composition its own resource imports. Preserve its status contracts and accounting readback.                                                                                          | Compare emitted modules and bytes before and after; exercise health and status with the same durable evidence; prove mutation resources remain absent.                                                                      |
| B11 | High     | The status Deployment receives `bayn-db-app` and the broker credential secret also used by execution. `PostgresClientLive` defaults to a writable connection; the live `bayn_app` role can INSERT and UPDATE intents. Read-only behavior is enforced by application composition, not credential privilege. | Remove credentials/capabilities that status does not need. Reuse broker observations, narrow the status SQL identity, and verify every health/status reader before changing deployment wiring. Permission changes require a separately reviewed authorization decision.                                | Role grants, connection read-only enforcement, unchanged status/health behavior, and proof that status credentials cannot mutate trading state. This audit demonstrates excess privilege, not a remotely exploitable route. |
| B2  | High     | The single Nix image includes research and frozen-control executables, compiler dependencies, GEPA Python, Bun, Git, and registry tooling for every deployed role.                                                                                                                                         | Separate the required execution/status payload from research-only tools through the existing image build. Do not introduce another service or generic plugin system. Keep research reproducible in its owning workload.                                                                                | Inspect actual OCI contents and closure sizes, required commands, release receipts, and all role entry points. Local JavaScript bundle sizes alone do not measure this saving.                                              |
| B3  | High     | Every full reconciliation reads account-wide intents, receipts, fills, transactions, projected inventory, and TigerBeetle account history. Those reads and ledger verification occur while the writer transaction owns the fence.                                                                          | Eliminate repeated preparation and unnecessary SQL round trips first. Measure each historical read before designing incremental verification. An incremental path must verify corrections, missing records, unknown mutations, and the complete ledger; a short-lived unchecked cache is insufficient. | Representative history-size benchmarks, exact same discrepancies/accounting output, crash and correction tests, plus comparable live transaction timings.                                                                   |
| B4  | High     | `workerStreamingUniverse` always includes equity and crypto sources. Each physical execution worker creates its own projection and arrival capture, although new crypto entries are disabled. The live readback contained four execution Pods across two revisions.                                        | Remove work with no current entry or recovery consumer. First measure bytes and CPU by topic and worker role. Separate entry history from the minimal evidence needed to manage retained crypto positions. Do not drop their exits or quote requirements.                                              | Same equity decisions, unchanged crypto close/recovery behavior, complete required arrival evidence, and measured reduction per worker. Quantify overlapping captures before changing ownership.                            |
| B5  | Medium   | Retained decision documents occupy about 5.5 GiB, candidate observations about 4 GiB, and snapshot references about 880 MiB in the financial database. A 32-row historical sample expands to about 1.03 MB per decision document and 373 kB per candidate payload.                                         | Stop copying identical evidence into new document shapes where a verified content reference suffices. Trace every reader and canonical hash first. Preserve old immutable bytes and their readers. These sample sizes do not establish current v40 per-cycle growth.                                   | Reproduce identical decisions, risk inputs, report joins, request hashes, and recovery from referenced evidence; measure bytes and decoding time on new records.                                                            |
| B6  | Medium   | The financial database still contains 43 GB of native-arrival chunks. The dedicated arrival database contains 118 GB. The runtime requires the dedicated archive endpoint.                                                                                                                                 | Inventory capture ranges, manifests, exports, and research consumers. Remove obsolete write paths or duplicated future capture only after proving the consumer graph. Historical data deletion is a separate retention decision, not a performance fix.                                                | Exact capture/content-hash comparison and all dependent report/replay joins. No record is declared redundant merely because both databases contain arrival tables.                                                          |
| B7  | Medium   | Six 10 GiB claims from the older `drc-bayn-valkey` layout have no current Pod reference. The 2 GiB OpenCode state claim is also unmounted and explicitly retained in desired state.                                                                                                                        | Treat these as cleanup candidates, not empty disks. Verify former controllers, operator desired state, retained contents, and recovery obligations. Remove obsolete desired-state references before any separately authorized deletion.                                                                | Controller/claim/PV ownership and content readback. Keep the two mounted Valkey claims and all financial/ledger volumes.                                                                                                    |
| B8  | Medium   | The active strategy module and candidate persistence also contain repeated-momentum and ablation branches. The built API and execution outputs contain those implementations even though production selects `jev`.                                                                                         | Remove research strategy construction from the active trading composition. Keep shared arithmetic and the explicit research callers. This is a dependency-boundary change, not permission to delete control experiments.                                                                               | Bundle membership and runtime selection tests, plus matched-control and retained-evidence tests.                                                                                                                            |
| B9  | Medium   | A captured worker pass returned `Waiting`; the available waterfall has no inference or order submission. Its full Restate lifetime includes an unattributed interval before the attempt.                                                                                                                   | Complete request-level timing across admission, CHART, handoff commit, JEV, decision commit, submission, acknowledgement, and recovery. Separate scheduled delay from lateness. Reuse existing IDs and tracing.                                                                                        | A natural eligible-session trace joined to persisted receipts and broker outcome, including expired/rejected requests. Do not force a trade for a trace.                                                                    |
| B10 | Medium   | The architecture page described v20, Jev 1.13, a sixteen-plan search, and absent judgment thresholds. Current source uses v40, Jev 1.14 Box localization, two proposals, and 0.70 judgment gates. Deployment/service READMEs also accumulate many historical cutovers before current operations.           | Correct the architecture page and consolidate current operating instructions. Move unique historical explanations out of the current path; remove duplicate narrative after checking links. Retained financial schemas have a different retention requirement from obsolete prose.                     | Current source links, document-link checks, and review against the owning README and release contract.                                                                                                                      |

These findings are structural or directly observed. B3 identifies repeated account-history work, not a proven slow
database server. B4 identifies unconditional source acquisition, not a measured percentage of wasted traffic. B5 and
B6 identify retention and representation costs, not permission to erase evidence. No line-saving or speed-up estimate
is claimed before a concrete replacement and before/after measurement exist.

## What is actually present

The following counts describe non-generated TypeScript under `services/bayn/src`. Test support includes filenames
containing `.test.` or `.test-support`, and the `testing` directory. The other column means non-test source; it includes
research and retained readers and must not be read as code executed on each tick.

| Source owner                | Non-test files | Non-test lines | Test/support files | Test/support lines | Role                                                                               |
| --------------------------- | -------------: | -------------: | -----------------: | -----------------: | ---------------------------------------------------------------------------------- |
| Root modules                |             68 |         17,132 |                 76 |             32,882 | Entry points, contracts, status, configuration, telemetry, research commands       |
| `intraday-replay`           |             47 |         15,513 |                 70 |             24,052 | Historical simulator, latency/fill models, controls, backtests                     |
| `jev`                       |             81 |         14,844 |                 78 |             16,983 | Current and retained model inputs, charts, proposals, paid-call evidence           |
| `market-data`               |             57 |         12,617 |                 49 |             12,941 | Kafka, projection, feature contracts, snapshots, native arrivals, archive readers  |
| `execution`                 |             39 |         12,233 |                 25 |             14,377 | Authority, intents, mutations, risk boundaries, scheduling outcomes, writer fence  |
| `system-assessment`         |             58 |         12,139 |                 65 |             17,135 | Registration, historical reliability/economic assessment and evidence verification |
| `db`                        |             42 |         10,356 |                 46 |             21,884 | Persistence interpreters, financial reads, reconciliation, migration composition   |
| `observe-composition`       |             13 |          7,300 |                 10 |              3,672 | Recovery-first orchestration, decision construction and mutation interpretation    |
| `cycle`                     |             32 |          6,503 |                 20 |              5,993 | Durable lifecycle, source binding, terminalization and observability               |
| `broker`                    |             27 |          6,461 |                 20 |              7,822 | Alpaca reads, observation cache, mutation encoding and transport                   |
| `forward-performance`       |             21 |          6,449 |                 20 |              9,394 | Broker/accounting/evidence joins and costed performance reports                    |
| `composition`               |             12 |          2,800 |                 12 |              3,986 | Scoped resources, status and native runtime acquisition                            |
| `strategy`                  |             18 |          2,741 |                  7 |              1,586 | Shared strategy model and research controls                                        |
| `restate`                   |             11 |          2,254 |                 11 |              4,831 | Execution, broker observation, activation, and research service endpoints          |
| `simulation-reconciliation` |             11 |          2,101 |                  3 |                326 | Broker snapshot normalization and reconciliation orchestration                     |
| `target-planner`            |              5 |          1,482 |                  0 |                  0 | Funded position targets and executable deltas                                      |
| `ledger-plan`               |              6 |          1,427 |                  0 |                  0 | Deterministic accounting accounts/transfers and exact comparison                   |
| `research-inference`        |              8 |          1,249 |                  5 |                999 | Separately approved research inference workflow                                    |
| `accounting`                |              7 |          1,168 |                  4 |                954 | Fill, fee, cash-settlement and cost-basis math                                     |
| `reconciliation`            |              2 |          1,067 |                  2 |              1,363 | Pure comparison and historical accounting verification                             |
| `health`                    |              3 |            841 |                  1 |                112 | Health/readiness projection                                                        |
| `config`                    |              5 |            839 |                  1 |                 87 | Startup parsing and runtime/historical configuration                               |
| `opencode`                  |              3 |            627 |                  3 |                417 | Research-side gateway/configuration                                                |
| `ledger`                    |              2 |            320 |                  1 |                288 | TigerBeetle account-history reads and comparisons                                  |
| `testing`                   |              0 |              0 |                 20 |              1,698 | Shared test fixtures                                                               |
| **Total**                   |        **578** |    **140,463** |            **549** |        **183,782** | **1,127 TypeScript files**                                                         |

The service also has 189 migration modules and 42 TypeScript tools. `docs/bayn` contains 43 Markdown files before
this report. The large test count is not evidence of complete runtime coverage. It also is not a reason to delete
tests without understanding the financial or failure contract each one protects.

## Processes, owners, and shipped contents

| Process                           | Entry point                                                                                                                                  | Acquired capabilities                                                                       | Writes or side effects                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Public status API                 | [`index.ts`](../../services/bayn/src/index.ts), [`composition/read-only-status.ts`](../../services/bayn/src/composition/read-only-status.ts) | HTTP, PostgreSQL reads, broker observations, accounting health                              | Status/metrics responses; it does not acquire trading mutation stores          |
| Native execution endpoint         | [`restate-execution-server.ts`](../../services/bayn/src/restate/restate-execution-server.ts)                                                 | Restate identity validation, native runtime, broker observation runtime, expense projection | Authorized cycle/intent/mutation/accounting persistence and broker I/O         |
| Market projection thread          | [`market-projection-worker.ts`](../../services/bayn/src/market-data/streaming/market-projection-worker.ts)                                   | Kafka consumers, in-memory verified projection, dedicated arrival archive                   | Append-only arrival evidence, worker replies                                   |
| Broker observation virtual object | [`restate-broker-observations.ts`](../../services/bayn/src/restate/restate-broker-observations.ts)                                           | Broker reads, durable scheduling, Valkey materialization                                    | Cached observations; no order authority                                        |
| Activation job                    | [`restate-execution-activate.ts`](../../services/bayn/src/restate/restate-execution-activate.ts)                                             | Exact build/account/request verification, private controller endpoint                       | Reviewed same-account activation/deactivation and successor identity           |
| Independent research endpoint     | [`restate-research-server.ts`](../../services/bayn/src/restate/restate-research-server.ts)                                                   | Research approval, research database role, TypeSafe and object storage                      | Approved research receipts and separately enabled public-information captures  |
| Offline/report commands           | [`package.json`](../../services/bayn/package.json), [`nix/images/bayn.nix`](../../nix/images/bayn.nix)                                       | Command-specific retained inputs, archive reads, reports, control compilers                 | Research outputs and explicitly invoked reports; not native trading scheduling |

The local Bun 1.4.0 build emitted the following unminified outputs. The package requests Bun 1.4.2. These are diagnostic
source builds, not pinned release builds, OCI sizes or startup latency measurements. `nix develop` could not connect
to the local Nix daemon, so a pinned comparison remains pending. Compiler defines, version, and Nix closure
construction can change the final image bytes.

| Runtime output           |      Bytes | Bayn inputs contributing bytes |
| ------------------------ | ---------: | -----------------------------: |
| Status API               |  8,659,717 |                            512 |
| Execution endpoint       | 11,851,522 |                            546 |
| Market projection thread |  6,566,432 |                            259 |
| Research endpoint        | 10,080,048 |                            124 |

The status, execution, and projection outputs each include roughly 986 kB attributed to Bayn migrations. The first
two include repeated-momentum and entry-ablation implementations. These observations establish bundle coupling;
they do not mean status handlers execute a trade or run those migrations.

Reproduce the build inventory without touching `dist`:

```sh
bun build services/bayn/src/index.ts \
  services/bayn/src/restate/restate-execution-server.ts \
  services/bayn/src/market-data/streaming/market-projection-worker.ts \
  services/bayn/src/restate/restate-research-server.ts \
  --target=node --external tigerbeetle-node --external @platformatic/kafka \
  --outdir=/tmp/bayn-system-audit-bundles --metafile=/tmp/bayn-system-audit-metafile.json
```

### Dependency and authority map

```mermaid
flowchart LR
    Feed[Kafka raw bars, trades, quotes and features] --> Projection[Per-worker projection thread]
    Projection --> Arrival[(Dedicated native-arrival PostgreSQL)]
    Projection --> Worker[Recovery-first execution worker]
    Restate[Account-keyed Restate controller] --> Worker
    Poller[Restate broker observation owner] --> Broker[Alpaca through egress proxy]
    Poller --> Cache[(Valkey broker observations)]
    Cache --> Worker
    Worker --> PG[(Financial PostgreSQL)]
    Worker --> Jev[Jev CHART and final judgment]
    Worker --> Broker
    Worker --> TB[(TigerBeetle)]
    PG --> API[Read-only status API]
    Cache --> API
    TB --> API
    Research[Independent research and report commands] --> PG
    Research --> Arrival
    Research --> Archive[(ClickHouse archive and object storage)]
```

Restate owns account-key serialization, durable delivery and successor scheduling. PostgreSQL owns the transactional
writer fence, committed intents and mutation state. Neither replaces the other: a serialized handler can crash after
broker I/O but before its completion is durable. The recorded request identity and reconciliation resolve that gap.

## Entry request, step by step

| Step | Owning code                                                                                                                                                                                                 | Work and durable boundary                                                                              | Timing/concurrency                                                              | Failure behavior                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | [`restate-execution-controller.ts`](../../services/bayn/src/restate/restate-execution-controller.ts)                                                                                                        | Decode tick, verify key/revision/epoch/sequence and recorded controller state                          | One exclusive object handler per account; bounded recovery windows              | Foreign/stale work quiesces; accepted failures retain bounded recovery semantics              |
| 2    | [`native-execution-runtime.ts`](../../services/bayn/src/composition/native-execution-runtime.ts), [`advance.ts`](../../services/bayn/src/execution/advance.ts)                                              | Bind the process runtime, recover already projected completion, execute one pass                       | Process-scoped resources; one bounded advance                                   | No new receipt is fabricated for an unfinished pass                                           |
| 3    | [`recovery-driver.ts`](../../services/bayn/src/observe-composition/recovery-driver.ts)                                                                                                                      | Recover pending cancellation/submission and obtain fresh exact reconciliation                          | Existing narrow reuse is authority-, freshness-, and state-bound                | Unknown mutations and discrepancies block new exposure                                        |
| 4    | [`streaming/worker.ts`](../../services/bayn/src/market-data/streaming/worker.ts), [`streaming/service.ts`](../../services/bayn/src/market-data/streaming/service.ts)                                        | Read verified projection, original arrival references and source-bound completed bars/quotes           | Ingestion runs in a separate thread; replacement workers warm before activation | Missing/late candidate evidence remains an exclusion; invalid global evidence fails admission |
| 5    | [`candidate-observation-postgres.ts`](../../services/bayn/src/db/candidate-observation-postgres.ts)                                                                                                         | Reproduce candidate observation and bind source/account/reconciliation identities before insertion     | Financial database durability precedes strategy authority                       | Hash/source/readback mismatch fails closed                                                    |
| 6    | [`entry-proposals.ts`](../../services/bayn/src/jev/entry-proposals.ts)                                                                                                                                      | Check whether source prices and fees permit any funded proposal                                        | Pure fixed-point arithmetic; skip paid work when source-infeasible              | No affordable plan means no paid final judgment and no entry                                  |
| 7    | [`entry-inference-batch.ts`](../../services/bayn/src/jev/entry-inference-batch.ts)                                                                                                                          | Persist CHART claim, then ask structure presence and source-image Boxes                                | Candidate pipelines run concurrently; share original evidence deadline          | Cancellation, late results and unknown consumption retain receipts/cost uncertainty           |
| 8    | Same module plus [`entry-inference-postgres.ts`](../../services/bayn/src/db/entry-inference-postgres.ts)                                                                                                    | Map valid source anchors, construct proposals, atomically commit CHART terminal and final-call handoff | Each ready candidate may advance before other CHART calls finish                | No final paid dispatch before its handoff commits                                             |
| 9    | [`entry-questions.ts`](../../services/bayn/src/jev/entry-questions.ts)                                                                                                                                      | Ask setup confirmation and stop invalidation, then select an eligible proposal                         | Both judgments must be at least 0.70; no fresh ten-second budget                | Uncertain, invalid or expired evidence cannot become an approved trade                        |
| 10   | [`decision-builder.ts`](../../services/bayn/src/observe-composition/decision-builder.ts), [`target-planner`](../../services/bayn/src/target-planner/index.ts), [`risk.ts`](../../services/bayn/src/risk.ts) | Construct target, whole-share delta, risk decisions and immutable decision evidence                    | Prices, fees, quantity and limits remain code-owned                             | A model answer does not override capital, liquidity, exposure, turnover, loss or cutoff gates |
| 11   | [`cycle/store/postgres.ts`](../../services/bayn/src/cycle/store/postgres.ts), [`execution/coordinator.ts`](../../services/bayn/src/execution/coordinator.ts)                                                | Commit approved intent, deterministic client ID and canonical request, then `SUBMIT_STARTED`           | Recheck current gates immediately before broker I/O                             | Unknown submission blocks exposure and uses deterministic lookup; no blind POST retry         |
| 12   | [`execution-cycle.ts`](../../services/bayn/src/observe-composition/execution-cycle.ts)                                                                                                                      | Manage protection, residual inventory, close and later exact reconciliation                            | Acknowledgement is distinct from fill and terminal flat completion              | An incomplete/partial/ambiguous close remains incomplete                                      |
| 13   | [`native-execution-runtime.ts`](../../services/bayn/src/composition/native-execution-runtime.ts), Restate controller                                                                                        | Project pass receipt, advance sequence and schedule one successor                                      | The persisted due time includes projection/journaling elapsed time              | A projection failure is not silently reported as completed execution                          |

```mermaid
sequenceDiagram
    participant R as Restate
    participant W as Execution worker
    participant P as Financial PostgreSQL
    participant J as Jev
    participant B as Broker
    R->>W: Account-keyed tick
    W->>W: Recover unresolved work and reconcile
    W->>P: Persist verified observation and CHART claim
    W->>J: CHART image and verified source context
    J-->>W: Presence judgments and source Boxes
    W->>W: Map anchors and construct funded proposals
    W->>P: Commit CHART terminal and final-call handoff
    W->>J: Setup confirmed and stop invalidates?
    J-->>W: Typed judgments
    W->>W: Select plan, calculate quantity and check risk
    W->>P: Commit decision, approved intent and SUBMIT_STARTED
    W->>W: Recheck current authority, quote and deadline
    W->>B: Native LIMIT/DAY bracket
    alt Known response
        B-->>W: Accept or reject
        W->>P: Persist known outcome
    else Ambiguous response
        W->>P: Record UNKNOWN
        W->>B: Read by deterministic client order ID
    end
    Note over W,B: Later passes reconcile fills, protection, exit and accounting
    W-->>R: Persisted pass receipt and next due time
```

## What the strategy actually decides

The active contract is `bayn.jev.protocol.v40`, model `jev-1.14.0`, numerical input v24, batch v8, entry input v8, and
handoff v5. New entries permit equities only. Retained crypto positions continue through the existing risk-reducing
exit and reconciliation path. Research supports additional policies; they are not selected native entry strategies.

| Decision                  | Source rule                                                                           | Code-owned arithmetic                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Support identification    | Most recent defended support below bid, with a rebound after testing                  | Map a valid Box to original candle IDs; do not accept a falling newest low merely as support         |
| Resistance identification | Nearest identifiable observed overhead resistance                                     | Use the source resistance candle's high, not a model-generated price                                 |
| Base identification       | At least two overlapping completed candles; exclude newest candle; no source-time gap | Derive the full high/low range from original candles                                                 |
| Support recovery proposal | Requires usable support and resistance, followed by recovery confirmation             | Stop rounded below support low; target rounded below observed resistance high                        |
| Base breakout proposal    | Requires coherent base, bid above base high, and acceptance above the base            | Stop rounded below base low; target is `2 * high - low`, rounded down                                |
| Funding                   | Acquisition and modeled exit fees must be supportable                                 | Fixed-point price/quantity/fee arithmetic; target net covers acquisition and stop net is below it    |
| Final judgment            | Setup confirmation and stop invalidation both at least 0.70                           | Rank eligible proposals by the lower judgment, then lower modeled stop loss, then stable proposal ID |
| Position                  | At most one long, up to 20% gross and per-symbol equity weight                        | Further bounded by actual account/risk/liquidity/turnover limits                                     |
| Time                      | First completed equity minute plus two seconds; no extra clock warmup                 | Original ten-second inference validity; ten-second quote age; fifteen-minute maximum hold            |
| Session end               | Entries stop and flattening starts five minutes before actual close                   | Reconcile residual inventory and order state; an unfilled close is not a completed close             |

Selection has two levels. [`selectSupportedEntryProposal`](../../services/bayn/src/jev/entry-questions.ts) selects a
proposal within each symbol. [`selectJevEntryCandidates`](../../services/bayn/src/jev/decision.ts) then ranks symbols by
the same minimum judgment, lower absolute modeled loss, and finally symbol name. It takes only `maximumPositions`,
currently one. It does not rank by estimated net return, return per unit risk, or a calibrated win probability.

Parallelism also has two boundaries. A candidate's final JEV can overlap another candidate's CHART, but the evaluator
still settles the batch before deriving the portfolio target. A fast candidate does not immediately become an order.
The benefit and cost of scoring the entire candidate set for one position must be measured using dispatch counts,
paid unsuccessful calls, tail latency, and costed matched controls. Pruning candidates or taking the first completed
answer changes the selection policy; it is not a free concurrency optimization.

The 0.70 threshold, source selection, and target construction are policies, not proof of an economic edge. A useful
strategy breakdown must join each setup's candidates, exclusions, source feasibility, CHART outcomes, final judgments,
risk denials, submissions, fills, exits, and all costs. Existing reporting and control code should supply that evidence
before adding another strategy or changing thresholds. No new profitability result was calculated in this audit.

## Reconciliation and accounting in detail

[`broker-reconciler-program.ts`](../../services/bayn/src/simulation-reconciliation/broker-reconciler-program.ts) reads
a stable broker snapshot, then normalizes and persists it. Broker observations may come from the required Valkey
materialization; this does not imply a complete broker HTTP poll on every worker pass.

The persistence path does the following:

1. Acquire the writer transaction and account advisory lock.
2. Recover already committed, pending cash/fee postings before ingesting new fills.
3. Ingest account/position/order events, account incomplete fills, and value the account.
4. Prepare cash settlements, observed coin fees, fee activities, and cash-fee accruals.
5. When no new posting is needed, finalize verification in the same transaction using a savepoint. Otherwise commit
   preparation and run the posting/verification transaction separately.
6. Read intent expectations and broker-generated protection children.
7. Reconstruct accounting history, decode receipts and reproduce expected plans.
8. Query TigerBeetle accounts/transfers and compare complete expected records.
9. Read durable fills and aggregate inventory/cost basis; compare broker cash, positions, orders, fees and receipts.
10. Persist exact reconciliation or its discrepancies, restrict authority when needed, and derive current risk context.

The savepoint and two-phase posting paths exist because PostgreSQL and TigerBeetle do not share a transaction. They
cannot be replaced by a generic retry without risking duplication or erasing prepared financial evidence.

The expensive repeated work is visible in [`db/reconciliation.ts`](../../services/bayn/src/db/reconciliation.ts):
`readAccountingPhase` selects all account intents with lateral mutation lookups, `readAccountingHistory` reconstructs
the account's transactions, receipt reads cover the account's transaction history, and `readComparisonPhase` reads all
durable fills and aggregates inventory. [`ledger.ts`](../../services/bayn/src/ledger.ts) assembles the complete expected
account plan and [`ledger/account-read.ts`](../../services/bayn/src/ledger/account-read.ts) paginates ledger records.

This scales with accumulated history, not just changes since the previous pass. The observed account has approximately
851 fills/transactions, 966 receipts and 687 intents according to PostgreSQL statistics. These are approximate table
counts, not trading results or a claim about today's fills. Measure realistic larger histories before selecting a
replacement; preserve full verification and test unexpected extra ledger records, corrections and incomplete postings.

## Measured request timing

The retained trace is `68fb4647c96b52673b880b64678bfc0`, captured November 8 at 14:18:39 PST on source
`1a291e1ad1ce0931efa307b0090df3080ec7379b`. It predates the source audit baseline. Its outcome was `Waiting`; it has
no CHART, JEV, or broker order submission. It is a reconciliation example, not an entry latency benchmark.

![Measured worker waterfall with nested span offsets and inclusive durations](evidence/2026-11-08-execution-waiting.svg)

| Span                       | Start relative to worker pass, ms | Inclusive duration, ms | Interpretation                                                       |
| -------------------------- | --------------------------------: | ---------------------: | -------------------------------------------------------------------- |
| Worker advance             |                             0.000 |              1,161.319 | Complete measured worker pass                                        |
| Reconciliation             |                            12.054 |                936.041 | Includes broker observation and persistence                          |
| Broker observation         |                            12.076 |                117.127 | Includes cached observation materialization                          |
| Valkey GET                 |                            16.300 |                 16.269 | Nested cache operation                                               |
| Reconciliation persistence |                           129.282 |                818.799 | Includes preparation, accounting and transaction work                |
| Writer transaction         |                           204.561 |                743.102 | Application work inside a transaction, not pure SQL or fsync latency |
| Valuation                  |                           236.071 |                148.858 | Nested persistence operation                                         |
| Accounting verification    |                           578.032 |                296.125 | Includes history preparation and ledger requests                     |
| Ledger comparison          |                           874.207 |                 58.162 | Nested comparison work                                               |
| Alpaca market calendar     |                           952.717 |                203.650 | Request-to-headers accounts for 202.740 ms                           |

Nested inclusive times cannot be added. The complete captured Restate lifecycle spans 31,141.838 ms. The
`invocation-start` span lasts 25,972.502 ms before the attempt begins. Its cause is unassigned by this trace.
The controller intentionally schedules delayed ticks; the interval must be joined to its due time before calling
it scheduling lateness. The trace is not evidence of a 31-second model call or slow storage.

The [sanitized timing data](evidence/2026-11-08-execution-waiting.json) retains the span hierarchy. A bounded 48-hour
inference trace search in the preceding investigation found no inference-containing trace. Missing search results do
not prove that no inference occurred. A natural-session CHART/JEV/order waterfall and representative latency
distribution remain unverified.

## Data and infrastructure inventory

Read-only Kubernetes and PostgreSQL inspection succeeded during this audit. The financial size/statistics query ran
on `bayn-db-1`, a replica; the 88-table and connection inventory was confirmed on primary `bayn-db-2`. The native
archive query ran on primary `bayn-native-arrival-db-1`. Statistics are approximate and measurements are time-bound.
Later Kubernetes API requests timed out and were stopped. They did not produce newer payload samples. A subsequent
bounded retry restored catalog/workload inspection; the inventories include its own capture timestamps. The failed
recent-payload samples were not treated as successful measurements.

The complete catalog includes all table columns and index definitions. The status Deployment's financial database
secret refers to the `bayn_app` owner configured by the CNPG bootstrap. Read-only privilege inspection confirms that
role can insert and update `intents`. The current application avoids mutation by composition; it does not have a
database privilege boundary equivalent to that read-only purpose.

| Store                        | Observed size or allocation                                         | Consumer and retention boundary                                                             |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Financial PostgreSQL         | 57 GB logical database; two 100 GiB data and two 32 GiB WAL claims  | 88 user tables; durable financial state, decisions, inference receipts, historical arrivals |
| Dedicated arrival PostgreSQL | 118 GB logical database; two 200 GiB data and two 32 GiB WAL claims | Four tables; 29 epoch rows estimated; source-arrival replay and evidence                    |
| TigerBeetle                  | Three members with 100 GiB claims each                              | Exact cash, fees, cost basis, realized P&L; this audit did not measure file occupancy       |
| Valkey                       | Two mounted 10 GiB claims                                           | Broker observation materializations; cache availability/freshness is part of admission      |
| Older Valkey claims          | Six unmounted 10 GiB claims                                         | No current Pod references; retained contents and former controller ownership not audited    |
| OpenCode retained state      | One unmounted 2 GiB claim                                           | Explicitly retained desired state; no current Pod consumer observed                         |
| ClickHouse                   | Not sized in this audit                                             | Read-only market archive and report/replay input                                            |
| Object storage               | Not sized in this audit                                             | Backups, research captures and report artifacts                                             |
| Restate                      | Shared platform storage not sized in this audit                     | Invocation journal, virtual-object state, delayed delivery and retries                      |

Largest financial relations, including indexes and TOAST where applicable:

| Relation                            | Observed total size | Approximate live rows | Purpose                                       |
| ----------------------------------- | ------------------: | --------------------: | --------------------------------------------- |
| `native_arrival_chunks`             |               43 GB |             1,788,824 | Historical compressed arrival evidence        |
| `autonomous_cycle_shadow_decisions` |            5,654 MB |                11,772 | Immutable bound decision documents            |
| `intraday_candidate_observations`   |            4,047 MB |                16,926 | Verified candidate inputs/decisions/manifests |
| `streaming_snapshot_references`     |              880 MB |                12,161 | Snapshot provenance references                |
| `broker_events`                     |              668 MB |               223,038 | Observed broker event history                 |
| `jev_evaluation_requests`           |              526 MB |                41,146 | Original request evidence                     |
| `jev_batch_plans`                   |              476 MB |                16,798 | Batch identity and candidate evidence         |
| `execution_controller_observations` |              342 MB |                13,844 | Retained controller pass/status observations  |
| `position_snapshots`                |              229 MB |               215,465 | Reconciled inventory observations             |
| `inference_expense_quotes`          |              188 MB |                78,927 | Inference expense evidence and pricing        |
| `execution_unit_cutover_archive`    |              182 MB |               198,858 | Retained cutover records                      |
| `valuations`                        |              176 MB |               215,465 | Account valuation history                     |
| `reconciliations`                   |              138 MB |               224,991 | Financial comparison receipts                 |

The native archive's chunk relation accounts for approximately its entire 118 GB. Its chunks are compressed and
hash-chained; epoch identity includes source build and consumer bootstrap. Repeated market bytes across workers do
not automatically mean interchangeable evidence because original availability time and consumer epoch matter.

Observed compute consisted of two status Pods, four execution Pods across two revisions, one research Pod, two
egress proxy Pods, two telemetry Pods, four PostgreSQL Pods, three ledger Pods, and two Valkey Pods. A source rollout
can retain predecessor workers while the replacement pool warms. This snapshot alone does not establish abandoned
workers or excessive steady-state replicas.

## Research, assessment and retained contracts

| Area                                    | Current purpose                                                                                                 | Keep, isolate, or remove                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intraday replay and broker simulation   | Reproduce arrival ordering, fills, latency, partial fills, cancellations, controls and economics                | Keep the execution model and evidence checks; isolate offline payload from status/trading images where practical                                                                          |
| System assessment                       | Register immutable configuration, account for full observation windows, verify historical reliability/economics | Keep distinct from capital authority; remove duplicated current descriptions rather than weakening gates                                                                                  |
| Repeated momentum and entry ablation    | Mechanical comparison/control paths                                                                             | Keep explicit research consumers; remove their construction branches from the native strategy composition                                                                                 |
| Frozen control compiler                 | Comparable baseline independent of current implementation                                                       | Preserve exact compiler/source identity; isolate from trading runtime payload                                                                                                             |
| GEPA and instruction variants           | Paid, approved prompt/instruction research                                                                      | Research-only dependency; not required to execute a native tick                                                                                                                           |
| Public information                      | Independently scheduled SEC and macro captures with object-storage evidence                                     | No active Jev/strategy input reference was found in the searched owning directories. Attribute its costs and research consumers separately; do not describe it as required entry evidence |
| Webull archive/research                 | Source comparison and retained context                                                                          | Separate ingestion entitlement/arrival evidence from research usefulness                                                                                                                  |
| Retained v24-v39 and Jev 1.13 contracts | Decode/reproduce old paid and financial evidence                                                                | Keep necessary immutable readers; new execution accepts v40 only                                                                                                                          |
| Historical BASE_START                   | Original staged-call/cost accounting                                                                            | Already retired for new v40 requests. Do not report its retirement as unfinished cleanup                                                                                                  |

## Removal order and proof required

1. Remove stale current-architecture statements and publish this source/consumer inventory.
2. Shrink the status process dependency closure. Preserve existing response and authorization behavior.
3. Shrink the deployed runtime payload using the existing build and release machinery; retain reproducible research
   in its own workload. Measure OCI closure and runtime behavior before calling this a startup improvement.
4. Attribute reconciliation time, then remove repeated work with regression evidence for accounting and recovery.
5. Attribute continuous capture by market, source revision and worker. Reduce unused acquisition only with explicit
   entry/recovery requirements and original-arrival proof preserved.
6. Replace redundant future evidence copies with verified references, changing all writers/readers/contracts together.
7. Review retained data and unused claims separately. Capacity reclamation must not be bundled with latency work.

This ordering yields independently reviewable changes. It avoids a storage migration, a framework rewrite, a new
scheduler, a new caching layer, a strategy expansion, or relaxed financial controls as a substitute for evidence.

## Original audit verification boundary

Completed: tracked-file inventory, four actual bundle builds and module attribution, critical source-path review,
current protocol/proposal/risk/submission/recovery ownership review, read-only cluster inventory, read-only database
size/statistics/sample queries, and comparison with the retained trace. Documentation links and formatting are
validated as part of this change.

Not established: a line-by-line audit of every source/test/migration, live request-to-fill latency, the cause of the
pre-attempt interval, current v40 document growth, historical capture equivalence, safe deletion of any volume,
ClickHouse/object-store occupancy, complete strategy profitability, or a measured speed-up. Full trading/ledger tests
were not run for this documentation-only change; no executable path was changed. The file inventory is a coverage
map, not a claim that every listed implementation has passed a correctness audit.
