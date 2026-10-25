import argparse
import json
import pathlib

PROM = {"type": "prometheus", "uid": "prom"}
LOKI = {"type": "loki", "uid": "loki"}
BASE = 'workflow=~"$workflow",architecture=~"$architecture",runner_pool=~"$runner_pool",job_role=~"$job_role",job_family=~"$job_family",event=~"$event"'
COHORT = BASE + ',cache_state=~"$cache_state"'
ACTIVE = BASE


def dashboard():
    panels = []

    def panel(
        title, expressions, x, y, w=12, h=8, kind="timeseries", unit="s", description=""
    ):
        result = {
            "id": len(panels) + 1,
            "title": title,
            "type": kind,
            "description": description,
            "datasource": PROM,
            "gridPos": {"x": x, "y": y, "w": w, "h": h},
            "fieldConfig": {"defaults": {"unit": unit, "decimals": 1}, "overrides": []},
            "targets": [
                {
                    "refId": chr(65 + i),
                    "expr": expr,
                    "legendFormat": legend,
                    "datasource": PROM,
                }
                for i, (expr, legend) in enumerate(expressions)
            ],
            "options": {"legend": {"displayMode": "table", "placement": "bottom"}},
        }
        if kind == "stat":
            result["options"] = {
                "reduceOptions": {"calcs": ["lastNotNull"]},
                "colorMode": "value",
                "graphMode": "none",
            }
        panels.append(result)
        return result

    panel(
        "Running jobs",
        [
            (
                f'sum(ci_jobs_active{{{ACTIVE},state="in_progress"}}) or vector(0)',
                "running",
            )
        ],
        0,
        0,
        4,
        4,
        "stat",
        "short",
    )
    panel(
        "Queued jobs",
        [
            (
                f'sum(ci_jobs_active{{{ACTIVE},state!="in_progress"}}) or vector(0)',
                "queued",
            )
        ],
        4,
        0,
        4,
        4,
        "stat",
        "short",
    )
    panel(
        "Completed jobs in last hour",
        [(f'sum(ci_jobs_completed{{{BASE},window="1h"}}) or vector(0)', "jobs")],
        8,
        0,
        4,
        4,
        "stat",
        "short",
    )
    panel(
        "Failed jobs in last hour",
        [
            (
                f'(sum(ci_jobs_completed{{{BASE},window="1h",outcome=~"failure|timed_out"}}) or vector(0)) / clamp_min(sum(ci_jobs_completed{{{BASE},window="1h"}}), 1)',
                "failure fraction",
            )
        ],
        12,
        0,
        4,
        4,
        "stat",
        "percentunit",
    )
    panel(
        "Seconds since successful poll",
        [("time() - max(ci_observability_last_poll_timestamp_seconds)", "age")],
        16,
        0,
        4,
        4,
        "stat",
    )
    panel(
        "Attempts awaiting collection",
        [("max(ci_observability_pending_attempts)", "attempts")],
        20,
        0,
        4,
        4,
        "stat",
        "short",
    )
    panel(
        "Active jobs by state and architecture",
        [
            (
                f"sum by (state, architecture) (ci_jobs_active{{{ACTIVE}}})",
                "{{state}} {{architecture}}",
            )
        ],
        0,
        4,
        unit="short",
    )
    panel(
        "Build volume by outcome, trailing hour",
        [
            (
                f'sum by (outcome) (ci_jobs_completed{{{BASE},window="1h"}})',
                "{{outcome}}",
            )
        ],
        12,
        4,
        unit="short",
        description="Counts use actual GitHub completion times, including during historical backfill.",
    )
    for phase, title, x, y in [
        ("execution", "Job execution p50 and p95", 0, 12),
        ("queue", "Queue time p50 and p95", 12, 12),
    ]:
        panel(
            title,
            [
                (
                    f'ci_job_duration_percentile_seconds{{{COHORT},outcome="success",phase="{phase}",window="1h"}}',
                    "{{workflow}} {{job_family}} {{architecture}} {{cache_state}} p{{percentile}}",
                )
            ],
            x,
            y,
            description="Successful jobs only. Rolling one-hour samples; cache classes and runner pools stay separate.",
        )
    panel(
        "Median execution against prior seven-day baseline",
        [
            (
                f'ci_job_duration_percentile_seconds{{{COHORT},outcome="success",phase="execution",percentile="50"}}',
                "{{workflow}} {{job_family}} {{architecture}} {{cache_state}} {{window}}",
            )
        ],
        0,
        20,
        description="The baseline excludes the most recent hour. Unknown cache evidence is explicit; changes are observational, not causal proof.",
    )
    panel(
        "Comparison sample counts",
        [
            (
                f'ci_job_duration_samples{{{COHORT},outcome="success",phase="execution"}}',
                "{{workflow}} {{job_family}} {{architecture}} {{cache_state}} {{window}}",
            )
        ],
        12,
        20,
        unit="short",
    )
    panel(
        "Time spent by step phase, trailing hour",
        [
            (
                f'sum by (phase) (ci_job_phase_total_seconds{{{COHORT},window="1h",phase!~"execution|queue|buildkit_.*"}})',
                "{{phase}}",
            )
        ],
        0,
        28,
        description="Step names map to bounded phases. Unattributed time covers gaps between GitHub step timestamps. Build-and-publish steps remain combined where GitHub does not expose a split.",
    )
    panel(
        "BuildKit cache and image export p50/p95",
        [
            (
                f'ci_job_duration_percentile_seconds{{{COHORT},window="1h",phase=~"buildkit_.*"}}',
                "{{workflow}} {{job_family}} {{architecture}} {{phase}} p{{percentile}}",
            )
        ],
        12,
        28,
        description="Exporter timings parsed from BuildKit logs. These can overlap main step durations and must not be added to the phase partition.",
    )
    panel(
        "Collection freshness and Loki backlog",
        [
            (
                "time() - ci_observability_last_history_scan_timestamp_seconds",
                "history scan age",
            ),
            (
                "ci_observability_oldest_loki_pending_seconds",
                "oldest unshipped record age",
            ),
        ],
        0,
        36,
    )
    panel(
        "API headroom and collection errors",
        [
            (
                "ci_observability_github_rate_limit_remaining",
                "GitHub requests remaining",
            ),
            ("ci_observability_collection_errors_total", "collection errors"),
        ],
        12,
        36,
        unit="short",
    )
    records = panel(
        "Build records and GitHub links",
        [],
        0,
        44,
        24,
        12,
        "table",
        "short",
        "Loki timestamps are observation times; completed_at is GitHub completion time. Click the runner to view its historical resources. Raw job logs and credentials are not shipped.",
    )
    records["datasource"] = LOKI
    records["targets"] = [
        {
            "refId": "A",
            "datasource": LOKI,
            "expr": '{service="ci-observability",kind="job",' + BASE + "} | json",
            "queryType": "range",
            "maxLines": 200,
        }
    ]
    records["transformations"] = [
        {
            "id": "extractFields",
            "options": {
                "source": "Line",
                "format": "json",
                "replace": True,
                "keepTime": False,
            },
        },
        {
            "id": "filterFieldsByName",
            "options": {
                "include": {
                    "names": [
                        "completed_at",
                        "workflow",
                        "architecture",
                        "job_name",
                        "job_family",
                        "outcome",
                        "queue_seconds",
                        "execution_seconds",
                        "build_seconds",
                        "publish_seconds",
                        "cache_state",
                        "cache_hits",
                        "cache_total",
                        "cache",
                        "runner_name",
                        "resource_url",
                        "head_sha",
                        "run_url",
                        "job_url",
                        "started_at_ms",
                        "completed_at_ms",
                    ]
                }
            },
        },
    ]
    records["fieldConfig"]["overrides"] = [
        {
            "matcher": {"id": "byName", "options": field},
            "properties": [
                {
                    "id": "links",
                    "value": [
                        {
                            "title": "Open GitHub",
                            "url": "${__value.raw}",
                            "targetBlank": True,
                        }
                    ],
                }
            ],
        }
        for field in ("run_url", "job_url")
    ] + [
        {
            "matcher": {"id": "byName", "options": "runner_name"},
            "properties": [
                {
                    "id": "links",
                    "value": [
                        {
                            "title": "Runner resources during this job",
                            "url": '${__data.fields["resource_url"]}',
                            "targetBlank": True,
                        }
                    ],
                }
            ],
        }
    ]
    for field in ("started_at_ms", "completed_at_ms", "resource_url"):
        records["fieldConfig"]["overrides"].append(
            {
                "matcher": {"id": "byName", "options": field},
                "properties": [{"id": "custom.hidden", "value": True}],
            }
        )
    pod = 'namespace="arc",pod=~"$runner_pod",container="runner"'
    panel(
        "Selected runner CPU",
        [
            (
                f"sum by (pod) (rate(container_cpu_usage_seconds_total{{{pod}}}[2m]))",
                "{{pod}} cores",
            )
        ],
        0,
        56,
        unit="cores",
    )
    panel(
        "Selected runner memory",
        [(f"container_memory_working_set_bytes{{{pod}}}", "{{pod}}")],
        12,
        56,
        unit="bytes",
    )
    panel(
        "Selected runner CPU throttling",
        [
            (
                f"rate(container_cpu_cfs_throttled_periods_total{{{pod}}}[2m]) / clamp_min(rate(container_cpu_cfs_periods_total{{{pod}}}[2m]), 1)",
                "{{pod}} throttled fraction",
            )
        ],
        0,
        64,
        unit="percentunit",
    )
    panel(
        "Selected runner filesystem use",
        [(f"container_fs_usage_bytes{{{pod}}}", "{{pod}}")],
        12,
        64,
        unit="bytes",
        description="cAdvisor container filesystem coverage depends on the backing filesystem. Runner scratch is not inferred from missing samples.",
    )
    panel(
        "BuildKit cached RUN instructions, trailing hour",
        [
            (
                f'sum by (workflow, architecture) (ci_buildkit_run_instructions{{{BASE},window="1h",result="hit"}}) / clamp_min(sum by (workflow, architecture) (ci_buildkit_run_instructions{{{BASE},window="1h"}}), 1)',
                "{{workflow}} {{job_family}} {{architecture}}",
            )
        ],
        0,
        72,
        unit="percentunit",
        description="The ratio covers Dockerfile RUN vertices with available log evidence, not all layers or cache transport.",
    )
    panel(
        "Nix cache observations, trailing hour",
        [(f'sum by (kind) (ci_nix_cache_events{{{BASE},window="1h"}})', "{{kind}}")],
        12,
        72,
        unit="short",
        description="Counts from existing Nix cache summaries. Substitutions and local builds are distinct events, not a Docker layer-hit ratio.",
    )
    panel(
        "Whole-workflow attempt duration p50/p95",
        [
            (
                'ci_workflow_duration_percentile_seconds{workflow=~"$workflow",event=~"$event",outcome="success",window="1h"}',
                "{{workflow}} p{{percentile}}",
            )
        ],
        0,
        80,
        description="Includes queueing and dependencies within the selected attempt. Multi-architecture workflow totals are not filtered by a single job architecture.",
    )
    panel(
        "Workflow attempts by outcome, trailing hour",
        [
            (
                'sum by (outcome) (ci_workflows_completed{workflow=~"$workflow",event=~"$event",window="1h"})',
                "{{outcome}}",
            )
        ],
        12,
        80,
        unit="short",
    )

    def variable(name, metric, label, current="$__all"):
        return {
            "name": name,
            "type": "query",
            "datasource": PROM,
            "query": f"label_values({metric}, {label})",
            "refresh": 2,
            "includeAll": True,
            "allValue": ".*",
            "multi": True,
            "current": {
                "text": "All" if current == "$__all" else current,
                "value": current,
            },
        }

    variables = [
        variable("workflow", "ci_job_phase_duration_seconds_count", "workflow"),
        variable("architecture", "ci_job_phase_duration_seconds_count", "architecture"),
        variable(
            "runner_pool", "ci_job_phase_duration_seconds_count", "runner_pool", "arc"
        ),
        variable(
            "job_role", "ci_job_phase_duration_seconds_count", "job_role", "build"
        ),
        variable("job_family", "ci_job_phase_duration_seconds_count", "job_family"),
        variable("event", "ci_job_phase_duration_seconds_count", "event", "push"),
        variable("cache_state", "ci_job_duration_samples", "cache_state"),
    ]
    variables.append(
        {
            "name": "runner_pod",
            "type": "textbox",
            "query": "",
            "current": {"text": "", "value": ""},
            "description": "Select a runner from a build-record link, or enter its exact Pod name.",
        }
    )
    return {
        "uid": "ci-build-performance",
        "title": "CI Build Performance",
        "description": "Attempt-aware image-build timing, cache evidence and runner resources. Polling target is 60 seconds; the historical rerun scan covers 90 days every three cycles. Detail records retain GitHub event times. Metrics have bounded labels and omit run IDs, revisions and Pod names.",
        "schemaVersion": 42,
        "version": 1,
        "refresh": "30s",
        "timezone": "browser",
        "tags": ["ci", "arc", "builds"],
        "time": {"from": "now-6h", "to": "now"},
        "templating": {"list": variables},
        "panels": panels,
    }


def render():
    return (
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ci-build-performance-dashboard\n  namespace: observability\n  labels:\n    grafana_dashboard: "1"\ndata:\n  ci-build-performance.json: |\n'
        + "".join(
            "    " + line + "\n"
            for line in json.dumps(dashboard(), indent=2).splitlines()
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = (
        pathlib.Path(__file__).parent.parent
        / "ci-build-performance-dashboard-configmap.yaml"
    )
    if args.check:
        if target.read_text() != render():
            raise SystemExit(
                "Run python3 argocd/applications/observability/ci/dashboard.py to regenerate the CI dashboard"
            )
    else:
        target.write_text(render())
