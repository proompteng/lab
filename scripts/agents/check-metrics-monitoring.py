"""Check that the rendered ServiceMonitor reaches each Agents metrics endpoint."""

import sys

import yaml


def matches(labels, selector):
    return all(labels.get(key) == value for key, value in selector.items())


docs = [doc for doc in yaml.safe_load_all(sys.stdin) if doc]
(monitor,) = [doc for doc in docs if doc["kind"] == "ServiceMonitor"]
assert monitor["metadata"]["namespace"] == "monitoring"
spec = monitor["spec"]
(endpoint,) = spec["endpoints"]
assert endpoint["path"] == "/internal/metrics"

scraped = {}
for service in docs:
    if service["kind"] != "Service":
        continue
    meta = service["metadata"]
    if meta["namespace"] not in spec["namespaceSelector"]["matchNames"] or not matches(
        meta["labels"], spec["selector"]["matchLabels"]
    ):
        continue
    (port,) = service["spec"]["ports"]
    assert (port["name"], port["port"]) == (endpoint["port"], 9191), service
    (deployment,) = [
        doc
        for doc in docs
        if doc["kind"] == "Deployment"
        and doc["metadata"]["namespace"] == meta["namespace"]
        and matches(
            doc["spec"]["template"]["metadata"]["labels"], service["spec"]["selector"]
        )
    ]
    (container,) = [
        container
        for container in deployment["spec"]["template"]["spec"]["containers"]
        if any(p["name"] == port["targetPort"] for p in container.get("ports", []))
    ]
    env = {var["name"]: var.get("value") for var in container["env"]}
    assert env["AGENTS_PROMETHEUS_METRICS_ENABLED"] == "true"
    assert env["AGENTS_PROMETHEUS_METRICS_PATH"] == endpoint["path"]
    scraped[meta["name"]] = (deployment["metadata"]["name"], service["spec"]["type"])

expected = {"metrics-check-agents-metrics": ("metrics-check-agents", "NodePort")}
if sys.argv[1] == "true":
    expected["metrics-check-agents-controllers-metrics"] = (
        "metrics-check-agents-controllers",
        "ClusterIP",
    )
assert scraped == expected, f"ServiceMonitor targets: {scraped}, expected {expected}"
