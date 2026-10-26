# Alert delivery saturation and Bayn projection failures

## Impact summary

The October 26 investigation found 480 lab alert emails in Gmail's three-day search, including 149 in the latest
24-hour window. Bayn accounted for 370 messages. The largest groups were input-window warnings, 117 messages;
runtime degradation, 81; CI queue delays, 46; Valkey latency, 44; cycle failures, 35; and cache publication failures, 34.
These counts describe notifications, not distinct outages.

The CI queue sent 46 messages between 00:57 and 04:57 UTC. Group updates combined changing firing and resolved
workflow alerts. At 04:55 UTC one message contained one firing alert and twelve resolved alerts; another message
reported all thirteen resolved two minutes later.

Bayn also had real failures. At 05:24 UTC both API replicas reported `DEGRADED` with
`CYCLE_OBSERVATION_UNAVAILABLE`. Their local metrics endpoints returned HTTP 200. PostgreSQL connectivity remained
available, but the cycle projection statements were canceled by the database's statement timeout. A prior `READY`
transition at 05:13 UTC did not establish sustained recovery.

## Root cause

The investigation found separate defects in notification delivery, telemetry ingestion and database discovery.

1. Both email routes permitted a new group update every two minutes. The four-hour warning repeat applied to an
   unchanged notification, not to changing workflow membership. Recovery notifications added another message.
   CI queue alerts retained workflow and job-family identities; Bayn runtime and cycle alerts retained Pod instances.
   Short recoveries and Pod replacement therefore changed the notification set.
2. The Mimir tenant reached its default global limit of 150,000 head series. Each of the three ingesters was exactly
   at its 50,000-series local allowance and continuously rejected new series with `err-mimir-max-series-per-user`.
   Existing series continued to update while new Pod and revision identities were rejected. Alloy had discovered
   both Bayn targets and successfully scraped them in milliseconds. The absence of `up{job="bayn"}` in Mimir was
   therefore not proof that their HTTP endpoints were down. The existing tenant overrides were also nested under
   `mimir.runtimeConfig`, which chart 6.2.0 ignores; the rendered runtime file was `{}`. The chart consumes root-level
   `runtimeConfig`, so checking source values alone did not establish that a limit was applied.
3. CI observability exported detailed cumulative phase histograms alongside the completion-window gauges used by
   the dashboard. `ci_job_phase_duration_seconds_bucket` alone occupied about 46,600 active series. The phase,
   BuildKit and workflow histogram buckets were not queried by dashboard timing panels. Dashboard filters used
   their count series, so those callers needed migration before retiring the exports.
4. Inference-expense discovery read `payload->>'schemaVersion'` for every resolved historical request to determine
   whether it needed one provider quote or two. This repeatedly deTOASTed chart payloads even when both quotes were
   already complete. PostgreSQL recorded expense-statement cancellations while waiting for data reads. This is a
   confirmed avoidable source of I/O; it does not establish the sole cause of concurrent cycle and Kafka stalls.
5. After version metadata was installed, discovery still performed correlated quote counts and ordered receipt
   lookups across historical requests. The production plan estimated roughly 7,000 pending requests and expected
   the 64-row limit to stop early. With almost all history already quoted, the real scan instead walked that
   history. At 07:28 UTC, PostgreSQL again canceled expense discovery and several foreground statements. A later
   controller failure caused both APIs to report `CYCLE_RUNNER_UNAVAILABLE` at 07:30 UTC even though database
   connectivity and cycle observation were available. Earlier `READY` samples therefore did not establish
   sustained recovery. Discovery must group metadata once before loading the bounded pending batch.
6. The remaining Mimir HTTP 500s expired at approximately 5.00 seconds. Effective configuration showed a
   five-second distributor deadline around a Kafka writer with a ten-second timeout and two-second overhead;
   Alloy clients allow thirty seconds. The ruler's internal distributor allowed ten seconds. Callers could cancel
   writes before Kafka's existing bounded
   write budget completed. Give HTTP distributors and the ruler's internal distributor a fifteen-second caller
   budget while retaining the Kafka and exporter limits. This does not repair physical disk latency or justify
   treating stale samples or Kafka delivery failures as healthy.
7. The main Bayn image workflow watched test modules as production release inputs. Commit
   `3893402f2e29a337c90f21b31b903e373fa334f2` changed only two integration tests, but published another image and
   reactivated the execution controller seven minutes after the preceding release. Those controller-generation
   transitions add avoidable readiness alerts. Exclude `services/bayn/**/*.test.ts` from main publication while
   retaining pull-request validation and publication for runtime source, migrations, dependencies and workflow
   changes. Local path-filter checks cover the actual test-only commit, the runtime repair and mixed changes.
8. Storage still has a long queueing tail after the application repairs. At 09:33 UTC, the 120 retained slow
   operations across six OSDs showed waits up to 14.4 seconds between queue admission and reaching a placement
   group on OSDs 0–2. OSDs 3–5 instead waited up to 6.7 seconds for replica commits. None of those retained records
   contained an explicit scrub-wait event. This establishes storage queueing; it does not establish scrub
   concurrency as its sole cause or justify treating longer application deadlines as a storage repair.

## Five Whys

### Email amplification

1. Why did the same queue incident produce dozens of emails? Individual workflows joined and left its alert group.
2. Why did each change send another message? The route allowed group updates every two minutes and sent recoveries.
3. Why was the group changing so often? Alert identity followed workflow families and Pod instances rather than the
   affected runner pool or service, and several conditions resolved between brief failures.
4. Why did the repeat setting not prevent this? Repeat intervals govern unchanged notifications. They do not replace
   group-update intervals or incident recovery holds.
5. What must change? Use stable operational identities, preserve immediate first detection where required, hold
   brief recoveries and batch warning updates separately from critical updates.

### Missing telemetry

1. Why were new Bayn metrics missing despite successful local scrapes? Mimir rejected new series.
2. Why were they rejected? The tenant had reached its 150,000-series budget.
3. Why did the budget fill? Detailed CI histograms multiplied phase and cohort combinations while existing gauges
   already served timing comparisons.
4. Why was this reported as an application problem? Ingestion capacity and rejected samples were not retained in the
   central collector; downstream missing-metrics alerts could not identify the shared admission failure.
5. What must change? Remove unused exports, give the tenant bounded headroom, and monitor its actual ingester
   allowance, head-series count and rejection counters. Validate the rendered runtime ConfigMap as well as values.

## Contributing factors

- The input-window warning deliberately has `for: 0s` because admission windows can expire within one minute. Its
  first notification must remain immediate; a longer initial alert threshold would hide a real missed window.
- The original subject showed only status and alert name, hiding the affected service and changing firing counts.
- Mimir distributors also reported Kafka acknowledgement timeouts. Kafka brokers and controllers logged concurrent
  heartbeat and controller-event delays. These are separate transport failures from the series admission limit.
- PostgreSQL logged multi-second commits and inference-expense statements repeatedly timing out while waiting for
  data reads. The expense discovery plan scans historical request payloads and checks existing quotes repeatedly.
  This is a demonstrated source of background I/O; a query-plan repair requires its own behavioral and performance
  evidence. The telemetry repair alone does not prove that Bayn's runtime problem is fixed.

## What was not the root cause

- The missing Bayn series were not caused by failed Kubernetes target discovery or failed local HTTP metrics
  endpoints. Both targets were present and locally scrapeable.
- A resolved email, a `READY` log, or Argo health does not prove current application recovery.
- Ceph scrub warnings were routed to the quiet receiver and contributed no emails in the sampled search. The mail
  flood predates the October 26 increase in scrub concurrency. This does not exclude shared storage latency from
  contributing to the separate database and Kafka stalls.

## Recovery actions

- Retire detailed phase, BuildKit and workflow histogram exports. Keep completion-window timing gauges and the
  original SQLite/Loki records. Migrate dashboard filters to `ci_jobs_completed`.
- Set the shared tenant's runtime series allowance to 300,000. This is bounded headroom, not a replacement for
  removing the cardinality source. Existing ingester memory use was approximately 250 MiB per Pod at the old limit.
- Scrape bounded ingester metrics. Warn above 80% of the live allowance, page on rejected series and page when
  ingester telemetry is incomplete.
- Aggregate build-queue alerts by namespace, runner pool and architecture. Aggregate Bayn runtime and cycle alert
  identity by job, namespace and service after evaluating each replica's joined conditions.
- Hold brief input, cache, cycle and queue recoveries for five minutes. Keep the input warning's immediate first
  detection. Batch warning group updates every fifteen minutes and critical updates every five minutes. Preserve
  four-hour warning and one-hour critical repeats and resolved notifications.
- Include service and firing/resolved counts in email subjects. A missing API scrape inhibits the corresponding
  native-operation telemetry warning for that same service; runtime and financial safeguards remain independent.
- Store each request's wire version in a generated column derived from its immutable payload. Discover pending
  expenses using that metadata, then load and verify the complete selected batch. Existing quote identities, late
  receipts and accounting coverage retain their original contracts.
- Apply and verify the rendered fallback Secret before a separate reviewed Alertmanager revision bump, as required
  by the [email deployment contract](../runbooks/mimir-email-alerting.md#deployment).
- Align distributor and ruler caller budgets with the existing Kafka writer budget through component arguments.
  Roll only those callers; preserve the stateful workloads and their PVCs.
- Exclude test modules from main Bayn image publication. Keep normal PR tests and production release inputs.

## Final verification

Source verification uses native Prometheus rule evaluation for queue identity, replica changes, immediate
input-window detection, recovery holds and Mimir admission alarms. A representative 40-cohort collector fixture
exported 4,847 samples before the change and must remain below 2,000 afterward, preserving phase and p95 evidence.
The collector suite also covers restart idempotency and retained historical histogram rows. The repaired fixture
exports 1,007 samples, a 79.22% reduction, while preserving the queried timing gauges.

The first repair merged as [PR #15422](https://github.com/proompteng/lab/pull/15422), commit
`ee18ce6c8093e73439dc2903ee3066636fa55dcf`. Argo reconciled it and subsequent main commits successfully. At
06:28–06:33 UTC, all three ingesters exposed a 100,000-series local allowance, and their series-limit rejection
counters did not increase. Both Bayn API scrapes and both execution-controller heartbeats were current. The retired
CI phase buckets had no active series. Both API replicas directly reported `READY` with cycle observation available
at 06:32 UTC; the source revision was `bc6c66fa403b74f4b3b0c9c746149ea97f3a9b86`.

The rendered fallback Secret, resource version `740621478`, was verified after the first rollout: critical updates
every five minutes, warnings every fifteen minutes, ten-second first delivery, unchanged repeat intervals, the
scoped inhibition and the service/count subject. The subsequent annotation bump activated this already verified
configuration. Active tenant readback at 07:02 UTC confirmed the routes, subject, resolved notifications and scoped
inhibition. Genuine Gmail messages subsequently arrived with the new service and firing/resolved counts.

On an isolated PostgreSQL 18.1 fixture containing 5,000 completed chart requests and one pending request, the expense
repair returned the same pending source. The warm median execution time fell from 23.511 ms to 10.236 ms and shared
buffer accesses from 40,439 to 20,416. This is a local comparison, not a production latency guarantee. The complete
Bayn unit suite passed 3,859 tests with zero failures; 868 external integration cases were skipped. Separately, the
affected PostgreSQL expense and entry suites passed 25 tests against PostgreSQL 18.1; three TigerBeetle-dependent
cases were skipped. Type checks, lint and the production build passed.

The grouped discovery repair retains the same pending source on both PostgreSQL fixtures. With 5,000 completed
single-provider requests, shared buffer accesses fall from 20,416 to 586 and warm median time from 8.488 ms to
6.915 ms. A mixed fixture with completed single/two-provider requests and larger handoff/receipt payloads falls
from 23,517 to 3,375 buffer accesses, with warm median time from 10.497 ms to 9.015 ms. These are local comparisons.
An `EXPLAIN` without execution against production statistics confirms bulk metadata joins, with full-payload
lookups only after the materialized 64-request selection. The affected PostgreSQL suites pass 26 tests, including
ordered batches after quoted history, account isolation, immutable quotes and late receipts.

[PR #15427](https://github.com/proompteng/lab/pull/15427), commit `d7f5a0136849929c94e7b11e7eae498a6ea93100`,
reduces deep-scrub chunks from fifteen objects to five while retaining the requested `osd_max_scrubs=3`. All six
effective daemon configurations reported the new size at 06:54:42 UTC. Adjacent five-minute windows show PostgreSQL
WAL fsync averaging 317.342 ms before and 202.690 ms after. Kafka timeout log lines were zero in both adjacent
windows, so their earlier recovery cannot be attributed to this change. Eighteen scrubs remained active, and all
fourteen sampled deep-scrub counters advanced afterward. This is an observational improvement under changing
production load; the remaining latency and later SQL cancellations prevent a sustained-storage-recovery claim.

Deployment acceptance must separately establish the reviewed revision, rendered fallback Secret, active tenant
configuration, all three ingester targets, zero new series-limit rejections during the observation window, restored
Bayn scrapes and the exact API revision's native heartbeat. Bayn recovery also requires direct repeated status reads
and its cycle observation path; fewer emails do not satisfy that gate.

The grouped discovery repair merged as [PR #15431](https://github.com/proompteng/lab/pull/15431), commit
`10c83f54a0ee23bb9326dc19448600be91086424`, after all 26 CI checks passed. Local validation passed 3,859 unit tests
with zero failures; 869 external cases were skipped. The native PostgreSQL suites passed 26 tests, with three
TigerBeetle-dependent cases skipped locally and the selected ledger integration passing in CI. A read-only
production comparison in one snapshot returned zero pending rows for both queries: the grouped plan touched
19,274 buffers versus 199,386. The first grouped read took 1.522 seconds with 1,675 physical reads; a subsequent
warm read took 184.681 ms, versus 249.518 ms for the cached original. These samples do not establish a latency SLO.

The main image build `40289906963` published both architectures and index
`sha256:d11a478260dfea498dd1b1a140313e543ba472baa7a11347b7cf56edd931275c`. Freight
`a5695a6ceef4dd1e9c46597930f61e89487c4fc8` automatically promoted through `kargo/bayn` commit
`68798bd4d5bdc02a425d599da5f8ca89bb827d7e`; Kargo verification succeeded at 08:15:02 UTC. Both API replicas
directly reported `READY` at 08:18 UTC. A subsequent test-only main commit `3893402f2e29a337c90f21b31b903e373fa334f2`
published another image and promoted at 08:21 UTC. Its production expense-discovery source is identical. At
08:22 UTC both APIs were ready, natural expense passes had discovered three sources and verified six quotes with
zero gaps, and no Bayn statements had been canceled since 08:15 UTC. Series-limit counters still had zero additional
drops. Kafka acknowledgement errors persisted, so the complete transport-recovery gate remained unsatisfied.

[PR #15432](https://github.com/proompteng/lab/pull/15432), commit `65a66cc51b73a524ef9bb0f64bd109a7e2d52651`,
aligns the write budgets. Native Mimir 3.2.1 configuration validation passed for both affected roles. Rendered Pod
templates changed only for distributor and ruler. At 09:05:36 UTC, both distributor replicas and the ruler were
ready and reported `distributor.remote_timeout: 15s` from their live `/config` endpoints. All 21 captured stateful
Pod UIDs and all 13 PVC UIDs were unchanged.

The first combined acceptance window after budget alignment lasted 442.6 seconds, from 09:05:36 through
09:12:58 UTC. Both APIs remained ready in the sampled metrics, all four heartbeats were current, natural expense
projection completed, and there were no Bayn statement cancellations, series-limit drops or Kafka write failures.
At 09:16–09:17 UTC, a later burst exhausted Kafka's own producer deadline, with HTTP failures lasting up to
14.08 seconds. The caller-budget defect was repaired, but that earlier quiet window did not establish sustained
transport recovery. The subsequent storage wait evidence leaves that risk open.

[PR #15433](https://github.com/proompteng/lab/pull/15433), commit `1967e3c9fe1368fa28e21b3e50ed7fe02356fa24`,
excludes Bayn test modules from main publication. Actionlint passed. Ordered path matching excludes the actual
test-only commit while including the runtime repair, mixed source/test edits, migrations, shared dependencies and
workflow changes. The PR workflow remains enabled. The filter's own workflow update is still a release input;
future test-only main events are configured to skip publication without manufacturing a production test commit.

The filter update's final main image build, `40297257529`, published
`sha256:15916b355e2d8072f450b7f988563bff3869bfb14440620e9152d1fbbee96e97`. Freight
`2d5f527595344cbe38fafaee2a97d2f368b3a532` automatically promoted through `kargo/bayn` commit
`44d1651500cc371ab4badda161c86b9420c66dd3`; verification succeeded at 09:20:03 UTC. Argo reported that exact
commit synced, healthy and successfully applied. During the following 725-second observation window, both APIs
directly reported the selected revision and digest with `READY` and cycle observation available. Both API and both
controller heartbeats were fresh, all ten observed expense passes completed, no Bayn statements were canceled,
and no Kafka write failures or write HTTP 5xx occurred. All three series-limit rejection counters remained
unchanged from the 06:28 UTC baseline. The selected alert rules were present and healthy. This is a bounded
runtime acceptance result, with the later storage queueing tail still requiring action.

The same final window contained 44 Codex OTLP invalid-temporality rejection log lines. The only firing Bayn or
observability rule returned by the final check was the quiet `BaynResearchCostCoverageIncomplete` warning. Those
facts remain separate from successful Bayn scrapes, runtime readiness and series admission.

Extending that same observation through 09:37 UTC failed the runtime gate: readiness dipped, Kafka producer errors
recurred and write HTTP 5xx returned. Both direct API reads were ready again, and PostgreSQL still recorded zero
Bayn statement cancellations. At 09:38 UTC, the active rule set also contained email-enabled
`BaynCycleStalled` and `CephOsdCommitLatencyCritical` alerts. These are real remaining runtime symptoms. The query,
series-admission and notification repairs are deployed; sustained application and storage recovery is not proven.

An early Kafka log check is explicitly invalid: it searched for `acknowledgement`, while the logs used
`acknowledged`. The corrected check found recurring failures through 06:37 UTC and again after the SQL repair.
The transport gate uses the corrected patterns and remains independent of API readiness or resolved emails.

## Follow-up actions

- Shared HDD latency remains a capacity limitation. The scrub comparison is observational, and a bounded quiet
  window does not establish long-term storage recovery. Preserve transaction durability and `osd_max_scrubs=3`.
  The user confirmed that the cap must remain three; the proposed reduction trial is canceled. All six running
  OSDs reported three at 16:21 UTC. Investigate queueing and workload I/O with this constraint fixed. Storage
  isolation or additional hardware requires a separate concrete decision.
- Ceph still has overdue deep scrubs and a previously recorded October 20 daemon crash. Preserve the integrity
  warnings and require advancing scrub progress; do not archive or silence them to make health appear clean.
- `BaynResearchCostCoverageIncomplete` remains a quiet warning for incomplete research cost evidence. Missing
  prices, allocation or receipts must be resolved as accounting evidence, not replaced with fabricated zero costs.
- Codex OTLP metrics also have type/temporality rejections. Those input-validation failures are separate from the
  Bayn scrape admission and Kafka transport mechanisms; their exporter contract remains to be corrected.
- A reduction in daily email volume requires a longer comparable workload window. The reproduced notification
  mechanism, active route settings and genuine updated email subjects establish the implemented behavior.

## References

- [CI collection and alert contract](../../argocd/applications/observability/ci/README.md)
- [Alert routing source](../../argocd/applications/observability/observability-alertmanager-email-externalsecret.yaml)
- [Mimir runtime allowance](../../argocd/applications/observability/mimir-values.yaml)
- [Bayn cycle operations](../runbooks/bayn-cycle-operations.md)
