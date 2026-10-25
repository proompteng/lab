"""Attempt-aware GitHub Actions metrics and sanitized build records."""

import collections
import datetime as dt
import http.client
import http.server
import json
import math
import os
import pathlib
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UTC = dt.timezone.utc
BUCKETS = (1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400)
RUN_FIELDS = (
    "id",
    "run_attempt",
    "path",
    "status",
    "conclusion",
    "created_at",
    "run_started_at",
    "updated_at",
    "head_sha",
    "event",
    "html_url",
)
EVENTS = {"push", "pull_request", "workflow_dispatch", "schedule", "workflow_call"}
OUTCOMES = {
    "success",
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "neutral",
    "action_required",
    "stale",
}
ACTIVE_STATES = ("in_progress", "queued", "waiting", "pending", "requested")
MAX_LOG_BYTES = 16 * 1024 * 1024
LOKI_MAX_SAMPLE_AGE_SECONDS = 168 * 3600
METRICS = {
    "ci_job_phase_duration_seconds": (
        "histogram",
        "Observed job queue, execution and step-phase durations.",
    ),
    "ci_buildkit_phase_duration_seconds": (
        "histogram",
        "Observed BuildKit exporter durations; may overlap job steps.",
    ),
    "ci_workflow_duration_seconds": (
        "histogram",
        "Workflow attempt duration from attempt-specific job timestamps.",
    ),
    "ci_job_collection_delay_seconds": (
        "histogram",
        "Delay from job completion to collection after initial installation.",
    ),
    "ci_job_duration_samples": (
        "gauge",
        "Job duration sample count by actual completion-time window.",
    ),
    "ci_job_phase_total_seconds": (
        "gauge",
        "Total phase duration in the completion-time window.",
    ),
    "ci_job_duration_percentile_seconds": (
        "gauge",
        "Job duration quantiles in the completion-time window.",
    ),
    "ci_jobs_completed": (
        "gauge",
        "Jobs completed in the selected rolling event-time window.",
    ),
    "ci_workflows_completed": (
        "gauge",
        "Workflow attempts completed in the rolling event-time window.",
    ),
    "ci_workflow_duration_percentile_seconds": (
        "gauge",
        "Workflow duration quantiles in the completion-time window.",
    ),
    "ci_buildkit_run_instructions": (
        "gauge",
        "Observed cached or uncached Dockerfile RUN vertices in the window.",
    ),
    "ci_nix_cache_events": (
        "gauge",
        "Nix substitutions and local build events reported by cache summaries.",
    ),
    "ci_jobs_active": ("gauge", "Jobs currently reported as nonterminal by GitHub."),
    "ci_workflows_active": (
        "gauge",
        "Workflow runs currently reported as nonterminal by GitHub.",
    ),
    "ci_job_oldest_queue_seconds": (
        "gauge",
        "Age of the oldest currently queued job in a cohort.",
    ),
    "ci_observability_pending_attempts": (
        "gauge",
        "Discovered workflow attempts awaiting durable collection.",
    ),
    "ci_observability_unavailable_attempts": (
        "gauge",
        "Discovered attempts subsequently unavailable from GitHub.",
    ),
    "ci_observability_loki_pending_records": (
        "gauge",
        "Durable records awaiting Loki acknowledgement.",
    ),
    "ci_observability_oldest_loki_pending_seconds": (
        "gauge",
        "Age of the oldest record awaiting Loki acknowledgement.",
    ),
    "ci_observability_installed_timestamp_seconds": (
        "gauge",
        "Initial installation time retained across restarts.",
    ),
    "ci_observability_oldest_live_pending_seconds": (
        "gauge",
        "Age of the oldest pending attempt completed after installation.",
    ),
    "ci_observability_last_poll_timestamp_seconds": (
        "gauge",
        "Last successful current-run and active-job poll.",
    ),
    "ci_observability_last_history_scan_timestamp_seconds": (
        "gauge",
        "Last complete historical rerun discovery scan.",
    ),
    "ci_observability_collection_errors_total": (
        "counter",
        "Collection cycle failures since process start.",
    ),
    "ci_observability_github_rate_limit_remaining": (
        "gauge",
        "Remaining GitHub requests in the shared authentication quota.",
    ),
    "ci_observability_backfill_complete": (
        "gauge",
        "Historical discovery has completed and initial pending attempts are drained.",
    ),
    "ci_observability_cache_errors_total": (
        "counter",
        "Optional build-log downloads that failed without blocking job timing collection.",
    ),
    "ci_observability_loki_rejected_records": (
        "gauge",
        "Expired unacknowledged records retained outside the Loki delivery queue.",
    ),
}


def timestamp(value):
    if not value or value.startswith("0001-"):
        return None
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def seconds(start, end):
    a, b = timestamp(start), timestamp(end)
    return max(0.0, b - a) if a is not None and b is not None else None


def architecture(job):
    labels = " ".join((job.get("labels") or [])).lower()
    name = job["name"].lower()
    for text in (labels, name):
        if re.search(r"arm64|aarch64|ubuntu-[\w.]+-arm", text):
            return "arm64"
        if re.search(r"amd64|x86_64|\bx64\b", text):
            return "amd64"
    return "unknown"


def pool(job):
    if (job.get("runner_name") or "").startswith(("arc-amd64-", "arc-arm64-")) or {
        "arc-amd64",
        "arc-arm64",
    } & set((job.get("labels") or [])):
        return "arc"
    if any(
        x.startswith(("ubuntu-", "macos-", "windows-"))
        for x in (job.get("labels") or [])
    ):
        return "github-hosted"
    return "other"


def phase(name):
    name = name.lower()
    if name.startswith("post ") or name == "complete job":
        return "cleanup"
    if name == "set up job":
        return "runner_setup"
    if "checkout" in name:
        return "checkout"
    if "artifact" in name and re.search(r"upload|download|retain", name):
        return "artifacts"
    if re.search(
        r"setup-buildkit|buildx|toolchain|set up nix|install |setup-crane|cosign-installer",
        name,
    ):
        return "toolchain"
    if re.search(r"warm .*attic|cache push|summarize .*cache", name):
        return "cache"
    if re.search(r"build.*(?:push|publish)", name):
        return "build_and_publish"
    if re.search(
        r"push|publish|image index|oci index|expose .*kargo|assemble .*index", name
    ):
        return "publish"
    if re.search(
        r"build.*(?:image|runtime|native)|^build$|nix build|docker build", name
    ):
        return "build"
    if re.search(r"test|verif|validat|proof|inspect|checksum|heartbeat", name):
        return "verify"
    return "other"


def cache_evidence(log):
    vertices, exports, build = {}, {}, 0
    for line in log.splitlines():
        match = re.search(r"#(\d+) (.*)", line)
        if not match:
            continue
        vertex, text = match.groups()
        if vertex == "0" and "building with" in text:
            build += 1
        key = (build, vertex)
        if re.search(r"\] RUN ", text):
            vertices[key] = False
        if text == "CACHED" and key in vertices:
            vertices[key] = True
        if text.startswith("exporting to GitHub Actions Cache"):
            exports[key] = ["cache_export", None]
        elif text.startswith(("exporting to image", "exporting to oci image format")):
            exports[key] = ["image_export", None]
        elif text.startswith("importing cache manifest"):
            exports[key] = ["cache_import", None]
        done = re.match(r"DONE (\d+(?:\.\d+)?)s", text)
        if done and key in exports:
            value = float(done[1])
            if math.isfinite(value):
                exports[key][1] = value
    if vertices:
        hits, total = sum(vertices.values()), len(vertices)
        state = "warm" if hits == total else "cold" if not hits else "mixed"
        durations = collections.defaultdict(float)
        for name, duration in exports.values():
            if duration is not None:
                durations[name] += duration
        return {
            "source": "buildkit_run_instructions",
            "state": state,
            "hits": hits,
            "total": total,
            "durations": dict(durations),
        }
    data = {}
    for key, title in {
        "attic_substitutions": "Attic substitutions",
        "nixos_substitutions": "cache.nixos.org substitutions",
        "local_builds": "Local derivation builds",
    }.items():
        values = re.findall(r"\| " + re.escape(title) + r" \| (\d+) \|", log)
        if values:
            if len(values[-1]) <= 10:
                data[key] = int(values[-1])
    if len(data) == 3:
        return {
            "source": "nix_derivations",
            "state": "nix_builds" if data["local_builds"] else "nix_no_builds",
            **data,
            "durations": {},
        }
    return {"source": "unavailable", "state": "unknown", "durations": {}}


def job_record(run, job, families=()):
    created = job.get("created_at")
    started, completed = job.get("started_at"), job.get("completed_at")
    assigned = bool(job.get("runner_name"))
    durations = {}
    queue = seconds(created, started if assigned else completed)
    execution = seconds(started, completed) if assigned else None
    if queue is not None:
        durations["queue"] = queue
    if execution is not None:
        durations["execution"] = execution
    steps = []
    for step in job.get("steps") or []:
        duration = seconds(step.get("started_at"), step.get("completed_at"))
        if duration is None or step.get("conclusion") == "skipped":
            continue
        key = phase(step["name"])
        durations[key] = durations.get(key, 0) + duration
        steps.append(
            {
                "name": step["name"],
                "phase": key,
                "duration_seconds": duration,
                "outcome": step.get("conclusion"),
            }
        )
    if execution is not None:
        measured = sum(s["duration_seconds"] for s in steps)
        durations["unattributed"] = max(0.0, execution - measured)
    workflow = run["path"].split("@", 1)[0].rsplit("/", 1)[-1]
    outcome = job.get("conclusion") or "unknown"
    matched_families = {
        f["id"] for f in families if re.fullmatch(f["pattern"], job["name"])
    }
    return {
        "kind": "job",
        "repository": "proompteng/lab",
        "workflow": workflow,
        "run_id": run["id"],
        "attempt": run["run_attempt"],
        "job_id": job["id"],
        "job_name": job["name"],
        "job_family": next(iter(matched_families))
        if len(matched_families) == 1
        else "unknown",
        "job_role": "build"
        if {"build", "build_and_publish"} & durations.keys()
        or re.search(r"\bbuild\b", job["name"], re.I)
        else "publish"
        if "publish" in durations
        else "validate"
        if "verify" in durations
        else "other",
        "architecture": architecture(job),
        "runner_pool": pool(job),
        "event": run["event"] if run["event"] in EVENTS else "other",
        "outcome": outcome if outcome in OUTCOMES else "unknown",
        "github_conclusion": outcome,
        "head_sha": run["head_sha"],
        "runner_name": (job.get("runner_name") or ""),
        "created_at": created,
        "started_at": started,
        "completed_at": completed,
        "started_at_ms": int((timestamp(started) or timestamp(created) or 0) * 1000),
        "completed_at_ms": int((timestamp(completed) or 0) * 1000),
        "run_url": f"https://github.com/proompteng/lab/actions/runs/{run['id']}/attempts/{run['run_attempt']}",
        "job_url": f"https://github.com/proompteng/lab/actions/runs/{run['id']}/job/{job['id']}",
        "durations": durations,
        "steps": steps,
    }


def labels(record, **extra):
    return {
        k: record[k]
        for k in (
            "workflow",
            "architecture",
            "runner_pool",
            "job_role",
            "job_family",
            "event",
            "outcome",
        )
    } | extra


def exposition(name, value, attributes=None):
    suffix = (
        "{"
        + ",".join(f"{k}={json.dumps(str(v))}" for k, v in sorted(attributes.items()))
        + "}"
        if attributes
        else ""
    )
    return f"{name}{suffix} {value}\n"


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value REAL);
            CREATE TABLE IF NOT EXISTS attempts (
                run_id INTEGER, attempt INTEGER, updated TEXT, state TEXT,
                priority REAL, run TEXT, PRIMARY KEY(run_id, attempt)
            );
            CREATE TABLE IF NOT EXISTS jobs (
                job_id INTEGER PRIMARY KEY, run_id INTEGER, attempt INTEGER,
                completed REAL, record TEXT
            );
            CREATE INDEX IF NOT EXISTS jobs_completed ON jobs(completed);
            CREATE TABLE IF NOT EXISTS observations (
                record_key TEXT, phase TEXT, PRIMARY KEY(record_key, phase)
            );
            CREATE TABLE IF NOT EXISTS aggregates (
                metric TEXT, labels TEXT, count INTEGER, total REAL, buckets TEXT,
                PRIMARY KEY(metric, labels)
            );
            CREATE TABLE IF NOT EXISTS outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT, stamp TEXT, labels TEXT, line TEXT
            );
            CREATE TABLE IF NOT EXISTS loki_rejections (
                id INTEGER PRIMARY KEY, stamp TEXT, labels TEXT, line TEXT,
                reason TEXT, rejected_at REAL
            );
        """)
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO metadata VALUES ('installed_at', ?)",
                (time.time(),),
            )
        self.installed_at = self.db.execute(
            "SELECT value FROM metadata WHERE key='installed_at'"
        ).fetchone()[0]

    def discover(self, run, now, backfill_days=14):
        run = {k: run.get(k) for k in RUN_FIELDS}
        if run["status"] != "completed":
            return
        for attempt in range(1, run["run_attempt"] + 1):
            if (timestamp(run["updated_at"]) or 0) < now - backfill_days * 86400:
                continue
            self.db.execute(
                "INSERT OR IGNORE INTO attempts VALUES (?, ?, ?, 'pending', ?, ?)",
                (
                    run["id"],
                    attempt,
                    run["updated_at"],
                    timestamp(run["updated_at"]),
                    json.dumps(run),
                ),
            )
        self.db.commit()

    def pending(self):
        return self.db.execute(
            "SELECT * FROM attempts WHERE state='pending' ORDER BY priority DESC LIMIT 1"
        ).fetchone()

    def observe(self, record_key, key, metric, attrs, value):
        inserted = self.db.execute(
            "INSERT OR IGNORE INTO observations VALUES (?, ?)", (str(record_key), key)
        ).rowcount
        if not inserted:
            return
        encoded = json.dumps(attrs, sort_keys=True)
        row = self.db.execute(
            "SELECT * FROM aggregates WHERE metric=? AND labels=?", (metric, encoded)
        ).fetchone()
        counts = json.loads(row["buckets"]) if row else [0] * len(BUCKETS)
        counts = [n + int(value <= bound) for n, bound in zip(counts, BUCKETS)]
        self.db.execute(
            "INSERT OR REPLACE INTO aggregates VALUES (?, ?, ?, ?, ?)",
            (
                metric,
                encoded,
                (row["count"] if row else 0) + 1,
                (row["total"] if row else 0) + value,
                json.dumps(counts),
            ),
        )

    def save_job(self, record, cache):
        observed = time.time()
        completed = timestamp(record["completed_at"])
        live = completed is not None and completed >= self.installed_at
        record = record | {
            "observed_at": dt.datetime.fromtimestamp(observed, UTC).isoformat(),
            "collection_mode": "live" if live else "backfill",
            "collection_delay_seconds": max(0, observed - completed)
            if completed is not None
            else None,
            "cache": cache,
            "cache_state": cache["state"],
            "cache_hits": cache.get("hits"),
            "cache_total": cache.get("total"),
            **{
                key + "_seconds": record["durations"].get(key)
                for key in ("queue", "execution", "build", "publish")
            },
        }
        resource_query = {
            "var-workflow": record["workflow"],
            "var-architecture": record["architecture"],
            "var-runner_pool": record["runner_pool"],
            "var-job_role": record["job_role"],
            "var-job_family": record["job_family"],
            "var-event": record["event"],
            "var-runner_pod": record["runner_name"],
            "from": max(0, record["started_at_ms"] - 120000),
            "to": record["completed_at_ms"] + 60000,
        }
        record["resource_url"] = "/d/ci-build-performance?" + urllib.parse.urlencode(
            resource_query
        )
        encoded = json.dumps(record, sort_keys=True, separators=(",", ":"))
        with self.db:
            inserted = self.db.execute(
                "INSERT OR IGNORE INTO jobs VALUES (?, ?, ?, ?, ?)",
                (
                    record["job_id"],
                    record["run_id"],
                    record["attempt"],
                    timestamp(record["completed_at"]),
                    encoded,
                ),
            ).rowcount
            if not inserted:
                return False
            if live:
                self.observe(
                    record["job_id"],
                    "collection_delay",
                    "ci_job_collection_delay_seconds",
                    labels(record),
                    record["collection_delay_seconds"],
                )
            for key, value in record["durations"].items():
                self.observe(
                    record["job_id"],
                    key,
                    "ci_job_phase_duration_seconds",
                    labels(record, phase=key),
                    value,
                )
            for key, value in cache["durations"].items():
                self.observe(
                    record["job_id"],
                    "buildkit_" + key,
                    "ci_buildkit_phase_duration_seconds",
                    labels(record, phase=key),
                    value,
                )
            stream = {"service": "ci-observability", "kind": "job", **labels(record)}
            self.db.execute(
                "INSERT INTO outbox(stamp, labels, line) VALUES (?, ?, ?)",
                (str(time.time_ns()), json.dumps(stream, sort_keys=True), encoded),
            )
        return True

    def finish(self, run, jobs):
        starts = [
            timestamp(j.get("created_at"))
            for j in jobs
            if timestamp(j.get("created_at")) is not None
        ]
        ends = [
            timestamp(j.get("completed_at"))
            for j in jobs
            if timestamp(j.get("completed_at")) is not None
        ]
        start = min(starts) if starts else timestamp(run["run_started_at"])
        end = max(ends) if ends else timestamp(run["updated_at"])
        record = {k: run.get(k) for k in RUN_FIELDS} | {
            "kind": "workflow",
            "workflow": run["path"].split("@", 1)[0].rsplit("/", 1)[-1],
            "duration_seconds": max(0, end - start)
            if start is not None and end is not None
            else None,
            "job_count": len(jobs),
            "completed_at": dt.datetime.fromtimestamp(end, UTC).isoformat()
            if end is not None
            else None,
            "run_url": f"https://github.com/proompteng/lab/actions/runs/{run['id']}/attempts/{run['run_attempt']}",
        }
        attrs = {
            "workflow": record["workflow"],
            "event": run["event"] if run["event"] in EVENTS else "other",
            "outcome": run["conclusion"]
            if run["conclusion"] in OUTCOMES
            else "unknown",
        }
        with self.db:
            row = self.db.execute(
                "SELECT state FROM attempts WHERE run_id=? AND attempt=?",
                (run["id"], run["run_attempt"]),
            ).fetchone()
            if row and row["state"] == "complete":
                return
            if record["duration_seconds"] is not None:
                self.observe(
                    f"run:{run['id']}:{run['run_attempt']}",
                    "workflow_execution",
                    "ci_workflow_duration_seconds",
                    attrs,
                    record["duration_seconds"],
                )
            self.db.execute(
                "UPDATE attempts SET state='complete', run=? WHERE run_id=? AND attempt=?",
                (json.dumps(record), run["id"], run["run_attempt"]),
            )
            self.db.execute(
                "INSERT INTO outbox(stamp, labels, line) VALUES (?, ?, ?)",
                (
                    str(time.time_ns()),
                    json.dumps(
                        {"service": "ci-observability", "kind": "workflow", **attrs},
                        sort_keys=True,
                    ),
                    json.dumps(record, sort_keys=True, separators=(",", ":")),
                ),
            )

    def render(self, now):
        output = [
            f"# HELP {name} {help_text}\n# TYPE {name} {kind}\n"
            for name, (kind, help_text) in METRICS.items()
        ]
        for row in self.db.execute("SELECT * FROM aggregates ORDER BY metric, labels"):
            attrs = json.loads(row["labels"])
            for bound, value in zip(BUCKETS, json.loads(row["buckets"])):
                output.append(
                    exposition(row["metric"] + "_bucket", value, attrs | {"le": bound})
                )
            output.append(
                exposition(
                    row["metric"] + "_bucket", row["count"], attrs | {"le": "+Inf"}
                )
            )
            output.append(exposition(row["metric"] + "_count", row["count"], attrs))
            output.append(exposition(row["metric"] + "_sum", row["total"], attrs))
        grouped = collections.defaultdict(list)
        counts = collections.Counter()
        cache_counts = collections.Counter()
        for row in self.db.execute(
            "SELECT record FROM jobs WHERE completed >= ?", (now - (7 * 86400 + 3600),)
        ):
            record = json.loads(row["record"])
            age = now - timestamp(record["completed_at"])
            base = labels(record)
            for window, included in (
                ("1h", 0 <= age <= 3600),
                ("7d_baseline", 3600 < age <= (7 * 86400 + 3600)),
            ):
                if not included:
                    continue
                counts[(json.dumps(base, sort_keys=True), window)] += 1
                cache = record["cache"]
                if cache["source"] == "buildkit_run_instructions":
                    for result, value in (
                        ("hit", cache["hits"]),
                        ("miss", cache["total"] - cache["hits"]),
                    ):
                        cache_counts[
                            (
                                "ci_buildkit_run_instructions",
                                json.dumps(
                                    base | {"window": window, "result": result},
                                    sort_keys=True,
                                ),
                            )
                        ] += value
                elif cache["source"] == "nix_derivations":
                    for key in (
                        "attic_substitutions",
                        "nixos_substitutions",
                        "local_builds",
                    ):
                        cache_counts[
                            (
                                "ci_nix_cache_events",
                                json.dumps(
                                    base | {"window": window, "kind": key},
                                    sort_keys=True,
                                ),
                            )
                        ] += cache[key]
                durations = record["durations"] | {
                    "buildkit_" + k: v for k, v in record["cache"]["durations"].items()
                }
                for key, value in durations.items():
                    attrs = base | {
                        "phase": key,
                        "cache_state": record["cache"]["state"],
                        "window": window,
                    }
                    grouped[json.dumps(attrs, sort_keys=True)].append(value)
        for encoded, values in grouped.items():
            attrs = json.loads(encoded)
            output.append(exposition("ci_job_duration_samples", len(values), attrs))
            output.append(exposition("ci_job_phase_total_seconds", sum(values), attrs))
            values.sort()
            for quantile in (0.5, 0.95):
                index = (len(values) - 1) * quantile
                lower, upper = math.floor(index), math.ceil(index)
                value = values[lower] + (values[upper] - values[lower]) * (
                    index - lower
                )
                output.append(
                    exposition(
                        "ci_job_duration_percentile_seconds",
                        value,
                        attrs | {"percentile": int(quantile * 100)},
                    )
                )
        for (encoded, window), value in counts.items():
            output.append(
                exposition(
                    "ci_jobs_completed", value, json.loads(encoded) | {"window": window}
                )
            )
        for (metric, encoded), value in cache_counts.items():
            output.append(exposition(metric, value, json.loads(encoded)))
        workflow_groups = collections.defaultdict(list)
        for row in self.db.execute(
            "SELECT run FROM attempts WHERE state='complete' AND priority>=?",
            (now - (7 * 86400 + 3600),),
        ):
            record = json.loads(row["run"])
            completed = timestamp(record.get("completed_at"))
            if completed is None:
                continue
            age = now - completed
            attrs = {
                "workflow": record["workflow"],
                "event": record["event"] if record["event"] in EVENTS else "other",
                "outcome": record["conclusion"]
                if record["conclusion"] in OUTCOMES
                else "unknown",
            }
            for window, included in (
                ("1h", 0 <= age <= 3600),
                ("7d_baseline", 3600 < age <= (7 * 86400 + 3600)),
            ):
                if included:
                    workflow_groups[
                        json.dumps(attrs | {"window": window}, sort_keys=True)
                    ].append(record["duration_seconds"])
        for encoded, values in workflow_groups.items():
            attrs = json.loads(encoded)
            output.append(exposition("ci_workflows_completed", len(values), attrs))
            values = sorted(v for v in values if v is not None)
            if values:
                for quantile in (0.5, 0.95):
                    index = (len(values) - 1) * quantile
                    lower, upper = math.floor(index), math.ceil(index)
                    value = values[lower] + (values[upper] - values[lower]) * (
                        index - lower
                    )
                    output.append(
                        exposition(
                            "ci_workflow_duration_percentile_seconds",
                            value,
                            attrs | {"percentile": int(quantile * 100)},
                        )
                    )
        output.append(
            exposition(
                "ci_observability_pending_attempts",
                self.db.execute(
                    "SELECT COUNT(*) FROM attempts WHERE state='pending'"
                ).fetchone()[0],
            )
        )
        output.append(
            exposition(
                "ci_observability_unavailable_attempts",
                self.db.execute(
                    "SELECT COUNT(*) FROM attempts WHERE state='unavailable'"
                ).fetchone()[0],
            )
        )
        output.append(
            exposition(
                "ci_observability_loki_pending_records",
                self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0],
            )
        )
        output.append(
            exposition(
                "ci_observability_loki_rejected_records",
                self.db.execute("SELECT COUNT(*) FROM loki_rejections").fetchone()[0],
            )
        )
        oldest = self.db.execute(
            "SELECT MIN(CAST(stamp AS INTEGER)) FROM outbox"
        ).fetchone()[0]
        output.append(
            exposition(
                "ci_observability_oldest_loki_pending_seconds",
                max(0, now - oldest / 1e9) if oldest else 0,
            )
        )
        output.append(
            exposition(
                "ci_observability_installed_timestamp_seconds", self.installed_at
            )
        )
        pending = self.db.execute(
            "SELECT MIN(priority) FROM attempts WHERE state='pending' AND priority>=?",
            (self.installed_at,),
        ).fetchone()[0]
        output.append(
            exposition(
                "ci_observability_oldest_live_pending_seconds",
                max(0, now - pending) if pending else 0,
            )
        )
        return "".join(output)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHubError(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"GitHub API returned HTTP {status}")


class GitHubQuotaError(RuntimeError):
    pass


class GitHub:
    def __init__(self, token):
        self.token, self.cache = token, {}
        self.blocked_until, self.remaining = 0, 5000
        self.reset_at = 0
        self.opener = urllib.request.build_opener(NoRedirect)

    def get(self, path, conditional=False):
        self.check_quota()
        headers = {
            "Authorization": "Bearer " + self.token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "lab-ci-observability",
        }
        if conditional and path in self.cache:
            headers["If-None-Match"] = self.cache[path][0]
        request = urllib.request.Request(
            "https://api.github.com/repos/proompteng/lab/" + path, headers=headers
        )
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            self.backoff(error)
            if error.code == 304 and path in self.cache:
                error.close()
                return self.cache[path][1]
            code = error.code
            error.close()
            raise GitHubError(code) from None
        with response:
            self.read_quota(response.headers)
            data = json.load(response)
            if "workflow_runs" in data:
                data["workflow_runs"] = [
                    {k: r.get(k) for k in RUN_FIELDS} for r in data["workflow_runs"]
                ]
            if conditional and response.headers.get("ETag"):
                self.cache[path] = (response.headers["ETag"], data)
            return data

    def check_quota(self):
        if time.time() < self.blocked_until:
            raise GitHubQuotaError("GitHub rate-limit backoff is active")
        if self.remaining < 1000 and time.time() < self.reset_at:
            raise GitHubQuotaError(
                "GitHub shared API quota reserve reached; waiting for reset"
            )

    def read_quota(self, headers):
        self.remaining = int(headers.get("X-RateLimit-Remaining", self.remaining))
        self.reset_at = int(headers.get("X-RateLimit-Reset", self.reset_at))

    def backoff(self, error):
        self.read_quota(error.headers)
        if error.code in (403, 429):
            wait = int(error.headers.get("Retry-After", "60"))
            if self.remaining == 0:
                wait = max(wait, self.reset_at - int(time.time()))
            self.blocked_until = time.time() + wait

    def pages(self, path, key, conditional=False):
        separator = "&" if "?" in path else "?"
        page = 1
        while True:
            data = self.get(f"{path}{separator}per_page=100&page={page}", conditional)
            yield from data[key]
            if page * 100 >= data["total_count"]:
                break
            page += 1

    def runs(self, start, end):
        query = urllib.parse.urlencode({"created": f"{start}..{end}"})
        data = self.get("actions/runs?" + query + "&per_page=100&page=1", True)
        if data["total_count"] > 1000:
            a, b = timestamp(start), timestamp(end)
            if b - a <= 1:
                raise RuntimeError(
                    "GitHub run search exceeds 1000 results in one second"
                )
            mid = (
                dt.datetime.fromtimestamp(int((a + b) / 2), UTC)
                .isoformat()
                .replace("+00:00", "Z")
            )
            yield from self.runs(start, mid)
            yield from self.runs(mid, end)
            return
        yield from data["workflow_runs"]
        for page in range(2, math.ceil(data["total_count"] / 100) + 1):
            yield from self.get(
                "actions/runs?" + query + f"&per_page=100&page={page}", True
            )["workflow_runs"]

    def log(self, job_id):
        self.check_quota()
        request = urllib.request.Request(
            f"https://api.github.com/repos/proompteng/lab/actions/jobs/{job_id}/logs",
            headers={
                "Authorization": "Bearer " + self.token,
                "User-Agent": "lab-ci-observability",
            },
        )
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            self.backoff(error)
            if error.code != 302:
                error.close()
                return None
            location = error.headers.get("Location", "")
            error.close()
            if not location.startswith("https://"):
                return None
            # Signed log URLs receive no GitHub Authorization header.
            response = urllib.request.urlopen(location, timeout=20)
        with response:
            data = response.read(MAX_LOG_BYTES + 1)
        return (
            data.decode("utf-8", errors="replace")
            if len(data) <= MAX_LOG_BYTES
            else None
        )


class Collector:
    def __init__(self, store, api, workflows, loki_url):
        self.store, self.api, self.workflows, self.loki_url = (
            store,
            api,
            set(workflows),
            loki_url,
        )
        self.families = workflows
        self.active_runs, self.active_metrics = {}, ""
        self.last_poll, self.last_history = 0, 0
        self.errors = 0
        self.cache_errors = 0
        self.history_day = 0
        self.metrics = b""

    def selected(self, run):
        return run.get("path", "").split("@", 1)[0].rsplit("/", 1)[-1] in self.workflows

    def poll(self, now):
        active = {}
        for state in ACTIVE_STATES:
            for run in self.api.pages(
                "actions/runs?status=" + state, "workflow_runs", True
            ):
                if self.selected(run):
                    active[run["id"]] = run
        for run_id in self.active_runs.keys() - active.keys():
            run = self.api.get(f"actions/runs/{run_id}")
            if run["status"] == "completed":
                self.store.discover(run, now)
        self.active_runs = active
        counts, oldest = collections.Counter(), collections.defaultdict(float)
        for run in active.values():
            workflow = run["path"].split("@", 1)[0].rsplit("/", 1)[-1]
            run_attrs = {
                "workflow": workflow,
                "state": run["status"],
                "event": run["event"] if run["event"] in EVENTS else "other",
            }
            counts[("ci_workflows_active", json.dumps(run_attrs, sort_keys=True))] += 1
            jobs = self.api.pages(
                f"actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs", "jobs"
            )
            for job in jobs:
                if job["run_attempt"] != run["run_attempt"]:
                    continue
                if job["status"] == "completed":
                    self.collect_job(run, job, now + 20)
                    continue
                state = job["status"] if job["status"] in ACTIVE_STATES else "waiting"
                record = job_record(run, job, self.families[workflow])
                attrs = {k: v for k, v in labels(record).items() if k != "outcome"}
                encoded = json.dumps(attrs, sort_keys=True)
                counts[
                    (
                        "ci_jobs_active",
                        json.dumps(attrs | {"state": state}, sort_keys=True),
                    )
                ] += 1
                if state != "in_progress" and timestamp(job.get("created_at")):
                    oldest[encoded] = max(
                        oldest[encoded], now - timestamp(job["created_at"])
                    )
        self.active_metrics = "".join(
            exposition(metric, value, json.loads(encoded))
            for (metric, encoded), value in counts.items()
        )
        self.active_metrics += "".join(
            exposition(
                "ci_job_oldest_queue_seconds",
                value,
                json.loads(encoded),
            )
            for encoded, value in oldest.items()
        )
        today = dt.datetime.fromtimestamp(now, UTC).date()
        for run in self.api.runs(
            today.isoformat() + "T00:00:00Z", today.isoformat() + "T23:59:59Z"
        ):
            if self.selected(run):
                self.store.discover(run, now)
        self.last_poll = time.time()

    def history(self, now, days=90, windows=30):
        today = dt.datetime.fromtimestamp(now, UTC).date()
        for _ in range(windows):
            next_day = self.history_day % days + 1
            day = (today - dt.timedelta(days=next_day)).isoformat()
            for run in self.api.runs(day + "T00:00:00Z", day + "T23:59:59Z"):
                if self.selected(run):
                    self.store.discover(run, now)
            self.history_day = next_day
            if self.history_day == days:
                self.last_history = time.time()

    def collect_job(self, run, job, deadline):
        if self.store.db.execute(
            "SELECT 1 FROM jobs WHERE job_id=?", (job["id"],)
        ).fetchone():
            return
        workflow = run["path"].split("@", 1)[0].rsplit("/", 1)[-1]
        record = job_record(run, job, self.families[workflow])
        log = None
        reason = "not_a_build"
        if any(k in record["durations"] for k in ("build", "build_and_publish")):
            reason = "collection_budget"
            if time.time() < deadline:
                reason = "logs_unavailable"
                try:
                    log = self.api.log(job["id"])
                except (
                    OSError,
                    http.client.HTTPException,
                    GitHubError,
                    GitHubQuotaError,
                ) as error:
                    if isinstance(error, urllib.error.HTTPError):
                        error.close()
                    reason = "download_failed"
                if log is None:
                    self.cache_errors += 1
        cache = cache_evidence(log or "")
        if cache["state"] == "unknown":
            cache["reason"] = reason
        self.store.save_job(record, cache)

    def collect_attempt(self, pending):
        try:
            run = self.api.get(
                f"actions/runs/{pending['run_id']}/attempts/{pending['attempt']}"
            )
        except GitHubError as error:
            if error.status not in (404, 410):
                raise
            with self.store.db:
                self.store.db.execute(
                    "UPDATE attempts SET state='unavailable' WHERE run_id=? AND attempt=?",
                    (pending["run_id"], pending["attempt"]),
                )
            return
        run = {k: run.get(k) for k in RUN_FIELDS}
        if run["status"] != "completed":
            raise RuntimeError("Attempt has not reached its terminal state")
        jobs = list(
            self.api.pages(
                f"actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs", "jobs"
            )
        )
        jobs = [j for j in jobs if j["run_attempt"] == run["run_attempt"]]
        deadline = time.time() + 30
        for job in jobs:
            if job["status"] != "completed":
                raise RuntimeError("Completed run still has nonterminal jobs")
            self.collect_job(run, job, deadline)
        self.store.finish(run, jobs)

    def collect_pending(self, deadline):
        while time.time() < deadline:
            pending = self.store.pending()
            if pending is None:
                break
            if (
                pending["priority"] < self.store.installed_at
                and self.api.remaining < 2000
            ):
                break
            self.collect_attempt(pending)

    def flush(self):
        cutoff = int((time.time() - LOKI_MAX_SAMPLE_AGE_SECONDS) * 1e9)
        with self.store.db:
            self.store.db.execute(
                "INSERT OR IGNORE INTO loki_rejections SELECT id, stamp, labels, line, 'expired_unacknowledged', ? FROM outbox WHERE CAST(stamp AS INTEGER) < ?",
                (time.time(), cutoff),
            )
            self.store.db.execute(
                "DELETE FROM outbox WHERE CAST(stamp AS INTEGER) < ?", (cutoff,)
            )
        rows = self.store.db.execute(
            "SELECT * FROM outbox ORDER BY id LIMIT 100"
        ).fetchall()
        if not rows:
            return
        streams = collections.defaultdict(list)
        for row in rows:
            streams[row["labels"]].append([row["stamp"], row["line"]])
        body = json.dumps(
            {
                "streams": [
                    {"stream": json.loads(k), "values": v} for k, v in streams.items()
                ]
            }
        ).encode()
        request = urllib.request.Request(
            self.loki_url,
            data=body,
            headers={"Content-Type": "application/json", "X-Scope-OrgID": "anonymous"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15):
                pass
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            raise RuntimeError(f"Loki ingestion returned HTTP {code}") from None
        with self.store.db:
            self.store.db.executemany(
                "DELETE FROM outbox WHERE id=?", [(r["id"],) for r in rows]
            )

    def refresh(self):
        now = time.time()
        metrics = self.store.render(now) + self.active_metrics
        for name, value in {
            "last_poll_timestamp_seconds": self.last_poll,
            "last_history_scan_timestamp_seconds": self.last_history,
            "collection_errors_total": self.errors,
            "cache_errors_total": self.cache_errors,
            "github_rate_limit_remaining": self.api.remaining,
            "backfill_complete": int(
                self.last_history > 0
                and not self.store.db.execute(
                    "SELECT 1 FROM attempts WHERE state='pending' AND priority<? LIMIT 1",
                    (self.store.installed_at,),
                ).fetchone()
            ),
        }.items():
            metrics += exposition("ci_observability_" + name, value)
        self.metrics = metrics.encode()

    def failure(self, error):
        self.errors += 1
        print(
            json.dumps(
                {
                    "event": "ci_collection_failed",
                    "error_type": type(error).__name__,
                    "message": str(error)
                    if isinstance(error, RuntimeError)
                    else "Collection request failed",
                }
            ),
            flush=True,
        )

    def run(self):
        while True:
            begin = time.time()
            try:
                self.poll(begin)
                self.collect_pending(time.time() + 20)
            except Exception as error:
                self.failure(error)
            try:
                self.history(begin)
            except Exception as error:
                self.failure(error)
            try:
                self.collect_pending(time.time() + 10)
                with self.store.db:
                    self.store.db.execute(
                        "DELETE FROM jobs WHERE completed < ?", (begin - 90 * 86400,)
                    )
            except Exception as error:
                self.failure(error)
            try:
                while self.store.db.execute("SELECT 1 FROM outbox LIMIT 1").fetchone():
                    self.flush()
                    if time.time() > begin + 55:
                        break
            except Exception as error:
                self.failure(error)
            self.refresh()
            time.sleep(max(1, 60 - (time.time() - begin)))


def main():
    root = pathlib.Path(os.environ.get("CI_STATE_DIR", "/data"))
    root.mkdir(parents=True, exist_ok=True)
    workflows = json.loads(
        pathlib.Path(
            os.environ.get("CI_WORKFLOWS_FILE", "/app/workflows.json")
        ).read_text()
    )
    collector = Collector(
        Store(root / "ci.sqlite3"),
        GitHub(os.environ["GITHUB_TOKEN"]),
        workflows,
        os.environ["LOKI_PUSH_URL"],
    )
    collector.refresh()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/metrics":
                body = collector.metrics
                content_type = "text/plain; version=0.0.4; charset=utf-8"
            elif self.path in ("/healthz", "/readyz"):
                body, content_type = b"ok\n", "text/plain"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            return

    server = http.server.ThreadingHTTPServer(("0.0.0.0", 9101), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    collector.run()


if __name__ == "__main__":
    main()
