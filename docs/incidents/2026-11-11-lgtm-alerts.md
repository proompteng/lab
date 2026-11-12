# LGTM alerts on November 11, 2026

## Findings

Observations below were captured between 20:40 and 20:55 UTC. These alerts have separate causes.

| Incident                              | Evidence                                                                                                                                     | Action                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CI image jobs exceeded twenty minutes | Images built in 60–188 seconds. Three artifact uploads failed after 629–633 seconds; GitHub retained running job records after runner exit.  | Bound artifact uploads to five minutes, retain publication gates, and expose the current job phase in alerts.                            |
| Ceph `BLUESTORE_SLOW_OP_ALERT`        | OSD 0 logged five-second reads during HDD scrub pressure. Its NVMe DB stayed below one millisecond. The warning retains events for 24 hours. | Preserve detection and scrub policy. Improve the alert's investigation path and distinguish retained events from current client latency. |
| Research cost coverage                | All 69 unknown costs belong to October 12–23 runs with no cost basis. No later attempts or pending priced expenses were found.               | Keep historical debt informational; warn separately on new unknown costs, ambiguous claims and overdue expense verification.             |

## CI artifact upload and finalization

[Main run 43092941901](https://github.com/proompteng/lab/actions/runs/43092941901), source
`0950a9fd9429cf3f0ee0e14d370225de55532218`, included the earlier CI simplification.
The platform job steps reported:

| Image/platform | Build | Registry push | Attic upload | Log artifact upload |
| -------------- | ----: | ------------: | -----------: | ------------------- |
| Research ARM64 |  188s |           19s |          14s | Failed after 629s   |
| Trading ARM64  |  183s |           12s |          11s | Failed after 633s   |
| Trading AMD64  |   60s |            6s |          10s | Failed after 632s   |
| Research AMD64 |   67s |           11s |          17s | Succeeded in 2s     |

The failed uploads finished around 20:29:35–54 UTC. Cleanup and completion steps finished too.
ARC recorded successful runner-process exits and removed the trading runners at 20:29:40 UTC.
GitHub still reported three jobs as running at 20:48 UTC. Its cancellation endpoints rejected cancellation as
already completed or not in progress, contradicting those reads. No cancellation was confirmed.

At 20:51 UTC, [GitHub's status API](https://www.githubstatus.com/api/v2/summary.json) reported an Actions major outage,
alongside degraded Webhooks and Pages. Earlier responses had reported operational status.
GitHub job-log downloads returned HTTP 502, preventing inspection of the original artifact-upload error.
The upstream outage corroborates a GitHub service problem, but does not establish the exact transport failure.
There is no evidence here that Nix compilation, runner CPU or Ceph caused these build alerts.

The twenty-minute job threshold remains unchanged. The collector now reports bounded current-phase ages.
`finalizing` means every reported step finished while GitHub still reports a running job. Missing step data remains
`unattributed`; it cannot suppress the whole-job warning. Log artifact uploads have a five-minute hard deadline.
An upload failure still prevents a successful publication receipt and cohort promotion.
See [CI observability](../../argocd/applications/observability/ci/README.md).

## CI telemetry quota

At 20:54 UTC, `CiObservabilityCollectionStale` fired and the history-scan warning became pending.
The collector remained ready, had no restarts, and its metrics scrape was healthy. Its logs repeatedly reported
`GitHubQuotaError: GitHub shared API quota reserve reached; waiting for reset`.
The last recorded API allowance was 996 requests. The existing collector deliberately pauses below 1,000 requests
until the shared quota resets, preserving capacity for ARC and other consumers.

This is distinct from the upstream Actions outage. Polling staleness correctly suppressed `CiBuildStalled`,
since its job observations could no longer establish a currently running build. Keep the reserve and freshness gates;
do not lower them to clear either alert. The available evidence does not attribute shared-account consumption
to a particular consumer.

Historical index discovery did have a concrete budget defect. Pending historical job collection paused below
2,000 remaining requests to preserve live polling headroom, but index discovery ignored that reserve.
A regression test reproduced historical requests consuming the foreground allowance. Index discovery now observes
the same 2,000-request reserve and resumes its existing iterator when foreground polling observes renewed quota.
Live polling remains permitted between 1,000 and 2,000 requests. This protects the collector's own budget priority;
it does not establish which consumer exhausted the shared allowance or prevent other consumers from doing so.

## Ceph HDD read pressure

OSD 0's data is on a rotational Seagate ST24000NM000C HDD. Its BlueStore DB is on Kingston SNV3S1000G NVMe,
shared with two other OSDs. An NVMe DB does not make data reads use NVMe.

OSD 0 logged a 5.185-second scrub read with 1,021 underlying I/Os at November 10 05:00:25 UTC.
At 23:59:52 UTC, two reads took 5.11–5.15 seconds with 828–829 I/Os.
During those five-minute windows, the HDD queue averaged 24–28 requests, read latency 57–66ms,
utilization 83–89%, and scrub throughput 61–64 MB/s. NVMe reads remained near 0.42ms,
writes near 0.30ms, and BlueFS fsync near 0.63ms.
HDD read contention under scrub load is the strongest proximate explanation; its exclusive cause is unproven.

No later slow-operation event appeared in retained November 9–11 logs. Effective warning lifetime was 86,400 seconds
and threshold one. The warning can therefore remain active until approximately November 12 00:00 UTC without
another event, followed by manager propagation and the alert's ten-minute recovery hold.

All six OSDs were up and in; all 601 placement groups were clean, including active scrubs.
Deep-scrub completion advanced at 20:44:22 UTC. Nineteen groups were older than seven days, oldest 8.30 days;
none exceeded fourteen days. No recovery or backfill was active at the snapshot.
HDD SMART showed no reallocated, pending or uncorrectable sectors or command timeouts. NVMe reported no media errors.
These snapshots do not exclude intermittent hardware faults.

Current latency still requires care. A completed 1.68-second write spent 0.42 seconds committing locally and
another 1.06 seconds awaiting OSD 4. An empty in-flight snapshot or zero current commit gauge does not prove
the absence of client tail latency. Do not attribute every delay to OSD 0's HDD.

No storage settings changed. The previous single-object scrub-batch trial was reverted after failing to prove
application recovery. Another concurrency or stride experiment needs representative client latency and scrub-progress
baselines, one changed variable, and a reviewed GitOps rollback.
See the [retained BlueStore warning procedure](../runbooks/ceph-performance-telemetry.md#investigate-retained-bluestore-slow-operation-warnings).

## Research accounting evidence

Read-only database aggregates found 69 receipts and 69 claims from October 12–23.
Every associated original run had `costBasis: null`. Outcomes comprised 53 completed, 14 rejected,
one expired and one unavailable attempt. There were no later attempts, orphan claims or pending priced expenses.
The unpriced count stayed at 69 throughout seven days, while the worker heartbeat was 13 seconds old.

Current provider prices cannot establish those historical capacity allocations. Unknown costs remain unknown,
and continue to prevent a fully costed comparison. Receipts, hashes, claims and financial projections were preserved.

`BaynResearchCostCoverageIncomplete` now describes retained debt at informational severity.
`BaynResearchCostCoverageDegraded` warns after ten minutes of new unknown costs within the preceding hour,
any ambiguous claims, or priced expenses waiting more than 300 seconds. Shared-store gauges are aggregated
across replicas before comparing history, avoiding counter-reset interpretations during replacement.
See [research cost triage](../bayn/jev-optimization.md#research-cost-coverage-triage).

## Earlier Bayn event-loop incident

The earlier cache-publication failure had a separate, reproduced mechanism. Decision construction occupied the
controller's main thread for 3.387 seconds while a Valkey SET exceeded its one-second budget and was interrupted
after 4.353 seconds. Valkey command latency, replication and memory did not indicate server saturation.
Bayn PostgreSQL data/WAL and Valkey persistence were already on local NVMe.

[PR #15857](https://github.com/proompteng/lab/pull/15857) moves live decision construction to an owned worker,
preserves deterministic documents, and physically terminates work on cancellation. It passed unit, integration,
compiled Node responsiveness, packaging, code and security checks and merged as
`8ffc1cf9b791a3430ec2d08497874c03efc52300` at 20:45:47 UTC.
Its [main publication run](https://github.com/proompteng/lab/actions/runs/43097965198) was queued during the GitHub outage.
Merge does not establish deployed behavior or a measured production latency improvement.

At 20:48 UTC, the still-deployed prior image reported readiness, exact reconciliation and zero unresolved mutations.
No Valkey failure increment appeared in the preceding thirty minutes. These observations establish recovery at that
time; they do not prove the new worker's runtime acceptance.
