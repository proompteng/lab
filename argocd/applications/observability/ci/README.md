# CI performance observability

[CI Build Performance](https://grafana.ide-newton.ts.net/d/ci-build-performance) combines GitHub Actions timing,
cache evidence, sanitized build records and historical runner resource metrics. The existing ARC capacity dashboard
continues to cover scheduling reservations and pod states.

The observability Argo application owns one central collector in the `arc` namespace. It uses ARC's existing
`github-token` Secret for read-only GitHub API requests. It does not change token identity, scopes, runner templates
or worker capacity. The Pod has one container, no Kubernetes API token, and no sidecars. Its pinned upstream Python
image runs the committed ConfigMap source using the same deployment pattern as existing observability helpers.

## Collection and storage

The collector polls active runs and today's completed runs every 60 seconds. It scans the previous 90 creation-day
windows so that older reruns are discovered even if they finish between polls. Each history pass has a ten-second
budget and resumes its current search next cycle; current metrics are published before that pass. Conditional
GETs retain ETags in memory; unchanged authenticated responses avoid spending GitHub's primary rate-limit quota.
Search windows over GitHub's 1,000-result limit are split before pagination. Collection errors and rate-limit backoff
remain visible in metrics; stale collection never becomes a fabricated empty queue or successful build.

The target is to collect a completed attempt within five minutes during healthy API operation. Newest completed
attempts take priority over backfill. Completed jobs are collected while their workflow is still running, so one
slow architecture cannot delay another job's telemetry. Backfill pauses below 2,000 remaining API requests, leaving
headroom for current runs before the shared 1,000-request ARC reserve. The initial backfill covers attempts updated within 14 days. Detailed SQLite
job records retain 90 days; collection-delay aggregates and deduplication keys survive Pod restarts on the 1 GiB retained
Ceph claim. The single replica and `Recreate` rollout serialize SQLite writers. Do not scale this deployment.

Run ID and attempt number identify each workflow attempt. Jobs come from the attempt-specific jobs endpoint;
carried-forward jobs from another attempt are excluded. Job creation-to-start gives queue time. Assigned job
start-to-completion gives execution time. A cancelled job without a runner contributes queue time but no invented
execution duration. Workflow duration uses that attempt's job timestamps rather than the original run creation
time, which would include time between reruns. A workflow outcome is retained separately from its jobs' outcomes.

Alloy scrapes the collector every 30 seconds and remote-writes its metrics to Mimir. The durable outbox pushes
sanitized workflow/job records to existing Loki. Retries preserve the same timestamp, labels and line. The Loki
timestamp is observation time; `completed_at` preserves the actual GitHub event time. Backfill does not enter the
one-hour volume or comparison windows as new builds. Loki and Mimir keep their existing retention policies.
If an unacknowledged record exceeds Loki's 168-hour admission window, it moves atomically into retained
`loki_rejections` storage with its original timestamp, labels and content. The rejection metric and alert remain
visible while newer records continue shipping. Inspect that table and the existing job facts before controlled
recovery; do not clear the retained evidence to silence the alert.
Permanent HTTP 400/413 responses are isolated by splitting the batch. Individual rejected records retain their
original payload and HTTP status in the same table; retryable failures keep their original outbox entries.

Metric labels are limited to enrolled workflow filename, declared job family, architecture, runner pool, job role, event, outcome, phase,
cache class and fixed statistical windows. Run IDs, commit SHAs, job names and runner Pod names are record fields,
not metric or Loki stream labels. Raw job logs, GitHub actor profiles and credentials are not stored or forwarded.
Signed log download URLs receive no GitHub Authorization header.

`workflows.json` enrolls image workflows and their reusable callers. The scripts CI check discovers build actions
and reusable callers from workflow YAML and fails if a new image workflow is missing. Regenerate it with
`bun run packages/scripts/src/ci/generate-observability-workflows.ts` when adding a workflow. Diagnostic image builds
can be included; ordinary semantic checks are excluded.

## Interpreting the dashboard

The default view selects ARC, image-build jobs, and push events. Hosted runners, publishing jobs, validation jobs,
manual diagnostics and pull requests are independently selectable. Compare like runner pools and architectures.
Declared job families separate image targets inside shared workflows. Architecture comes from runner labels first,
then the job name; it remains unknown when neither reports it.

Step names map to bounded phases. `runner_setup` measures GitHub's "Set up job" step, not Pod scheduling or bootstrap.
`unattributed` covers time between steps and steps without complete timestamps. A build-and-push action remains a combined phase where it does not expose
separate top-level timings. BuildKit image/cache exporter durations are auxiliary observations that can overlap
the main phase partition. Runner resource panels cover CPU, working-set memory and throttling. The filesystem panel was removed after the
live build showed no cAdvisor filesystem samples; it did not measure runner scratch capacity.

BuildKit cache evidence counts cached Dockerfile `RUN` vertices, scoped separately for each build in a multi-image
job, including verification builds. `warm`, `cold`, and `mixed` describe those instructions, not every layer or all
remote-cache traffic. Nix evidence
uses the existing cache-summary rows for Attic substitutions, nixos.org substitutions and local derivation builds.
Its `nix_no_builds` and `nix_builds` classes distinguish whether the summary reported local derivation builds; they
do not claim an equivalent Docker layer-hit ratio. Missing, oversized or expired logs
produce explicit `unknown` evidence. Timings and outcomes remain collectible when cache evidence is unavailable.
Signed-log HTTP errors, timeouts and rate-limit backoff are optional-evidence failures. They increment the cache
error counter and preserve job timings rather than blocking collection.

Nix summaries also export Attic upload outcomes and exhausted Attic/public-cache download failures. Historical records
without those fields retain unknown outcomes; they do not become successful zero-error uploads. The shared image workflow
uploads the completed derivation's build outputs and dependencies, including build-time paths, after main-branch publication.
The Nix panel displays these outcomes beside substitution attempts. These are log-derived events, not byte hit rates.

The existing Alloy collector probes Attic's internal cache metadata endpoint every thirty seconds and forwards probe
availability, latency, and HTTP status to Mimir. It ships the Attic application container's logs to Loki with namespace,
pod, container, and service labels. Routine informational SQL statements are dropped; warnings and errors remain visible.

Rolling p50/p95 and sample counts use actual completion times. `1h` covers the latest hour; `7d_baseline` covers the
preceding seven days, excluding that hour. These gauges provide an immediate baseline during backfill. They are the single timing export. Detailed phase,
BuildKit and workflow histograms are not exported because their label combinations exhausted the shared Mimir
series allowance without serving dashboard timing queries. SQLite and Loki retain the underlying records; the
collection-delay histogram remains cumulative. Dashboard filters use `ci_jobs_completed`.

Click a build record's runner name to open its resource history during the job. GitHub links select the exact run
attempt and job. Source revisions and cache evidence support investigation; a timing difference alone does not
establish that a CI change caused an improvement.

## Alerts and recovery

The `ci-build-performance.rules` Mimir group covers unavailable scraping, stale GitHub polling, stalled historical
discovery, delayed Loki records, sustained queues and duration regressions. History liveness uses index-reading
progress; an initial scan still making progress does not trigger the stalled-discovery alert. The separate full-scan
timestamp and backfill state retain coverage information. The duration alert compares successful
push build jobs within the same workflow, declared job family, architecture, runner pool and cache class. Unknown
families and cache evidence remain visible but cannot trigger the duration alert. It requires five recent samples
and ten baseline samples, then a median above 1.5 times baseline plus 60 seconds for ten minutes. A single cold-cache
outlier cannot move a five-sample median enough to create that condition on its own.
The initial historical scan and backfill must complete before duration alerts can fire. Loki outbox delivery
continues when GitHub polling fails; GitHub collection continues during a Loki outage.

Independent alerts cover failed or missing Attic probes, unsuccessful build-cache uploads, and exhausted cache download
retries. `CiBuildStalled` alerts when one active push image build exceeds twenty minutes for two minutes, without requiring
baseline samples. All use the existing email route. Completed cache errors remain visible for the one-hour event window;
active build ages disappear on completion. Stale GitHub polling cannot trigger build/cache-event alerts.

Queue alerts select image build jobs and aggregate by namespace, runner pool and architecture. Workflow and job-family
changes do not create new alert identities. The first alert still requires a queue over ten minutes for five minutes
of fresh observations; a five-minute recovery hold joins brief gaps into one incident. Warning email group updates
are batched every fifteen minutes, with a four-hour repeat. Per-workflow evidence remains in the dashboard.

Inspect `ci-observability` logs and its collection freshness/API-headroom panels first. Check `github-token` identity
and expiry through the existing ARC secret-sync procedure without printing its value or changing permissions.
For a Loki backlog, check gateway health and collector errors; do not remove the PVC or clear the outbox. An observer
failure does not stop builds. Recover code through a reviewed Git revert and Argo reconciliation, retaining the PVC.

## Validation

```sh
python3 -m unittest discover -s argocd/applications/observability/ci -p test_collector.py
ruff check argocd/applications/observability/ci
ruff format --check argocd/applications/observability/ci
bun test packages/scripts/src/shared/__tests__/ci-observability.test.ts
```

`dashboard.json` is the native Grafana model; Kustomize embeds it directly in the dashboard ConfigMap. Import a
preview through Grafana's manual JSON upload first. Verify live data, readable labels, units, table order and links
in the UI, then export the verified model, retain the canonical `ci-build-performance` UID and commit it. Remove the
temporary preview after the provisioned dashboard is verified. The behavioral suite covers attempt isolation, queue and
execution calculations, cache parsing, cancellation, restart idempotency, failed outbox delivery, API search overflow,
stale collection and the metric series budget. Promtool checks alert behavior and dashboard PromQL during scripts CI.

For a rollout, render the observability application with Helm 3, validate the manifests and source checks, merge the
reviewed main commit, then reconcile the observability application through GitOps. The collector and retained claim
reconcile before Alloy, Grafana and the PostSync rule loader. Alloy and Grafana restart to load their new configuration;
build runner Pods are unchanged. Confirm the exact revision,
collector data, live Mimir rule health and Loki records. Reconcile representative successful/failed/cancelled/rerun
attempts against GitHub, including native AMD64 and ARM64 jobs. Verify collection latency on a newly completed run.

The read-only runtime receipt helper runs in the collector Pod with its existing environment:

```sh
kubectl --context galactic-tailscale -n arc exec deployment/ci-observability -- python3 /app/verify.py <run-id> <attempt>
```

It checks the exact job set and independently recomputes queue/execution durations from GitHub, verifies sanitized
records reached Loki, and confirms Mimir sees fresh polling. Follow with the Grafana dashboard and live rule-health
readback. Collection-delay histograms exclude initial backfill and retain the initial installation timestamp across
restarts. Warning alerts opt into the existing email route with `notify: email`.
