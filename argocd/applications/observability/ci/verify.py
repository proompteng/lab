"""Read-only runtime receipt comparing durable records with GitHub and Loki."""

import argparse
import datetime as dt
import json
import os
import sqlite3
import time
import urllib.parse
import urllib.request

from collector import GitHub


def epoch(value):
    if not value or value.startswith("0001-"):
        return None
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def query(url, parameters):
    request = urllib.request.Request(
        url + "?" + urllib.parse.urlencode(parameters),
        headers={"X-Scope-OrgID": "anonymous"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def verify(run_id, attempt):
    api = GitHub(os.environ["GITHUB_TOKEN"])
    db = sqlite3.connect("file:/data/ci.sqlite3?mode=ro", uri=True)
    jobs = [
        j
        for j in api.pages(f"actions/runs/{run_id}/attempts/{attempt}/jobs", "jobs")
        if j["run_attempt"] == attempt
    ]
    actual = {
        row[0]: json.loads(row[1])
        for row in db.execute(
            "SELECT job_id, record FROM jobs WHERE run_id=? AND attempt=?",
            (run_id, attempt),
        )
    }
    if set(actual) != {j["id"] for j in jobs}:
        raise RuntimeError("The stored job set differs from the GitHub attempt")
    receipt = []
    for job in jobs:
        record = actual[job["id"]]
        created, started, completed = (
            epoch(job.get(key)) for key in ("created_at", "started_at", "completed_at")
        )
        assigned = bool(job.get("runner_name"))
        queue_end = started if assigned else completed
        expected_queue = (
            max(0, queue_end - created)
            if queue_end is not None and created is not None
            else None
        )
        expected_execution = (
            max(0, completed - started)
            if assigned and started is not None and completed is not None
            else None
        )
        if (
            record["durations"].get("queue") != expected_queue
            or record["durations"].get("execution") != expected_execution
        ):
            raise RuntimeError(
                "Stored queue or execution duration differs from GitHub timestamps"
            )
        if record["github_conclusion"] != (job["conclusion"] or "unknown"):
            raise RuntimeError("Stored outcome differs from the GitHub job")
        receipt.append(
            {
                k: record[k]
                for k in (
                    "job_id",
                    "architecture",
                    "runner_pool",
                    "outcome",
                    "durations",
                    "cache_state",
                    "collection_mode",
                    "collection_delay_seconds",
                )
            }
        )
    loki = query(
        "http://observability-loki-loki-distributed-gateway.observability.svc.cluster.local/loki/api/v1/query_range",
        {
            "query": f'{{service="ci-observability",kind="job"}} | json | run_id="{run_id}" | attempt="{attempt}"',
            "start": str(int((time.time() - 86400) * 1e9)),
            "end": str(time.time_ns()),
            "limit": "5000",
        },
    )
    loki_ids = {
        json.loads(line)["job_id"]
        for stream in loki["data"]["result"]
        for _, line in stream["values"]
    }
    if loki_ids != set(actual):
        raise RuntimeError("Loki records do not match the complete GitHub attempt")
    mimir = query(
        "http://observability-mimir-gateway.observability.svc.cluster.local/prometheus/api/v1/query",
        {"query": "time() - max(ci_observability_last_poll_timestamp_seconds)"},
    )
    results = mimir["data"]["result"]
    if not results or float(results[0]["value"][1]) > 180:
        raise RuntimeError("Mimir does not show a fresh collector poll")
    db.close()
    return {
        "run_id": run_id,
        "attempt": attempt,
        "github_jobs_match": True,
        "loki_jobs_match": True,
        "mimir_poll_fresh": True,
        "jobs": receipt,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("run_id", type=int)
    parser.add_argument("attempt", type=int)
    args = parser.parse_args()
    print(json.dumps(verify(args.run_id, args.attempt), indent=2))
