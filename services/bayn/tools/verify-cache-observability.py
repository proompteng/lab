#!/usr/bin/env python3
"""Read-only acceptance of the deployed Bayn cache observability contract."""

import argparse
import datetime
import json
import re
import time
import urllib.parse
import urllib.request


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def read_json(base, path, parameters=None):
    url = base.rstrip("/") + path
    if parameters:
        url += "?" + urllib.parse.urlencode(parameters, doseq=True)
    request = urllib.request.Request(url, headers={"X-Scope-OrgID": "anonymous"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def verify(args):
    require(re.fullmatch(r"[a-f0-9]{40}", args.source), "source must be a full Git SHA")
    now = time.time()

    def query(expression):
        result = read_json(
            args.mimir, "/prometheus/api/v1/query", {"query": expression}
        )
        require(result.get("status") == "success", "Mimir query failed")
        return result["data"]["result"]

    def values(expression):
        return [float(row["value"][1]) for row in query(expression)]

    valkey = 'job="bayn-valkey",namespace="bayn"'
    for name in ["up", "redis_up"]:
        observed = values(f"{name}{{{valkey}}}")
        require(
            len(observed) == 2 and observed == [1, 1],
            f"both Valkey {name} series must be up",
        )
    require(
        values(f"max(redis_connected_slaves{{{valkey}}})") == [1],
        "required Valkey replica is absent",
    )
    require(
        values(f"max(redis_master_link_up{{{valkey}}})") == [1],
        "Valkey replica link is down",
    )

    app = f'namespace="bayn",source_revision="{args.source}",service=~"bayn|bayn-execution-controller"'
    heartbeat_metric = f"bayn_telemetry_heartbeat_timestamp_seconds{{{app}}}"
    heartbeat = query(
        f"({heartbeat_metric} > time() - 90) and ({heartbeat_metric} <= time() + 5)"
    )
    for service in ["bayn", "bayn-execution-controller"]:
        rows = [row for row in heartbeat if row["metric"].get("service") == service]
        require(
            len(rows) >= 2, f"expected two fresh source-bound heartbeats for {service}"
        )

    expected = {
        "bayn.valkey.get",
        "bayn.valkey.put",
        "bayn.valkey.set",
        "bayn.valkey.replica-ack",
        "bayn.broker.observation.materialization",
        "bayn.broker.observation.fence",
        "bayn.broker.observation.capture",
        "bayn.broker.observation.publish",
    }
    conditional = {
        "bayn.postgres.writer-fence",
        "bayn.postgres.commit",
        "bayn.reconciliation.persist",
        "bayn.postgres.generation-settlement",
    }
    counts = query(f"sum by(stage) (bayn_operation_duration_seconds_count{{{app}}})")
    stages = {row["metric"]["stage"]: float(row["value"][1]) for row in counts}
    require(
        all(stages.get(stage, 0) > 0 for stage in expected),
        f"missing operation histograms: {sorted(expected - stages.keys())}",
    )
    buckets = query(
        f"sum by(stage,le) (bayn_operation_duration_seconds_bucket{{{app}}})"
    )
    require(
        all(
            any(row["metric"].get("stage") == stage for row in buckets)
            for stage in expected | (conditional & stages.keys())
        ),
        "histogram buckets are missing",
    )
    hits = values(f'sum(bayn_valkey_reads_total{{{app},outcome="hit"}})')
    require(bool(hits) and hits[0] > 0, "native cache hits are absent")
    require(
        len(query(f"bayn_broker_materialization_bytes_count{{{app}}}")) > 0,
        "payload byte histograms are absent",
    )

    index = 'namespace="bayn",cluster="bayn-db",role="primary"'
    for name in ["valid", "ready"]:
        require(
            values(f"cnpg_bayn_generation_index_{name}{{{index}}}") == [1],
            f"generation index is not {name}",
        )
    require(
        len(query(f"cnpg_bayn_generation_index_scans_total{{{index}}}")) == 1,
        "generation index scan counter is absent",
    )

    rules = read_json(args.mimir, "/prometheus/api/v1/rules")["data"]["groups"]
    groups = [
        group for group in rules if group["name"] == "bayn-cache-performance.rules"
    ]
    require(
        len(groups) == 1 and len(groups[0]["rules"]) == 8,
        "eight cache alert rules must be installed",
    )
    require(
        all(rule.get("health") == "ok" for rule in groups[0]["rules"]),
        "cache alert rule evaluation failed",
    )

    logs = read_json(
        args.loki,
        "/loki/api/v1/query_range",
        {
            "query": '{namespace="bayn",service="bayn-valkey",container=~"valkey|exporter"}',
            "start": str(int((now - 172800) * 1e9)),
            "end": str(int(now * 1e9)),
            "limit": 10,
        },
    )
    log_rows = logs.get("data", {}).get("result", [])
    require(logs.get("status") == "success", "Valkey server/exporter log query failed")

    traces = read_json(
        args.tempo,
        "/api/search",
        {
            "q": '{ resource.service.version = "'
            + args.source
            + '" && name = "bayn.valkey.replica-ack" }',
            "start": int(now - 900),
            "end": int(now),
            "limit": 5,
        },
    )
    require(
        len(traces.get("traces", [])) > 0,
        "source-bound replica acknowledgement traces are absent",
    )
    return {
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": args.source,
        "valkeyExporterPairsUp": 2,
        "sourceBoundHeartbeats": len(heartbeat),
        "operationCounts": stages,
        "conditionalOperationCounts": {
            stage: stages.get(stage) for stage in sorted(conditional)
        },
        "histogramSeries": len(buckets),
        "indexValid": True,
        "indexReady": True,
        "alertRules": [
            {"name": rule["name"], "health": rule["health"], "state": rule["state"]}
            for rule in groups[0]["rules"]
        ],
        "valkeyLogCollection": {
            "state": "OBSERVED" if log_rows else "NOT_OBSERVED",
            "streams": len(log_rows),
            "windowHours": 48,
        },
        "replicaAckTraces": len(traces["traces"]),
        "limits": [
            "Read-only acceptance; notification delivery is not tested",
            "Index counters do not prove a particular query plan",
            "Quiet server logs can have old event timestamps",
            "Conditional stages without samples and empty log windows are unobserved, not proof of collection",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--mimir", default="http://127.0.0.1:19116")
    parser.add_argument("--loki", default="http://127.0.0.1:19115")
    parser.add_argument("--tempo", default="http://127.0.0.1:19114")
    print(json.dumps(verify(parser.parse_args()), indent=2))
