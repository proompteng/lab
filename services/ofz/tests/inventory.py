#!/usr/bin/env python3
"""Fail closed when a protected service surface has no reviewed policy action."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OFZ = ROOT / "services/ofz"


def main():
    catalog = json.loads((OFZ / "operations.json").read_text())
    actions = set(
        re.findall(
            r"^\s*(ACTION_\w+)\s*=",
            (ROOT / "proto/proompteng/authz/v1/authz.proto").read_text(),
            re.M,
        )
    ) - {"ACTION_UNSPECIFIED"}
    known = {}
    for entry in catalog:
        key = entry["surface"], entry["operation"]
        assert key not in known, f"duplicate operation: {key}"
        assert entry.get("public") is True or entry.get("action") in actions, (
            f"invalid action: {entry}"
        )
        assert not (entry.get("public") and entry.get("action")), (
            f"ambiguous operation: {entry}"
        )
        known[key] = entry

    actual = {}
    for surface, proto in [
        ("ofz", "proto/proompteng/authz/v1/authz.proto"),
        ("controller", "services/tengri/proto/proompteng/runtime/v1/microvm.proto"),
        ("guest", "services/tengri/proto/proompteng/runtime/guest/v1/nanoagent.proto"),
    ]:
        actual[surface] = set(
            re.findall(r"\brpc\s+(\w+)\(", (ROOT / proto).read_text())
        )
    bff = (ROOT / "apps/landing/src/app/api/tengri/route.ts").read_text()
    actual["bff"] = set(re.findall(r"case '([^']+)':", bff))
    gateway = (ROOT / "services/tengri/src/gateway.rs").read_text()
    gateway = gateway[
        gateway.index("pub fn control_router") : gateway.index("async fn readiness")
    ]
    actual["gateway"] = set(re.findall(r'\.route\(\s*"([^"]+)"', gateway))
    assert ".fallback(preview_host_proxy)" in gateway, "review changed preview dispatch"
    actual["gateway"].add("{*preview_host_proxy}")
    codex = (ROOT / "services/nanoagent/codex.go").read_text()
    codex = codex[codex.index("func allowedCodexMethod") :]
    codex = codex[: codex.index("\n}")]
    actual["codex"] = set(re.findall(r'"([a-zA-Z]+/[a-zA-Z/]+)"', codex))
    api_root = ROOT / "apps/landing/src/app/api/tengri"
    actual["bff_http"] = set()
    for path in api_root.rglob("route.ts"):
        route = "/api/tengri/" + str(path.parent.relative_to(api_root))
        route = route.removesuffix("/.")
        for method in re.findall(
            r"export\s+(?:(?:async\s+)?function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b",
            path.read_text(),
        ):
            actual["bff_http"].add(f"{method} {route}")
    guest_http = "\n".join(
        path.read_text()
        for path in (ROOT / "services/nanoagent").rglob("*.go")
        if not path.name.endswith("_test.go")
    )
    actual["guest_http"] = set(
        re.findall(r'\b\w+\.Handle(?:Func)?\(\s*"([^"]+)"', guest_http)
    )
    supervisor = (ROOT / "services/tengri/src/slot/supervisor.rs").read_text()
    actual["supervisor"] = set(re.findall(r'\.route\(\s*"([^"]+)"', supervisor))
    assert ".fallback(forward)" in supervisor, "review changed supervisor dispatch"
    actual["supervisor"].add("{*forward}")
    computer = (ROOT / "services/nanoagent/browser_cua.go").read_text()
    browser_mcp = computer[computer.index("func runBrowserMCP") :]
    actual["browser_mcp"] = set(re.findall(r'case "([a-z/]+)":', browser_mcp))
    actions = computer[computer.index("func validateComputerAction") :]
    actions = actions[: actions.index("\n}")]
    cases = re.findall(r"case ([^:\n]+):", actions)
    actual["browser_action"] = set(re.findall(r'"([a-z_]+)"', " ".join(cases)))
    actual["browser_action"].add("status")
    for surface, operations in actual.items():
        classified = {op for kind, op in known if kind == surface}
        assert classified == operations, (
            f"{surface}: unclassified={sorted(operations - classified)}, "
            f"stale={sorted(classified - operations)}"
        )
    counts = {surface: len(operations) for surface, operations in actual.items()}
    print(
        json.dumps({"classified_operations": counts, "result": "PASS"}, sort_keys=True)
    )


if __name__ == "__main__":
    main()
