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

There were independent causes for notification amplification and missing telemetry.

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
scoped inhibition and the service/count subject. The subsequent annotation bump activates this already verified
configuration. Active tenant configuration still requires readback after that rollout.

On an isolated PostgreSQL 18.1 fixture containing 5,000 completed chart requests and one pending request, the expense
repair returned the same pending source. The warm median execution time fell from 23.511 ms to 10.236 ms and shared
buffer accesses from 40,439 to 20,416. This is a local comparison, not a production latency guarantee. The complete
Bayn unit suite passed 3,859 tests with zero failures; 868 external integration cases were skipped. Separately, the
affected PostgreSQL expense and entry suites passed 25 tests against PostgreSQL 18.1; three TigerBeetle-dependent
cases were skipped. Type checks, lint and the production build passed.

Deployment acceptance must separately establish the reviewed revision, rendered fallback Secret, active tenant
configuration, all three ingester targets, zero new series-limit rejections during the observation window, restored
Bayn scrapes and the exact API revision's native heartbeat. Bayn recovery also requires direct repeated status reads
and its cycle observation path; fewer emails do not satisfy that gate.

## Follow-up actions

- Verify migration 150 and the expense discovery path after the reviewed Bayn image passes normal publication and
  Kargo promotion. The local result comparison does not establish production recovery.
- Confirm the Kafka acknowledgement and database latency windows after telemetry admission recovers. Do not infer
  their resolution from notification changes or weaken transaction durability to make the alerts quiet.
- At 06:32 UTC, PostgreSQL had no statement cancellations in the preceding twelve minutes, but WAL fsync still
  averaged approximately 287 ms over five minutes. A corrected distributor log check found Kafka acknowledgement
  timeouts recurring through 06:37 UTC. The first check missed the log's `acknowledged` wording; its negative result
  is invalid. No series-limit errors occurred in that fifteen-minute check. Shared storage latency and intermittent
  Kafka transport failures remain separate unresolved limitations. Ceph already uses `high_client_ops`; the HDDs
  were 74–94% busy, with 18 active scrubs and no misplaced or degraded placement groups.

## References

- [CI collection and alert contract](../../argocd/applications/observability/ci/README.md)
- [Alert routing source](../../argocd/applications/observability/observability-alertmanager-email-externalsecret.yaml)
- [Mimir runtime allowance](../../argocd/applications/observability/mimir-values.yaml)
- [Bayn cycle operations](../runbooks/bayn-cycle-operations.md)
