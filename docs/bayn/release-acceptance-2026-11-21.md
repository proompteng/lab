# Bayn release acceptance — November 21, 2026

This is the release evidence companion to the [profitability and reliability investigation](session-investigation-2026-11-20.md). All times below are UTC. It separates completed CI, published artifacts, observed deployed behavior and financial qualification.

## Current source completion status

[PR #16145](https://github.com/proompteng/lab/pull/16145) merged at **16:49:54 UTC** as `2311bf59f2276441cb85ed3133cfe3118eb5484f`, after exact reviewed head `c9c7463d` reached **40 successful checks, 31 skipped checks and no pending or failed checks**. Both native architecture jobs passed all **30 assertions**. The [final source acceptance](#c9-final-source-acceptance-and-squash-merge) and adjacent evidence bundle retain the exact-head approval, guarded merge and independent post-squash source proof.

Normal OpenCode publication and live acceptance for `2311bf59` remain **pending**; the consolidated Bayn publisher has **not yet been exercised live**. Earlier pending, held and failed observations below remain dated historical cuts. Source acceptance does not establish a startup root-cause correction, measured performance gain or improved profitability.

## Financial result and decision boundary

The original November 16–20 PAPER cohort contains 863 fills and 169 flat-to-flat episodes. After the later canonical settlement, gross realized trading was -$1,352.00 and posted broker fees were $64.03. The broker cash change was therefore **-$1,416.03**; subtracting the original-cut known inference estimate gives **-$1,417.717284228**. Unknown earlier usage and unallocated infrastructure, data and research expense remain unresolved. This is a known-cost result, not fully costed net profit.

The [settlement addendum](session-investigation-2026-11-20.md#later-fee-settlement-and-runtime-recovery--november-21-2026) and its [bounded read-only SQL](sql/fee-settlement-2026-11-21.sql) retain the financial cut, accounting reconciliation and automatic PAPER-authority recovery. Operational readiness does not qualify the strategy economically. No new order, paid inference, mandate, assessment or registration was issued by this investigation.

### Current v41 profitability correctness cross-check

The [bounded source cross-check](bayn-v41-source-profitability-crosscheck-20261121.json) found no reproducible mechanical profitability defect in the inspected paths. It reviewed main source `78dc7bd3d3b6b8a3f6d76ec72f81b4c4520a42b3`; all **33 inspected production files** have identical Git blobs in the releasing source `6d6600bd98ca3f0a434cd8f104369a6fa552deef`. Against previously deployed `c217c1ddcce8f87d6c4306de27a1894cf8afe4ec`, 32 files match; the remaining difference is the comment and exported frozen v37 parameter hash in `jev/protocol.ts`, without a current v41 behavior change.

| Boundary                  | Source finding                                                                                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry and exit direction  | Signed quantity changes select the appropriate order side; buys use asks and sells use bids. A zero target sells long inventory or buys to cover short inventory.                                                                                                                                    |
| Stop and target direction | Long and short plans enforce their respective ordered stop/entry/target prices. Management uses bid prices for long liquidation and asks for short covering; refreshed entries already crossing a stop or target are rejected.                                                                       |
| Units and rounding        | Trade-price and modeled-fee arithmetic use micro-USD, and quantity uses 1,000,000,000 atoms per share. Entries floor to whole shares within the original funded quantity. Notional and broker-tick rounding preserve the specified buy ceiling or sell floor.                                        |
| Modeled fees              | Acquisition, sale and cover calculations apply each modeled fee leg once. Conservative long liquidation substitutes a linear bound plus rounding reserve for stepped variable fees; it does not add both estimates as separate charges. These planning calculations do not post accounting expenses. |
| Event time                | Original batch/admission expiry is checked around refreshed pricing. Quote event time remains bound to its snapshot, and the holding interval starts at the first actual fill.                                                                                                                       |
| Profit-exit limits        | Long profit exits retain their target floor; short profit covers retain their target ceiling. Existing stop-crossing or first-fill holding-deadline conditions release those restrictions.                                                                                                           |

The prior observed-row checks remain separate evidence: all 169 retained episodes respected original entry bounds and realized gross-loss limits within their original modeled stop budgets. This source pass did not replay new historical rows or establish causation for every November 16–20 source revision.

A fee-inclusive positive modeled target and a possible modeled stop loss do not establish positive expected profit. The structural judgment threshold is not a calibrated probability of reaching the target before the stop. The retained cohort therefore still establishes poor observed economics; this review supplies no source-supported parameter or strategy correction. It adds no execution test, provider call, assessment, registration or financial action.

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

### Later native startup failures and bounded diagnostics

The same production recovery code later failed the initial native readiness gate on ARM in [PR #16145 workflow 44899257107](https://github.com/proompteng/lab/actions/runs/44899257107/job/136831502444), source `a53de4ffc1ac310118f57d5f722dc8968ca07e4e`. At **11:48:35 UTC**, the phase had spent **25,030 ms** awaiting readiness: 23 native requests, zero HTTP responses, two transport errors and 20 cancellations. The owned process handle had been acquired at 79 ms. There were zero provider calls, native session creations or native operations. The test ended after 47,845.50 ms, including failure cleanup. This is the initial 25-second boundary, not the outer 90-second ceiling.

| Source and platform | Initial readiness | Restart readiness | Result |
| ------------------- | ----------------: | ----------------: | ------ |
| a53de4f ARM         |         25,030 ms |       Not reached | Failed |
| a53de4f AMD         |         21,090 ms |          1,210 ms | Passed |
| 13ea59c AMD         |         25,011 ms |       Not reached | Failed |
| 437355b ARM         |         24,507 ms |          1,232 ms | Passed |
| acc115c ARM         |         18,997 ms |          1,240 ms | Passed |

The [investigation bundle](bayn-native-startup-investigation-20261121.json) retains the failure receipt, full-log comparison, Nix dependency boundary, pinned bootstrap trace and local observations with original hashes. Twelve relevant native packaging, server, configuration and test files are byte-identical across a53de4f, acc115c and the releasing 6d6600 source. The available passing and failing logs share the download-buffer warning and overlapping independent tool copies; those observations do not establish causation. The pinned server installs the authenticated information route before asynchronous application initialization; cancelling an individual readiness probe does not cancel global bootstrap. Synchronous database initialization could block its event loop, but the failed ARM log has no measurements that attribute the stall to that mechanism.

A single corrected local observation used the exact Node HTTP layer, fresh isolated state, the pinned x64 native package and production server code. Native HTTP 200 headers arrived at 232 ms and gateway readiness at 1,227 ms, with no provider or non-info native operations. The different architecture and loader make this a local mechanism check, not a Nix ARM reproduction. The earlier invocation used the wrong HTTP client layer; its result is excluded, and it may have warmed binary pages. Neither run establishes a cold-start improvement. Both original executions remain in the [exact source and command provenance](bayn-native-local-diagnostic-provenance-20261121.json). The local sampler's child-count field conflates unavailable reads with empty lists, so no descendant-absence conclusion is supported. The corrected run's owned PID was absent and its isolated state removed after cleanup; its interrupted exit observer did not supply an exit code.

PR #16145 first added failure-only CI diagnostics at `13ea59cbabec32a5560ec0e52f543749166c9c8d`. The helper performs at most five bounded process-file reads, checks the owned child's identity before and after collection, and emits allowlisted numeric fields or explicit unavailability. Its 200 ms capture budget sits inside a 250 ms observation budget; capture and logger failures preserve the original failure. Successful startup performs no diagnostic reads. The original one-second probe, 25-second readiness gate, 90-second test ceiling, 25-second shutdown grace and all native assertions remain unchanged. This adds evidence and does not establish or repair the timeout's cause.

The historical [validation and recovery receipt](bayn-native-diagnostic-validation-20261121.json) for that recovered helper records **36 focused tests / 70 assertions**, both TypeScript configurations, formatting, both lint modes and the production build passing. A broad local run reached its **900-second execution-wrapper limit** after 5,350 recorded passes, 1,318 skips and zero reported failures across 446 observed test files, without a terminal test summary. It is incomplete, not a passing suite; the native binary was not configured for that run. Its raw logs and the original unpushed commit were lost in the backend replacement. The four reviewed source files were recovered byte-for-byte, verified against their original Git blobs and SHA-256 values, committed with normal hooks, and pushed without force to the existing PR. The retained tool results support the reconstructed validation record, which explicitly marks the missing raw logs. The subsequent AMD CI failure and the corrected diagnostic rendering are recorded separately below.

### AMD recurrence and diagnostic rendering correction

At source `13ea59cbabec32a5560ec0e52f543749166c9c8d`, [AMD native job 136852001209](https://github.com/proompteng/lab/actions/runs/44906136152/job/136852001209) again reached the unchanged initial-readiness limit: **25,011 ms**, 22 requests, zero HTTP responses, one transport error and 20 cancellations. The owned process handle was acquired at 25 ms. The failure-only capture took **5 ms** and reported top-level AVAILABLE, but the default console rendered every nested measurement section as `[Object ...]`. Consequently, that log retains no readable CPU, I/O, memory or scheduler counters, and no nested availability can be inferred. The test ended after **35,492.93 ms**, including cleanup, with zero provider calls, native sessions or native operations. The Nix image job failed after this mandatory native test; the retained evidence does not demonstrate an import or packaging defect.

The correction at `7a60a9e32489e3b033685ffe26e7e85f28ea6316` serializes the existing allowlisted diagnostic record as one JSON message inside the protected observation. A regression using ordinary Bun child processes and the actual default console reproduced the two collapsed-output failures before the change; both children exited normally, and the assertions failed on the elided measurements. After the correction, available and unavailable fixtures preserve every expected leaf value and reason. Mocked process data was used; these formatter fixtures launched no native OpenCode process.

Final focused validation passed **39 tests / 85 assertions**, including preservation of the original failure when serialization or logging throws. Both canonical TypeScript projects, formatting, both lint modes, the production build and normal commit hooks passed. Independent and root reviews bound the exact three-file correction to its Git blobs; the native integration test stayed byte-identical. The one-second probe, 25-second readiness gate, 90-second test ceiling, 25-second shutdown grace and diagnostic capture bounds are unchanged. The broad local suite was not repeated. **This fixes diagnostic retention; the native readiness cause remains unresolved.**

The [follow-up evidence bundle](bayn-pr16145-followup-acceptance-20261121.json) preserves the AMD failure block and raw-log hash, the real-console red/green evidence, exact source identities, static-command receipts, independent verification and the current-main composition check. The subsequent exact-head CI result and its complete process measurements are recorded below.

### Native recurrence with complete process measurements

Normal CI on exact head `7a60a9e32489e3b033685ffe26e7e85f28ea6316` ended with **38 successful checks, one failure and 25 skipped checks**. The ARM native job succeeded at **14:06:32 UTC**; [AMD job 136858850647](https://github.com/proompteng/lab/actions/runs/44908364291/job/136858850647) failed at **14:10:56**. Root independently checked the PR and workflow heads, all terminal job projections and the retained failure log. PR #16145 remains held.

The AMD failure again occurred at initial readiness: **25,010 ms**, 22 native requests, zero HTTP responses, one transport error and 20 cancellations. The owned process handle was acquired at 25 ms. Provider calls, native sessions and native operations remained zero. The original 25-second `TimeoutError` was preserved; scope failure followed the assertions-failed record by approximately **3,589 ms**, and the native test ended after **28,612.81 ms**.

The corrected logger retained the complete JSON record on raw-log line 681. Capture took **5 ms**, with every subsection AVAILABLE and the owned PID, parent PID and kernel start time verified across collection. These are sequential readings rather than an atomic snapshot:

| Measurement                                        |           Recorded value | Interpretation boundary                                                                           |
| -------------------------------------------------- | -----------------------: | ------------------------------------------------------------------------------------------------- |
| Main-task state                                    |                      `D` | Uninterruptible sleep at the process-stat observation; no wait duration or operation was captured |
| Process CPU                                        | 32 user / 3 system ticks | Raw cumulative ticks; clock-tick frequency was not observed                                       |
| Process threads                                    |                        6 | Count at collection                                                                               |
| Main-task scheduler runtime                        |            147.402166 ms | Cumulative main-task accounting; not all six threads                                              |
| Main-task run-queue delay                          |              0.059120 ms | Cumulative accounting; does not rule out all throttling or other contention                       |
| Process-and-waited-children storage writes / reads |      5,312,512 / 0 bytes | Accounting totals; not I/O latency, physical completion or absence of filesystem waits            |
| Resident / peak resident memory                    |    143,072 / 143,072 KiB | Approximate point values, without a contemporaneous resource limit or pressure observation        |

This establishes an uninterruptible main-task wait at the failure instant. It does **not** attribute that wait to SQLite, `fsync`, a filesystem, Ceph or Attic, and prior failures lack comparable nested measurements. The complete log contains **73,426 bytes / 835 lines**, without download truncation; root verified its SHA-256, the exact JSON line and every retained startup/cleanup line.

### Bounded kernel-wait diagnostics

The follow-up at `b83331091527db4166e9bfccd78e8d8065610077` adds the owned main task's kernel wait site and current system-call number/state to the failure-only record. Linux documents these interfaces in [proc_pid_wchan(5)](https://man7.org/linux/man-pages/man5/proc_pid_wchan.5.html) and [proc_pid_syscall(5)](https://man7.org/linux/man-pages/man5/proc_pid_syscall.5.html). The parser retains only a fixed list of wait-site symbols and validated syscall state/number. Arguments, register values, addresses, unknown symbols and arbitrary error text are excluded. Zero wait-channel output is explicitly unavailable and ambiguous; denied, missing, malformed, oversized and timed-out reads also remain unavailable.

The extension permits at most **seven bounded process-file reads**, within the unchanged **200 ms capture / 250 ms observation** budgets. Owned-child PID, parent and start-time checks still surround collection, successful startup performs no diagnostic reads, and all capture or logging failures preserve the original failure. The one-second probe, 25-second readiness gate, 90-second test ceiling, 25-second shutdown grace and native assertions are unchanged. The native integration test stayed byte-identical. No local native process, broad local suite or manually retried CI run was launched for this extension.

Final local validation passed **72 tests / 146 assertions**, including actual default Bun-console rendering, optional denied/missing reads, timeout/finalization at the new read sites, strict parsing, privacy and original-failure preservation. Both TypeScript projects, formatting, ordinary and type-aware lint, the production build and normal commit hooks passed. Root checked all seven retained validation-log hashes and sizes, the actual test summary and both TypeScript commands. Independent source review and root review bound all four source identities to the committed tree.

The [follow-up bundle](bayn-pr16145-followup-acceptance-20261121.json) preserves local validation, exact commit proof and the later successful nonforce push separately, retaining their original observation states. The pinned [Linux v6.18 source](https://github.com/torvalds/linux/blob/7d0a66e4bb9081d75c82ec4957c50034cb0ea449/fs/proc/base.c) establishes parser-format provenance; it is not an observation of the CI host's kernel or syscall ABI. Sequential readings cannot establish a particular file, device or root cause.

Normal changed-source [OpenCode CI 44914277712](https://github.com/proompteng/lab/actions/runs/44914277712), attempt 1, accepted exact head `b8333109`. At the retained **14:31:41 UTC** observation, both native architecture jobs were queued and unassigned, and merge was held for that head's intended gates. This improves failure evidence; the startup cause remains unresolved.

### b833 native failures on both architectures

The normal `b8333109` native workflow failed on both architectures. [AMD job 136876434674](https://github.com/proompteng/lab/actions/runs/44914277712/job/136876434674) completed with failure at **14:41:46 UTC**, and [ARM job 136876434948](https://github.com/proompteng/lab/actions/runs/44914277712/job/136876434948) at **14:43:35**. Both reached the initial readiness limit with no native HTTP response, provider call, native session or native application operation. Root independently verified the exact PR and workflow heads at **14:54:55 UTC**: the full rollup was terminal with **37 successful checks, two native failures and 25 skipped checks**. The index job was skipped. The earlier observation with four other checks still in progress remains in the receipts. Merge remains blocked.

| Measurement                                        |                AMD64 |                ARM64 |
| -------------------------------------------------- | -------------------: | -------------------: |
| Initial readiness failure                          |            25,010 ms |            25,014 ms |
| Native requests / transport errors / cancellations |          22 / 1 / 20 |          23 / 2 / 20 |
| Diagnostic capture                                 |                 7 ms |                20 ms |
| Main-task state at final stat read                 |                  `D` |                  `D` |
| Wait-channel result                                | Unrecognized content | Unrecognized content |
| Syscall result                                     |          Read denied |          Read denied |
| Reported assertion-to-scope interval               |            63,306 ms |             1,802 ms |
| Native test duration                               |         88,332.43 ms |         26,857.71 ms |

Both failures retained the original **25-second `TimeoutError`**; neither log reports an outer 90-second timeout. The new wait interfaces ran within their capture budgets but supplied no recognized wait site or syscall number. The discarded wait-channel content need not have been a usable symbol. There was no permission escalation.

The AMD main task recorded **142.678131 ms** of cumulative scheduler runtime and **0 ns** of run-queue delay; ARM recorded **306.151920 ms** and **1.950360 ms** respectively. Process-and-waited-children storage-write accounting was **5,267,456 bytes** on AMD and **4,866,048 bytes** on ARM, with zero reported storage-read bytes on both. These main-task and cumulative measurements do not establish duration in `D`, absence of other CPU contention, an I/O latency, a filesystem, device or common cause.

AMD's embedded process-diagnostic time-of-day is **14:40:25.908**, while that line's GitHub envelope is **14:41:29.205 UTC**. The startup block itself straddles that envelope delay. Embedded logger timezone was not independently measured, and envelope arrival is not capture wall-clock time. The **63,306 ms** difference between reported assertion and scope elapsed times does not isolate one cleanup operation or the child's exit latency. ARM's corresponding interval was **1,802 ms**, so the matching `D` observations do not justify treating the later behavior as identical.

The [follow-up evidence bundle](bayn-pr16145-followup-acceptance-20261121.json) preserves both full diagnostic records, selected raw failure lines, complete-download hashes, original phase/lifecycle measurements and independent review. Root checked both complete log hashes and sizes, their exact diagnostic lines (**677 AMD / 676 ARM**) and all **73 retained block rows per architecture**. The original pending-CI observation and prior failed heads remain separate historical records.

### Fingerprints for eligible unknown wait channels

The follow-up at `c9c7463d3bfcc385d6060f9e617e2b2e653ee1b3`, directly above `b8333109`, retains a fingerprint for an otherwise unknown wait channel only when its trimmed value is an **ASCII C identifier of 1–128 characters**. Pure hexadecimal or address-like forms, zero, fixed placeholders, offsets, module annotations, paths, embedded whitespace and decorated names receive no fingerprint. The status remains `UNRECOGNIZED_WAIT_CHANNEL`; known symbols keep their existing output without hashing.

The record contains only the domain `bayn.opencode-native-wchan-symbol.v1` and the lowercase SHA-256 digest of `UTF-8(domain) || 0x00 || UTF-8(trimmed-symbol)`. Raw unknown content is never emitted. Public candidate symbols can be compared offline, but this is not anonymization: a match identifies normalized bytes, not the CI host's kernel, a syscall, a blocking operation or root cause. It cannot recover discarded `b833` content or guarantee a future match.

The helper reuses the existing read and preserves the owned-child identity checks, **seven-read / 200 ms capture / 250 ms observation** limits, 4,096-byte accepted-file limit and 4,097-byte overflow check. Successful startup performs no diagnostic reads or hashing. The one-second native probe, 25-second readiness gate, 90-second test ceiling, 25-second shutdown grace, one-line logger and native integration test remain unchanged. A hashing defect preserves the original failure Cause and finalizers.

Retained local validation passed **117 tests / 325 assertions**, with zero failures. It includes three actual Bun-console cases using synthetic process data, 39 cases that must not hash, independent fixed hash vectors and hash-defect failure preservation. Both canonical TypeScript projects, formatting, ordinary and type-aware lint, the production build and normal commit hooks passed. Root verified all nine validation-log hashes, both TypeScript commands and all four final source identities; independent source review cleared the exact bytes subsequently committed. Existing lint warnings remain recorded. No local native OpenCode launch or broad local suite was added.

The [follow-up bundle](bayn-pr16145-followup-acceptance-20261121.json) preserves four new source, validation, commit and publication records without changing the earlier evidence. The validation receipt's pending-review state and commit receipt's `not_yet_pushed` state are historical; the later receipt proves a normal nonforce push by **15:07:22 UTC**, without inventing its completion time. At that cut, [normal OpenCode CI 44917443114](https://github.com/proompteng/lab/actions/runs/44917443114) matched exact `c9c7463d`; [AMD job 136885975590](https://github.com/proompteng/lab/actions/runs/44917443114/job/136885975590) and [ARM job 136885975885](https://github.com/proompteng/lab/actions/runs/44917443114/job/136885975885) were queued. **Current-head CI and merge remain pending at this observation.** The prior `b833` failures remain separate; no startup fix or new release acceptance is established.

### c9 AMD native result; ARM acceptance pending

The ordinary [c9 AMD job 136885975590](https://github.com/proompteng/lab/actions/runs/44917443114/job/136885975590), attempt 1, completed successfully at **15:19:52 UTC**. Its retained **15:20:05** job observation records one native test passing **30 assertions**, with zero failures, in **41,796.83 ms**. Initial readiness took **23,286 ms** and restart readiness **1,211 ms**. The reported shutdown intervals were **4,329 ms** and **7,056 ms**; these are differences between lifecycle events, not isolated CPU, I/O or child-exit timings.

Root independently checked the complete **167,475-byte / 1,769-line** log, all **322 retained block rows**, both startup records and all **13 lifecycle records**. The [follow-up evidence bundle](bayn-pr16145-followup-acceptance-20261121.json) retains the success receipt, complete selected blocks and that verification. The successful run emitted no failure-diagnostic record, so it supplied no wait-channel fingerprint.

Initial readiness remains close to the unchanged 25-second gate. This one ordinary changed-source success establishes neither a startup fix nor a statistical reliability improvement. **ARM and whole-PR acceptance remain pending, and merge remains held at this observation.** The original 15:07:22 c9 snapshot is preserved unchanged; the later AMD receipt supplies no updated full-PR rollup or ARM assignment timestamp.

### 7a60 queue and composition boundaries

A bounded runner read at **13:57:29 UTC** found AMD with **9 online-busy / 0 idle / 1 offline** and ARM with **5 online-busy / 0 idle / 5 offline** runners. Both pools had ten registered workers and retained **minRunners 5 / maxRunners 10**. All 20 actual EphemeralRunner Pods had matching architecture selectors; listeners, controllers and observability Pods were excluded. The offline names matched six unready workers: three running initialization, two scheduled before sandbox readiness and one initially unscheduled.

The later selected-UID event read retained three recent `FailedMount` reasons, but two affected Pods had already advanced into initialization. The initially unscheduled Pod subsequently received a Scheduled event at **13:57:31**. Event messages were not requested, so the underlying storage/scheduling errors are unknown. These non-atomic observations support busy capacity and initialization delays at that cut; they do not explain the full queue interval or the native process failure. ARM subsequently acquired a runner at **13:59:10** and AMD at **14:05:48**, with no capacity or workload change by this investigation.

The **13:54:14 UTC** source-overlap receipt found main still exactly `215cd89d92cb1b29ba68633ba24be9df7bc4b47d`. All 30 selected native, publication, dependency and ARC objects matched that baseline, and all eight publication-tested path blobs were unchanged from 13ea59c to 7a60a9e. This preserves the earlier publication-composition boundary; it does not turn the failed final-head native CI into passing acceptance. The [follow-up bundle](bayn-pr16145-followup-acceptance-20261121.json) retains the exact overlap, runner/provenance and terminal-failure receipts.

### Later ARM scheduling snapshot

A nearly hour-long c9 ARM queue delay justified a [single new scheduling snapshot](bayn-pr16145-followup-acceptance-20261121.json). At **16:06:18.446–16:06:21.606 UTC**, its non-atomic reads found **10 online-busy / 0 idle / 0 offline** GitHub workers and ten exactly name-matched actual EphemeralRunner Pods, all Running, Ready, Initialized and Scheduled. All init containers exited successfully; total restarts were zero, with **min 5 / max 10** unchanged. One AutoscalingListener was excluded. Membership used names, owners, Pod selectors and scale-set identity; empty GitHub labels were not architecture evidence. All ten Pods shared one hashed node identity, without retained raw node names or an independent node-architecture query; absent status counters remain null. This later cut is separate from the closed 13:57 snapshot. No current provisioning fault was observed, but the cut establishes neither FIFO order, earlier capacity, a specific dispatch-delay cause nor the native-startup cause. The read is closed, with no event, log, Pod-exec or follow-up capacity reads and no new CI check counts.

### c9 final source acceptance and squash merge

The ordinary [ARM job 136885975885](https://github.com/proompteng/lab/actions/runs/44917443114/job/136885975885), attempt 1 at exact `c9c7463d3bfcc385d6060f9e617e2b2e653ee1b3`, started at **16:37:16 UTC** and completed successfully at **16:44:29**. Both native architecture jobs now have passing terminal evidence:

| Native measurement               |        AMD64 |        ARM64 |
| -------------------------------- | -----------: | -----------: |
| Assertions passed / failed tests |       30 / 0 |       30 / 0 |
| Initial readiness                |    23,286 ms |    15,672 ms |
| Restart readiness                |     1,211 ms |     1,227 ms |
| Native test duration             | 41,796.83 ms | 47,352.01 ms |
| Job completed, UTC               |     15:19:52 |     16:44:29 |

ARM's reported first and final shutdown intervals were **19,120 ms** and **3,834 ms**, with scope release at **47,349 ms**. These are differences between lifecycle events, not isolated CPU, I/O or child-exit timings. Root independently verified the complete **167,299-byte / 1,768-line** ARM log, all **322 retained block rows**, both startup events, all **13 lifecycle events** and the 30-assertion summary. Neither passing architecture emitted a failure diagnostic. These successes supply no wait-channel fingerprint or startup-cause correction; AMD's initial readiness remains close to the unchanged 25-second gate.

The agent's **16:45:06 UTC** terminal observation and root's independent **16:46:20.895–16:46:21.877** read both bound the full PR rollup to exact c9: **40 SUCCESS / 31 SKIPPED / 0 pending / 0 failed**. [OpenCode CI 44917443114](https://github.com/proompteng/lab/actions/runs/44917443114), attempt 1, succeeded; its PR index-publication job was correctly skipped. Root retained OPEN / CLEAN / MERGEABLE, approval submitted against c9 at **16:44:42**, and zero unresolved review threads. These independently timed API reads do not form a single atomic observation.

The final main review bound `cfdac7b26bf6941e15289000664879cc90e63db2` to **26 unchanged / four changed** objects in the 30-object inventory. All eight candidate publication-path bindings remained unchanged from 13ea to c9. The selected main changes had no overlap with the candidate's changed paths. Source review traced the new generic App cache option through its defaults and callers: Bayn selects its separate runtime root, while OpenCode imports the Bayn runtime root directly. The newer OCI test bytes were reviewed separately. The earlier **267 tests / 2,849 assertions** remain evidence only for the temporary **13ea + 215cd89** composition; no new temporary merge, Nix evaluation or test execution is claimed for c9 with cfdac.

A direct remote-ref read at **16:48:11 UTC** confirmed actual `refs/heads/main` was cfdac; the PR's separately retained `baseRefOid` was not used as proof of the current branch tip. The **16:49:50–51** preconditions rechecked the exact approved c9 head, passing rollup and reviewed main. Root then used squash merge with `--match-head-commit` bound to c9. GitHub records the merge at **16:49:54**, producing `2311bf59f2276441cb85ed3133cfe3118eb5484f`.

Post-squash Git verification independently bound parent cfdac and tree `f726e6f4dddbb78f4f6737940dc83f06e8e20516`, with exactly the ten intended changed paths. The diagnostic helper, tests and integration bytes match the approved candidate; the README diagnostic section is exact, with its other difference accounted for by previously reviewed main broker prose. Seven publication-path bindings match the earlier executed composition, while the eighth is the separately reviewed current-main OCI test blob `fc3a36682b58a28598095e00bc0c0f5ff1d6fb0d`. This is source-integrity proof, not post-squash execution.

The [follow-up bundle](bayn-pr16145-followup-acceptance-20261121.json) preserves all 34 earlier embedded source records and their historical states, adds the complete selected ARM blocks and final source proofs, retains the initial c9 CI cut as `priorInitialCiC9`, and dates canonical `exactHeadCi` to terminal acceptance. Merge is recorded separately. Normal [OpenCode main run 44926703176](https://github.com/proompteng/lab/actions/runs/44926703176) belongs to merged `2311bf59`; its publication and live acceptance remain pending. The consolidated Bayn publisher still lacks a live exercise. No statistical reliability improvement, measured latency or dollar saving, or new financial qualification follows from this source completion.

## Bayn recovery publication

Bayn's original main run `44889463740` for `acc115c8082a00881fc3d1daef8af08b62458a85` was cancelled before any job started, one second after a newer main run was created. The timing is consistent with pending-slot replacement; no cancellation actor is asserted. Its successor [run 44891137421](https://github.com/proompteng/lab/actions/runs/44891137421), source `6d6600bd98ca3f0a434cd8f104369a6fa552deef`, is a verified descendant carrying the same production recovery code. Intervening Bayn changes affect test fixtures and helpers, not production source, runtime manifests, image definitions or dependency locks.

The successor passed all 29 prerequisites by **10:22:59 UTC** and completed **all 39 publication jobs successfully**. Final cohort publication completed at **12:39:41 UTC**. The exact-source Bayn rollout passed live acceptance at **12:44:35–12:44:58 UTC**, as recorded below; OpenCode's independent recovery release is also accepted in its separate section.

An earlier source, `cf45fd3bb61fe6215b8d6a26ef25333abf8c98c2`, failed [one Bayn amd64 image build](https://github.com/proompteng/lab/actions/runs/44888790054/job/136805437750) at the original 30-second production-Node startup test limit. Both canonical TypeScript projects completed and the separate retained v38/v39 reader test passed all 14 cases. The log does not identify whether bundling, child startup or cleanup consumed the first test's budget. Its ten expectation calls at suite end do not prove their timing before the timeout. This prior failure is retained separately from successor acceptance; no retry or deadline increase is claimed.

### Published cohort and live acceptance

The [complete acceptance receipt](bayn-6d-runtime-acceptance-20261121.json) binds artifact **14706937744** and run **44891137421** to these immutable indexes:

| Member                  | Immutable index                                                           |
| ----------------------- | ------------------------------------------------------------------------- |
| Bayn API and controller | `sha256:2543500b35a4e56a26279b9f88ee0cc335caed45fbae223480cdb707db333910` |
| Research                | `sha256:6a1ce86d4189a74092f4ae55caf97043fcaec2afe8b0f2a083c6571b8edb6d45` |
| Broker feed             | `sha256:894ff6fe04cc4aec65c3fea6a6b7613210385b9642fb48533efec6ca73bd502d` |

Recorded cohort-job results show immutable-image verification succeeded at **12:33:25–26 UTC**, artifact upload at **12:33:26–27**, source verification at **12:33:27**, and Kargo-tag publication at **12:33:27–12:39:37**. The job completed at **12:39:41**. This is the existing publication path; it does not exercise PR #16145's later consolidation.

Kargo discovered Freight `440e162cd40929b10d4251cca3968749f2e796e2` at **12:41:07**, with all three digest/source/run/success bindings matching the cohort. Its automatic promotion succeeded at **12:43:36**. Argo was Synced, Healthy and Succeeded at generated revision `4e051f9663063fd129b70f2a700226bcba6b7d35`. The new Freight collection `f6165bade2bf6d23c9504aa2db5de6090a339c01` has Successful verification at **12:43:45–12:43:54**, bound in Stage history to its AnalysisRun. An optional direct AnalysisRun read failed during the later backend outage; no separate metric-count claim is made.

| Selected owner       | Observed generation | Ready | Actual node architectures | Restarts |
| -------------------- | ------------------: | ----: | ------------------------- | -------: |
| API                  |                1159 |   2/2 | amd64 and arm64           |        0 |
| Execution controller |                1073 |   2/2 | amd64 and arm64           |        0 |
| Research             |                 474 |   1/1 | amd64                     |        0 |
| Broker feed          |                  80 |   1/1 | amd64                     |        0 |

At **12:44:35–12:44:58 UTC**, all six selected, non-deleting Pods matched the cohort in both specification and runtime image identity, with runtime config digests matching the previously verified architecture-specific configs. Both APIs returned HTTP 200, embedded exact-6d source, READY, broker execution eligibility and accounting EXACT. Research and broker-feed are only claimed live on amd64; both image architectures were independently verified through immutable metadata.

The automatic activation hook bound the exact source and unchanged execution plan, exited **0 / Completed**, and recorded epoch **455**, next sequence **366341**. Both APIs subsequently reported completed sequence **366342**, SUCCESS / WINDOW_CLOSED, at **12:44:11.225**. The next entitled entry remains **2026-11-23T13:01:02Z**. The same request `6856f071e54529227ea48fa7b077506209ffd887c939d7351e948d7e03020130`, generation `412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571` and durable authority timestamp **08:22:44.908044 UTC** retain the existing PAPER/sandbox authority. This acceptance issued no new mandate, grant, order, inference or assessment.

The new research Pod's bounded model-identity GET matched all five required nonempty fields: qwen38-flamingo, checkpoint/tokenizer/template `482ca0f3832238542f8f5295dde86b5f22711d80`, and serving image `sha256:20fdb089454afbb324efa4110a2c025ff7b27cc1a086e07aa580b18df8ad1ce1`. Documented OpenCode identity and limits remain 2.1.3 / glm-5.3-flash-free, configuration `506c32b2aa303b15b15e3279a4f5f165c30d846d5d86f89a0bc80ae417a4257f`, one model call, 32,768 input bytes and 4,096 output tokens. Current temperature 0.6 is reported separately from the historical comparison. A valid signed prospective registration remains required.

The receipt includes the complete **11:42:05 UTC** ARC projection: AMD had seven online/busy, zero online/idle and three offline runners; ARM had nine online/busy, zero online/idle and one offline. All four pending workers were scheduled and initializing. This snapshot is not extrapolated to later assignments or joined to the earlier 10:40 mount warnings. The research index's queued API timestamp was **11:10:20**, actual execution began **12:22:49**, and it succeeded **12:25:13**; the receipt retains first observation times separately. No measured saving from the later consolidation is inferred.

A backend replacement occurred after the successful observations. All six recovered publication/metadata/runner input files reproduce their original SHA-256 hashes exactly. Serialization after recovery preserves the original live cut and does not represent a new observation. The earlier 7/7 archived-receipt result remains source-function SELECT-only evidence; this rollout adds no deployed historical-HTTP replay or economic qualification.

### Bayn image queue: bounded runner-capacity diagnosis

At 10:40:36 UTC, run 44891137421 had four unassigned image jobs: three requested `arc-arm64` and one requested `arc-amd64`. These names matched the current ARC scale sets, both at observed generation 2 and Running with the unchanged minimum 5 / maximum 10 per architecture. GitHub listed 10 registered runners in each pool. AMD64 had 7 online/busy and 3 offline; ARM64 had 8 online/busy and 2 offline. Neither pool had an online idle runner. The sequential Kubernetes projection matched those five offline registrations to Pending runner Pods; all 20 runner Pods were already scheduled. Both listeners and the controller were Ready with zero restarts.

This was capacity saturation with a concrete initialization constraint. Four of the five selected Pending Pods had retained volume-mount `DeadlineExceeded` events, followed by `Aborted` retries reporting an operation already in progress. The AMD64 vvmcj and ARM64 4zlsz Pods subsequently reached running `init-scratch` at 10:41:49 and 10:40:37, respectively. AMD64 cj5wk and ARM64 jsv8g were still waiting in the final selected init snapshot; AMD64 l52d6 was attached and waiting without a retained mount warning. Earlier ephemeral-PVC creation and unbound-PVC warnings had been followed by successful scheduling.

The evidence supports available-runner saturation compounded by volume-mount initialization delays. It does not establish an architecture-label mismatch, a permanent deadlock, or the underlying storage cause. The samples were sequential; no queue-drain deadline or eventual release result is inferred. The [runner-scheduling receipt](bayn-6d-runner-scheduling-diagnosis-20261121.json) retains sanitized job, scale-set, runner, Pod and event projections with provenance. No runner policy, workload, job, retry, cancellation, or storage setting was changed.

A separate [source-only runner audit](arc-runner-storage-source-audit-20261121.json) found no actionable PVC, mount or init-ordering defect in the inspected configuration. All 12 compared template fields per architecture match source `6d6600bd98ca3f0a434cd8f104369a6fa552deef`; the locally retained generated revision `c83a1870db5f384ddda297df11b81a9f07ed98d5` matches the observed paired init/runner image and init script. Each Pod retains an independent 100Gi RWO claim, staged seed-copy verification and a 45Gi free-space reserve. The device-mount deadlines preceded init execution, so that copy cannot explain the initial mount failures. The exact CSI/kernel-RBD operation and underlying cause remain unestablished; this source check supports no storage, timeout, capacity or admission-policy change.

## OpenCode native recovery rollout accepted — 2026-11-21

[PR #16111](https://github.com/proompteng/lab/pull/16111) merged at **09:24:44 UTC** as `acc115c8082a00881fc3d1daef8af08b62458a85`. [Main publication run 44889463638](https://github.com/proompteng/lab/actions/runs/44889463638) succeeded; index publication completed at **10:05:39 UTC**.

### Native validation

The actual pinned native test passed **30 assertions on each architecture**. The original 25-second readiness and 90-second integration bounds were preserved. Both controlled fixture inference receipts completed, the deliberate expiry remained expired, and both process scopes released. Each final diagnostic array contained 24 operations; repeated last-operation summaries were not counted again.

| Architecture | Native test duration | Initial readiness | Restart readiness | Initial cancelled probes |
| ------------ | -------------------- | ----------------- | ----------------- | ------------------------ |
| amd64        | 46.38432 s           | 10.055 s          | 1.212 s           | 8                        |
| arm64        | 51.33504 s           | 18.997 s          | 1.24 s            | 15                       |

These are observed acceptance timings, not a controlled latency comparison. Operations measure HTTP-header completion or cancellation, not full-body processing.

### Published identity

Verified OCI index: `sha256:d6982c5eac11b1a15a1a311dc5d3c19593ea94e265e122872a47860408e5d7e0`. Its source annotation and both platform configs identify the exact main source above.

| Platform | Child manifest digest                                                     | Config digest                                                             |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| amd64    | `sha256:5d4d27049c8bc0ce537d1a755dc5a5e458d357d1dd1ae550bc29892cbfada4d5` | `sha256:319fbc5ed190a3a512c589f1d83080c49c11d18e9da6ba783c54dbd43006d167` |
| arm64    | `sha256:c5a46667616335d524eea9b37788cd9b72a39ef7f310a0be3f2d5a0f64c8aa3a` | `sha256:4920bbe2f5b2e0a1a49bca19993423b53b7ea81760f9a27e396e4351999c5516` |

The native CLI remains independently pinned to OpenCode 2.1.3 at upstream `bb25a2f4a3f3f04d7c344bec0c0574ea3510b3b1`; the main revision identifies image/application packaging.

### Normal delivery and live acceptance

Freight `555ff6bcd91e481bba7b7f60faad3c5e9fedbc87` promoted normally from **10:05:40 to 10:06:47 UTC**. Argo synced delivery revision `5085dfdaf2aceaaa44910fcd0a67f5b249da3eab`. Smoke analysis `opencode.01m7ys77ehytee3wbt917vh71n.93e047e` succeeded from **10:07:52 to 10:08:01 UTC**. At 10:08:37, Stage Ready/Healthy/Verified were all true, Argo was Synced/Healthy, and both deployments had one updated, Ready, available replica with zero container restarts.

| Role              | New Pod                             | Selected architecture | Process started |
| ----------------- | ----------------------------------- | --------------------- | --------------- |
| opencode          | `opencode-5df8bc649-ncdhx`          | amd64                 | 10:07:41Z       |
| opencode-research | `opencode-research-f9f9dfcbc-wp6dt` | amd64                 | 10:07:09Z       |

Each endpoint targeted only its corresponding new Ready/serving Pod. Both roles selected the verified amd64 config under the index above. Their `imageID` denotes the index, while the separate config digest identifies the chosen platform.

At **10:10:52–53 UTC**, read-only process checks found exact `OPENCODE_CODE_REVISION`, Linux x64 and one native process per role, running `/nix/store/px8cbi5gxqzw105z775k3mrv3yjzwzrn-opencode-2.1.3/bin/opencode`. Development's authenticated `/api/info` returned HTTP 200 and version 2.1.3; its unauthenticated request returned 401. Research `/readyz` returned 200, which its verified source gates on authenticated exact-version native info; an unauthenticated native request returned 401. Both original protected PVC claims remain mounted.

These acceptance probes invoked no live inference, study request, pairing, login, order or grant. The arm64 image passed native validation and was published; no arm64 production Pod is claimed.

### Remaining cache limitation

Both cache-warming steps emitted actual upload-failure warnings while the native jobs and registry publication succeeded. The logs show 716/717 planned build paths, 64-path batches and one upload worker each; planned paths are not counts of objects uploaded. ARM reported the fixed client class `InternalServerError`. The later [bounded server correlation](#cache-upload-errors-and-database-acquisition) found database acquisition errors in the same window, but no shared identifier proves an exact request join or the underlying cause. No partial NAR transfer appeared in these job logs.

The companion [sanitized receipt](opencode-acc-runtime-acceptance-20261121.json) retains the sanitized identity, delivery, process and native-test projections, eight input-receipt SHA-256 hashes and eleven exact source-file hashes. No internal addresses, credentials, request headers, raw HTTP bodies or raw job logs are included. Existing receipts supplied the documentation; no extra runtime queries were made solely for it.

## Publication work and release retention

[PR #16130](https://github.com/proompteng/lab/pull/16130) merged at **10:31:10 UTC** as `ab6eefd4eccbaa10c7d5916165c913a6dd06d692`. Bayn and OpenCode now exclude three PostgreSQL test-support files from their top-level main publication triggers. Helper-only changes cannot enqueue or replace a pending release; a mixed helper/production change still publishes in either path order. The actual helper callers and test-only guards were inspected. Focused validation passed **84 tests / 1,111 assertions**, two observability contract cases / eight assertions, generated catalog verification, scoped TypeScript and both lint modes. Final PR checks had **14 successes and 31 expected skips**, with automatic reviews clear. A broader optional TypeScript invocation still reported 118 diagnostics in unchanged files without a pristine-baseline replay; the full broader observability invocation also encountered an unrelated original five-second Python timeout and unavailable promtool/Alloy. Those broader checks are not reported as green. Avoided publication work is structural; no measured compute cost or elapsed-time reduction is asserted.

### Retaining a production push through a later dependency-only skip

[PR #16144](https://github.com/proompteng/lab/pull/16144) merged at **11:48:02 UTC** as `601d54608971a7f37421dec979d4e1465b68abd3`, after review of head `f39239f5979d286bd1919ac690d9e16254128034`. It fixes a distinct queue-loss case. If a production push is pending behind an active Bayn run, a later unrelated manifest or lockfile push can replace it under GitHub's default single-pending concurrency policy. That later run may then correctly skip its own image work because Bayn's dependency-aware selector compares only the later push's before/after commits. The replaced production change has no last-published-baseline recovery.

The change adds `queue: max` to the existing serialized Bayn main concurrency group, preserving `cancel-in-progress: false`. GitHub documents a maximum of **100 pending runs**, with further runs cancelled; order follows when runs begin waiting on the group, not a strict commit-order guarantee. Retaining intervening runs may build more eligible commits during a burst. This controls pending workflow retention, not assignment of runner capacity inside an already active workflow. See the [official concurrency contract](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) and [May 7, 2026 feature announcement](https://github.blog/changelog/2026-05-07-github-actions-concurrency-groups-now-allow-larger-queues/).

The pinned actionlint 1.7.7 and inspected 1.7.12 both lack this supported GitHub key. A single exact-file, fully anchored diagnostic exception follows the repository's existing Temporal pattern; regression guards bind the complete queue policy, allowed placement and exact exception, and unrelated diagnostics remain failures. The [upstream compatibility issue](https://github.com/rhysd/actionlint/issues/657) remains open at this review. Focused validation passed **193 tests / 2,305 assertions**, all-workflow pinned actionlint, formatting and both lint modes. The new regression and import graph passed TypeScript; including the existing publication-source test reproduced the same 14 normalized diagnostics on base and changed source. Independent source and composition reviews were clear. The final rollup had **36 successful checks and 23 expected skips**, with no pending checks or failures; [Bayn validation 44898647145](https://github.com/proompteng/lab/actions/runs/44898647145) and its final release gate passed. Automatic code and security review completed on the reviewed head, with no code findings and no unresolved review threads. Root verified the exact green head and CLEAN merge state before a guarded squash.

### Consolidating the cohort publication jobs

[PR #16145](https://github.com/proompteng/lab/pull/16145) prepares all three Bayn image indexes in the existing `publish-cohort` job. Its publication implementation was reviewed at `a53de4ffc1ac310118f57d5f722dc8968ca07e4e`; current head `c9c7463d3bfcc385d6060f9e617e2b2e653ee1b3` also includes the bounded failure diagnostics, rendering correction, kernel-wait extension and eligible-symbol fingerprint described above. Only the three Bayn callers disable the shared workflow's new default-true `publish_index` input. All six platform jobs retain their native checks, registry pushes, cache-warming policy and log uploads.

The preparation requires all three paired build results to be successful. It resolves each of six architecture tags once, validates the exact source commit, commit timestamp and platform through immutable child references, and completes all six checks before creating any index. Those same child digests are used for the three preparation indexes. Each complete raw descriptor array is then checked through its immutable index digest. This includes the review correction for extra untyped descriptors that the general OCI platform inspector intentionally omits. The helper emits the complete three-output set only after success. Existing verification, artifact upload, source recheck and final Kargo aliases retain their order and gates; the 15-minute cohort budget is unchanged.

This replaces **four publication runner jobs with one**, avoiding **three ARC runner starts per eligible full cohort**. It does not establish a measured wall-time or dollar saving. Failed preparation can leave undiscoverable source-tagged indexes; Kargo still requires the complete source/run cohort. Other shared-workflow consumers retain their existing index publication.

Focused validation passed **263 tests / 2,825 assertions**, including 92 cases exercising the real preparation/shared OCI code with fake registry commands. Strict TypeScript checking of all four changed modules and their imports, normal/type-aware lint, pinned actionlint, formatting and normal hooks passed. Root and independent review were clear after the raw-descriptor correction. Normal CI at a53de4f finished with **39 successful checks, 36 expected skips, one superseded title cancellation and one ARM native startup failure**. The failed gate and its bounded investigation are retained above; the PR remains held. A [prospective composition check](bayn-pr16145-queue-composition-20261121.json) with merged queue source 601d546 completed without conflicts, passed **265 tests / 2,839 assertions** and pinned actionlint, and restored the original clean a53de4f tree after aborting the temporary merge. Existing publication filters are preserved, and static/PR validation does not establish live use of the consolidated Bayn publisher; that requires the next ordinary eligible release.

A later [composition check](bayn-pr16145-followup-acceptance-20261121.json) combined `13ea59cbabec32a5560ec0e52f543749166c9c8d` with then-current main `215cd89d92cb1b29ba68633ba24be9df7bc4b47d`, producing temporary tree `828b924ddf6074465161b12051d192cbd77f8b63`. It merged without conflict, passed **267 tests / 2,849 assertions** across the seven publication/selector/OCI suites and pinned actionlint for both changed workflows, then restored the clean original head and removed the temporary merge state. Native source, Nix inputs, relevant manifests, shared publisher and ARC configuration were unchanged between main 601d546 and 215cd89. The lockfile changed only unrelated Golink workspace metadata; it was not byte-identical. New broker-event production work on main was outside these focused tests. These results belong to that temporary composition, not a full-main suite or a native test of final c9c7463d; the later diagnostic changes affect only the helper, its tests and the README.

A later source-only comparison used one bounded fetch, bracketed by client observations at **15:23:55–15:23:57 UTC**, to bind then-current main `7e82ad58ae9d00653360adcfef3ac54334a66a71`. Against `215cd89`, **27 of the same 30 inventory entries** were unchanged; ARC, `.github` and shared-script directory objects changed. All **eight candidate publication-path bindings** remain unchanged from `13ea59` through `c9c746`. None of the seven selected new-main files overlaps the candidate's ten changed paths. The additional README review found separate native-diagnostic and broker-documentation hunks. This found no new textual conflict in the inspected scope; it did not execute or guarantee a new merge.

ARC source `338d0d21b56a139e31d5cf37f68247d65f922b8f` changed both architecture initialization scripts from **twelve tree walks to four per architecture**. Source review found the two `cp -a` operations, six aggregate equality checks, store/var presence gate, pre/post-copy **45 GiB** reserves, ownership/permissions and install-after-validation order preserved. These are aggregate byte/file/link-count checks, not content hashes or atomic-copy guarantees. This is a real runner-initialization source change; its deployed behavior, performance and environment equivalence were not measured.

The [follow-up bundle](bayn-pr16145-followup-acceptance-20261121.json) retains the exact overlap receipt, command provenance and ARC semantic review. No new temporary merge, tests, native execution or live capacity reads were performed for this source comparison. The **267-test / 2,849-assertion** proof remains confined to the prior `13ea59 + 215cd89` tree, and the remaining ordinary c9 gates still control the merge decision.

A supplementary [read-only artifact check](bayn-cohort-6d-metadata-compatibility-20261121.json) at **11:37:46–11:38:05 UTC** matched all six already published `6d6600` platform images to the exact source, literal commit timestamp, Linux and expected architecture. Fourteen explicit Registry v2 GET operations verified manifest/config content hashes and the existing broker-feed index's exact two-child set and source/run/success annotations, using normal TLS and no added credentials. The original reader did not distinguish an absent variant key from explicit JSON null. A [single immutable-index addendum](bayn-cohort-index-variant-presence-20261121.json) at **11:40:52 UTC** established that both variant keys were absent, satisfying the helper's stricter condition; the original receipt remains unchanged. The [reader and command provenance](bayn-cohort-6d-metadata-provenance-20261121.json) preserves both exact executions and their hashes. Counts describe explicit GET operations; automatic redirect hops were not separately instrumented. This establishes metadata compatibility, not execution of the new publication flow, and performs no registry, CI-output or runtime mutation.

The changed service README matches OpenCode's existing main publication trigger, so merging this PR is expected to exercise that shared publisher's default path through a normal OpenCode release. Bayn excludes that README; this PR alone does not start a Bayn main publication.

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

## Later collector capacity and checkpoint latency

The [extended observation](session-investigation-2026-11-20-operations-acceptance-c217-extended.json) preserves a later collector point at **09:52:00 UTC**, 47 minutes 48 seconds after the earlier GC sample and about 65 minutes after process start. The collector retained the same UID, process, configuration and resources, with zero restarts, retained termination states or observed UID-scoped events.

| Collector measurement      | 09:04:11 UTC | 09:52:00 UTC |
| -------------------------- | -----------: | -----------: |
| GC count                   |           25 |           49 |
| Allocated heap, decimal MB |       280.14 |       281.33 |
| Process RSS, decimal MB    |       465.15 |       471.39 |
| Samples sent               |    1,895,394 |    7,432,080 |
| Remote-write pending       |          578 |        1,041 |
| Failed / retried samples   |        0 / 0 |        0 / 0 |

Highest observed and highest sent timestamps matched at both endpoints. Pending samples are a changing queue gauge, so these endpoints do not establish a monotonic trend. The later cgroup read measured **412.49 MiB current / 412.94 MiB reported peak / 512 MiB limit**, with **99.51 MiB current headroom** and every memory-event counter zero. It is the first retained cgroup sample; it must not be substituted for the earlier process-RSS series.

At the separately recorded **09:56:23 UTC** metric evaluation, all 12 current Ready targets remained bound to their expected runtime image. The 41,694 series remained present; the oldest UP/JVM sample was 29.449 seconds old and maximum scrape time was 0.143235 seconds. An initial client-side query-quoting error was corrected at that same evaluation time; it was not a second collector or checkpoint sample.

Collector capacity and delivery remained supported, but **checkpoint freshness did not pass this later snapshot**: the latest completed checkpoint's last-acknowledgement age was **252.416 seconds for archive and 505.925 seconds for TA**. Both jobs were RUNNING/STABLE, had advanced checkpoints, and retained only their original startup failure each.

### Measured checkpoint phases

The [phase diagnosis](torghut-checkpoint-phase-diagnosis-20261121.json) binds exact checkpoint IDs, retained coordinator logs, REST timestamps, source semantics and the subsequent bounded observation.

| Pipeline / checkpoint | Recorded timestamp to pending checkpoint | Pending checkpoint to last ACK | Last ACK to completion log |
| --------------------- | ---------------------------------------: | -----------------------------: | -------------------------: |
| Archive 99273         |                                 36.176 s |                       17.055 s |                  169.678 s |
| TA 168675             |                                223.640 s |                       31.464 s |                   59.406 s |
| TA 168676             |                                223.091 s |                       46.609 s |                  189.044 s |
| TA 168677             |                                186.984 s |                       23.403 s |                   34.039 s |

All relevant tasks acknowledged: 224/224 for archive and 131/131 for TA. The first interval includes planning, executor waiting/checkpoint-ID allocation and scheduling before the pending checkpoint and timer exist. Storage-location initialization and actual task triggering occur after that boundary, so the middle interval includes storage/coordinator work as well as task work; it is not pure barrier/alignment latency. The log's 1–4 ms finalization field starts after metadata close and therefore excludes the long tail after acknowledgements.

At **10:03:18 UTC**, latest-completed last-ACK ages had recovered to **51.430 seconds for archive and 172.655 seconds for TA**, with 64 and 24 completed checkpoints respectively and no new failed count. Archive's next checkpoint already had all acknowledgements while a contemporaneous I/O-worker stack waited in S3 multipart metadata finalization. TA's sampled stack was in S3 object listing; the retained frames do not bind it to a specific checkpoint.

The incident alert range contains ten sampled TA FIRING points from **09:57:00 through 10:01:30 UTC**, with archive PENDING from 09:56:00 through 09:58:30. No active alert series remained at the later observation. This establishes rule detection, not notification delivery. All 28 covered pending-record and 354 backpressure series were finite zero; eight Kafka lag series were finite zero and 46 remained nonfinite.

The exact source defaults the JobManager I/O pool to the JVM-reported processor count and the separate cluster pool to four times that count. One observed JobManager worker and a 500m CPU quota do not measure the numeric pool maximum or queue depth. The evidence supports further attribution of metadata/finalization latency; it does not justify a pool-size, timeout, durability or S3 tuning change. Matching operation evidence is needed to separate client waiting, network, RGW and device delay.

### Checkpoint storage attribution: bounded incident history

The retained 09:49–10:03 UTC history shows substantial shared storage pressure. Across 29 samples at 30-second steps, the median one-minute mean write latency was 17.221 ms on the ARM host’s shared BlueStore DB device and 41.552 ms on Turin’s, with median device busy time of 99.547% and 99.680%. Turin OSDs 0, 1, and 2 had five-minute mean write-latency peaks of 7.768 s, 8.763 s, and 10.887 s at 09:57–09:58. These are windowed aggregate metrics, not individual request percentiles. They establish temporal storage pressure, not the cause of an exact checkpoint request.

The bounded RGW recovery found 27 operations whose path or listing prefix matched TA checkpoint 168676 at 10:03:02.522–10:03:48.999. They occurred after its 09:56:45.379 completion. The retained metadata operations were HEAD/200 at 10:03:34.849 with 1.072 s reported latency and DELETE/204 at 10:03:37.374 with 2.524 s reported latency. No explicit request IDs were present; connection identifiers were not substituted. These later operations do not explain the earlier 189.044 s last-ACK-to-completion interval. No exact archive 99273 or 99280 request was recovered.

Incident-window request coverage remains incomplete. Loki returned zero checkpoint-ID matches, but RGW ingestion and retention coverage were not established. Initial direct log replies exceeded the reply cap and retained only later bytes. One bounded server-limited recovery per known RGW returned coverage beginning at 10:02:59 and 10:15:30, respectively; neither covered the 09:53–09:56 finalization tails. The captures do not establish why that earlier interval was unavailable. The archive 169.678 s and TA 189.044 s tails therefore remain unattributed to a specific RGW request, despite the contemporaneous storage pressure and the separately retained archive metadata-finalization stack.

The [storage-attribution receipt](torghut-checkpoint-storage-attribution-complete-20261121.json) retains the sanitized operations, aggregate metrics, capture bounds, tool job/command hashes, hashes of matched object keys and original log records, and source-file hashes. It omits raw paths, URLs, query values, upload identifiers, headers, payloads, and unrelated request inventories. This step made no new pipeline or collector observation, workload or logging change, synthetic load, or storage tuning. It does not justify changing the I/O-pool size or weakening checkpoint durability.

### Corrective RGW capture: same historical window

A separate corrective read requested **2026-11-21 09:49:00 through 10:03:59 UTC** from the same two known RGW Pods. Timestamp, exact checkpoint ID and expected Flink job ID filtering ran inside the read process, before any tool-output or retained-event cap. No kubectl tail or server byte limit was applied. Each reader was bounded to **32 MiB and 30 seconds** and stopped at the first returned chronological timestamp at or after 10:04:00.

| Pod suffix | First returned timestamp, UTC | Last in-window timestamp, UTC | Stdout bytes read | Matched operations |
| ---------- | ----------------------------- | ----------------------------- | ----------------: | -----------------: |
| 4lcz4      | 10:02:59.545961895            | 10:03:59.484632255            |           279,054 |                 27 |
| kqgs9      | 10:15:30.700172140            | None                          |             3,974 |                  0 |

Neither the byte, timeout, line-size nor retained-event cap was reached. There were no timestamp or operation parse failures and no out-of-order timestamps in the processed prefix. The local readers were deliberately terminated at the end boundary; their exit code 1 is recorded as a client-stop outcome, not as an RGW failure. The enclosing sanitizer completed successfully. Seven synthetic parser checks covered identity selection, decoded listing prefixes, metadata, multipart operations and omission of private URI values before the historical reads ran.

The result reproduces **all 27 prior TA checkpoint 168676 operations**, including their exact original-record hashes. They remain later activity, after that checkpoint's 09:56:45.379 completion. The metadata HEAD/200 and DELETE/204 retain the same object-key hash and reported 1.072 s / 2.524 s latencies. No operation for archive checkpoints 99273 or 99280, or before TA168676's known completion, was recovered.

This correction removes output-tail truncation and the earlier server-byte limit as explanations for the missing earlier interval **in this new capture**. It does not prove why the current Pod-log streams start late, whether older data exists elsewhere, or that an exact earlier request did not occur. The 169.678-second archive and 189.044-second TA finalization tails remain unattributed. No new metric, pipeline, collector or database sample was taken; no Pod exec, upload retry, workload, logging or storage change was performed. Raw logs were neither output nor persisted.

The earlier receipt and its original capture limitation remain unchanged. The [corrective receipt](torghut-checkpoint-storage-corrective-recovery-20261121.json) retains the exact capture bounds, fixed operation fields, path/record hashes and original-receipt identity. Its [provenance](torghut-rgw-corrective-recovery-provenance-20261121.json) embeds the exact executed sanitizer and reconstructs its recorded command hash. The actual capture had no explicit request-ID matches; the provenance preserves a query-field ambiguity that must be addressed before any future reuse of this one-time filter.

### Cache workload boundary

The [cache-warming source audit](attic-cache-warming-source-audit-20261121.json) verifies one client upload worker per warmer. Its 64-path batch size is not an upload-worker count. The pinned server separately allows up to ten concurrent chunk uploads per NAR and can fan out multipart writes. Both observed OpenCode warmers emitted upload-failure warnings even though native tests, registry publication and deployment succeeded.

The wrapped upload-command failure is nonfatal, but the warming step remains on the index-publication dependency. Moving it off that dependency requires an exact-source closure handoff design; source inspection alone does not establish a safe concurrency limit or a causal performance benefit.

The [narrow helper-publication correction, PR #16130](https://github.com/proompteng/lab/pull/16130), merged at **10:31:10 UTC** as `ab6eefd4eccbaa10c7d5916165c913a6dd06d692`. It excludes exactly three test-only PostgreSQL helper paths from Bayn and OpenCode main publication. Helper-only changes stop launching those image builds; mixed helper/production changes still publish, and Bayn PR validation remains enabled. Existing workflow-only non-publication and release/security gates are preserved.

Focused local tests passed 84 cases and 1,111 assertions, plus two observability regression cases and eight assertions. A scoped TypeScript check of the changed test and its real import graph passed under compiler options inherited from the owning project. Type-aware lint, formatting and generated-workflow consistency also passed. An optional whole scripts-project check reported 118 diagnostics in unchanged files; no pristine-base rerun was performed. A broader optional observability run encountered a five-second Python timeout in an unchanged test and unavailable promtool/Alloy dependencies. Neither broader run is counted as passing acceptance evidence.

Final CI on `9cfc79195cf0b4a2c9a1d359fcfeffc4af022b85` had **14 successes and 31 intentional skips**, no pending or failed checks, CLEAN merge state and no unresolved review threads. Automatic code and security reviews completed; code review had no findings. Root and independent source review were clear, and the squash merge was guarded by that exact head. This removes directly demonstrated unnecessary work; no dollar savings or reduction in storage latency has been measured.

### Cache upload errors and database acquisition

The accepted OpenCode publication at `acc115c8082a00881fc3d1daef8af08b62458a85` had successful native builds and image publication, while both optional cache warmers emitted upload-failure warnings. A bounded Attic log read for **2026-11-21 09:57:00–10:01:00 UTC** identifies three database connection-pool acquisition timeouts:

| Server time (UTC)  | Fixed cause classification        | Retained operation |
| ------------------ | --------------------------------- | ------------------ |
| 09:58:19.222918714 | Database pool acquisition timeout | Not established    |
| 09:59:21.803505378 | Database pool acquisition timeout | Not established    |
| 09:59:51.806707472 | Database pool acquisition timeout | `upload_path`      |

The first server error precedes ARM job `136803636307`'s retained `InternalServerError` at `09:58:19.2240516` by approximately **1.13 ms**. This is temporal alignment, not an exact request join: the retained client records contain no shared request or NAR identifier. The client's later summary at `09:58:56.6932798` has no separately logged matching server error in this window. This window does not establish the AMD warmer's specific cause.

The pinned upstream source `zhaofengli/attic@12cbeca141f46e1ade76728bce8adc447f2166c6`, `server/src/error.rs:136–156,203–219`, logs database/storage errors internally and maps them to client `InternalServerError`/HTTP 500. The deployed `0e9b29ee77eaa836990a858e785bbcd608b8eb34` diagnostic patch changes download-stream observation only; it changes neither upload processing nor this error conversion.

The fixed window contains six ERROR records: three classified database errors and three unclassified error records. It contains no matched `StorageError` or download `Stream error`. This does not establish storage health outside the selected events, nor explain why the database pool could not supply a connection. The underlying database latency, connection availability, GC, S3 and Ceph contributions remain unattributed; the source follow-up below narrows the connection-lifetime question. No SQLSTATE or shared request identifier was retained from these errors.

The first read retained aggregate error counts but its 200-event output cap was consumed by unrelated warnings. An authorized correction read used the **same window**, filtered ERROR records before the 40-event cap, and retained all six errors. Neither read hit its log byte or line cap; the correction selected the same 770 log lines, with no timestamp parse failures. Post-window lines returned by the bounded Kubernetes logs command were discarded. No raw error text, SQL, URL, header, HTTP body or credential is retained. No upload, retry, database/storage query, fault injection or workload mutation was performed.

The [sanitized error-window receipt](attic-upload-error-window-corrected-20261121.json) includes hashes of the immutable upstream error, upload and S3 source files and the deployed download diagnostic patch, plus the original capped-receipt hash.

### Database pool follow-up

The deployed application uses the pinned SQLx pool defaults: **maximum 10 connections, minimum 0, acquisition timeout 30 seconds, idle timeout 600 seconds and maximum connection lifetime 1,800 seconds**. Idle connections are tested before acquisition. The deployed database configuration supplies only heartbeat=true; Attic calls Database::connect with the connection URL and does not set pool overrides. This follows immutable Attic 12cbeca141f46e1ade76728bce8adc447f2166c6, SeaORM 1.1.13 and SQLx 0.8.6. Downloaded dependency sources were verified against the upstream lockfile checksums. No connection URL or secret was emitted or retained.

An SQLx acquisition timeout can cover waiting for a permit, checking an idle connection or opening a new connection. The three observed errors therefore do **not** prove all ten connections were busy, that PostgreSQL reached its connection limit, or that increasing the application pool would help.

The same **09:57–10:01 UTC** PostgreSQL log window contains only three checkpoint records:

| Completed at (UTC) | Total seconds | Write seconds | Sync seconds |
| ------------------ | ------------: | ------------: | -----------: |
| 09:59:05.026138338 |       391.169 |       362.640 |        1.977 |
| 10:00:31.116770294 |        86.091 |        66.436 |        6.010 |

A new checkpoint starts immediately after the first completion. These elapsed times overlap the application failures, but checkpoint write time can include pacing and is not individual device latency. The window contains no logged slow statement, lock wait, deadlock or connection-limit event. Effective logging coverage could not be established: one READ ONLY query of 15 allowlisted pg_settings, bounded to three seconds, returned a statement-timeout error and no rows. It was not retried. This current latency observation does not reconstruct historical pool occupancy.

A historical Mimir query at 09:58:30 found database-size metrics but no matching CNPG backend/activity/wait metric family. It supplies no connection-occupancy or wait-state explanation.

The inspected upload, deduplication and garbage-collection code does not hold a SQL transaction across remote-storage waits. Uploads finish the remote transfer before beginning final database transactions; garbage collection completes its database reads before remote deletion. NarGuard and ChunkGuard retain a clone of the shared pool and application-level holder counters, not a checked-out connection. These guards should not be mistaken for SQL locks held throughout the transfer.

**Supported conclusion:** database connection acquisition failures are established; the underlying cause remains unproved. No reproducible connection-lifetime defect or evidence-backed pool adjustment was identified. No pool, logging, source or workload change was made. There were no upload retries, workload injections or performance trials.

The [pool-diagnosis receipt](attic-pool-diagnosis-20261121.json) links the sanitized log/config/metric observations and hashes ten immutable source files.

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
