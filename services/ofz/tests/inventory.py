#!/usr/bin/env python3
"""Fail closed when a protected service surface has no reviewed policy action."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OFZ = ROOT / "services/ofz"


def without_comments(source):
    return re.sub(
        r"""("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|/\*[\s\S]*?\*/|//[^\n]*""",
        lambda match: match.group(1) or " ",
        source,
    )


def next_methods(source):
    source = without_comments(source)
    assert not re.search(r"\bexport\s*\*", source), (
        "wildcard Next route exports require explicit method declarations"
    )
    methods = set(
        re.findall(
            r"\bexport\s+(?:(?:async\s+)?function|const|let|var)\s+"
            r"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b",
            source,
        )
    )
    for exports in re.findall(r"\bexport\s*\{([^}]+)\}", source):
        for declaration in exports.split(","):
            declaration = declaration.strip()
            if declaration.startswith("type "):
                continue
            name = re.split(r"\s+as\s+", declaration)[-1].strip().strip("\"'")
            if name in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}:
                methods.add(name)
    return methods


def rust_routes(source, fallback=None):
    source = without_comments(source)
    assert not re.search(
        r"(?:\.|::)(?:route_service|nest|nest_service|merge|fallback_service|method_not_allowed_fallback)\s*\(|::route\s*\(|\.(?:on|on_service)\s*\(",
        source,
    ), "Axum router composition requires explicit inventory support"
    fallbacks = list(re.finditer(r"\.fallback\s*\(", source))
    assert len(fallbacks) == (1 if fallback else 0) and all(
        re.match(r"\s*" + re.escape(fallback or "") + r"\s*\)", source[call.end() :])
        for call in fallbacks
    ), "Axum fallback requires explicit inventory support"
    operations = set()
    for call in re.finditer(r"\.route\s*\(", source):
        route = re.match(r'\s*"([^"\\]+)"\s*,', source[call.end() :])
        assert route, "Axum route path must be an explicit string literal"
        start = call.end() + route.end()
        depth = 1
        quoted = escaped = False
        end = start
        for end in range(start, len(source)):
            char = source[end]
            if quoted:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    quoted = False
            elif char == '"':
                quoted = True
            elif char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if not depth:
                    break
        assert depth == 0, f"unparsed route: {route.group(1)}"
        methods = set(
            re.findall(
                r"\b(get|head|post|put|patch|delete|options|trace|connect|any)\s*\(",
                source[start:end],
            )
        )
        assert methods, f"review route method dispatch: {route.group(1)}"
        # Axum's GET router also handles HEAD with the same handler.
        if "get" in methods:
            methods.add("head")
        operations.update(
            f"{'*' if method == 'any' else method.upper()} {route.group(1)}"
            for method in methods
        )
    return operations


def go_routes(source):
    source = without_comments(source)
    assert not re.search(r"\.Handle(?:Func)?\b(?!\s*\()", source), (
        "Go handler aliases require explicit inventory support"
    )
    routes = set()
    for call in re.finditer(r"\b\w+\.Handle(?:Func)?\s*\(", source):
        path = re.match(r'\s*"([^"\\]+)"\s*,', source[call.end() :])
        assert path, "Go handler path must be an explicit string literal"
        routes.add(path.group(1))
    return routes


def operation_cases(source, selector=None, default=None):
    source = without_comments(source)
    if selector:
        # Only this explicit dispatch may classify the operation. Code before/after it,
        # including an early allow, cannot inspect the operation discriminator.
        masked = re.sub(
            r""""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`""",
            lambda match: " " * len(match[0]),
            source,
        )
        switches = list(
            re.finditer(
                r"\bswitch\s*(?:\(\s*)?" + re.escape(selector) + r"\s*\)?\s*\{", masked
            )
        )
        assert len(switches) == 1, "operation dispatch requires one explicit switch"
        start = switches[0].end()
        depth = 1
        end = start
        for end in range(start, len(masked)):
            depth += (masked[end] == "{") - (masked[end] == "}")
            if depth == 0:
                break
        assert depth == 0, "unparsed operation switch"
        outside = masked[: switches[0].start()] + masked[end + 1 :]
        # The Go function signature declares the argument but cannot execute it.
        outside = re.sub(r"\bfunc\s+\w+\s*\([^)]*\)[^{]*\{", "", outside, count=1)
        assert not re.search(r"\b" + re.escape(selector) + r"\b", outside), (
            "operation logic outside the classified switch"
        )
        root = selector.split(".")[0]
        if selector == "action.action":
            outside = re.sub(
                r"\bconst\s+action\s*=\s*parsed\.data\b", "", outside, count=1
            )
        elif selector == "request.Method":
            outside = re.sub(
                r"\bvar\s+request\s+struct\s*\{[^}]*\}", "", outside, count=1
            )
            outside = re.sub(
                r"\bjson\.Unmarshal\(scanner\.Bytes\(\),\s*&request\)",
                "",
                outside,
                count=1,
            )
            outside = re.sub(r"\brequest\.ID\b", "", outside)
        assert not re.search(r"\b" + re.escape(root) + r"\b", outside), (
            "operation discriminator aliases require inventory review"
        )
        source = source[start:end]
        branch = re.search(r"\bdefault\s*:", masked[start:end])
        if default is None:
            assert branch is None, "unclassified operation default"
        else:
            assert branch and re.fullmatch(default, source[branch.end() :].strip()), (
                "operation default must deny unknown values"
            )
            source = source[: branch.start()]
    methods = set()
    for clause in re.findall(r"\bcase\s+([^:]+):", source):
        literal = r"""(?:"[^"\\]+"|'[^'\\]+')"""
        assert re.fullmatch(rf"\s*{literal}(?:\s*,\s*{literal})*\s*", clause), (
            "operation cases must contain explicit string literals"
        )
        methods.update(match[1:-1] for match in re.findall(literal, clause))
    return methods


def codex_cases(source):
    # This allowlist has one permitted implementation shape. Adding another return,
    # condition, delegation or default requires an explicit contract change.
    literal = r"""(?:"[^"\\]+"|'[^'\\]+')"""
    assert re.fullmatch(
        rf"\s*func allowedCodexMethod\(method string\) bool\s*\{{\s*switch method\s*\{{\s*case\s+{literal}(?:\s*,\s*{literal})*\s*:\s*return true\s*default\s*:\s*return false\s*\}}\s*\}}\s*",
        without_comments(source),
    ), "Codex allowlist requires an exhaustive literal switch"
    return operation_cases(source, "method", r"return\s+false")


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
            re.findall(r"\brpc\s+(\w+)\s*\(", (ROOT / proto).read_text())
        )
    bff = (ROOT / "apps/landing/src/app/api/tengri/route.ts").read_text()
    actual["bff"] = operation_cases(bff, "action.action")
    gateway = (ROOT / "services/tengri/src/gateway.rs").read_text()
    gateway = gateway[
        gateway.index("pub fn control_router") : gateway.index("async fn readiness")
    ]
    actual["gateway"] = rust_routes(gateway, "preview_host_proxy")
    actual["gateway"].add("* {*preview_host_proxy}")
    codex = (ROOT / "services/nanoagent/codex.go").read_text()
    codex = codex[codex.index("func allowedCodexMethod") :]
    codex = codex[: codex.index("\n}")]
    actual["codex"] = codex_cases(codex + "\n}")
    api_root = ROOT / "apps/landing/src/app/api/tengri"
    actual["bff_http"] = set()
    for path in api_root.rglob("route.*"):
        assert path.suffix in {".js", ".jsx", ".ts", ".tsx"}, (
            "unsupported Next route extension requires inventory review"
        )
        route = "/api/tengri/" + str(path.parent.relative_to(api_root))
        route = route.removesuffix("/.")
        for method in next_methods(path.read_text()):
            actual["bff_http"].add(f"{method} {route}")
    guest_http = "\n".join(
        path.read_text()
        for path in (ROOT / "services/nanoagent").rglob("*.go")
        if not path.name.endswith("_test.go")
    )
    actual["guest_http"] = go_routes(guest_http)
    supervisor = (ROOT / "services/tengri/src/slot/supervisor.rs").read_text()
    actual["supervisor"] = rust_routes(supervisor, "forward")
    actual["supervisor"].add("* {*forward}")
    computer = (ROOT / "services/nanoagent/browser_cua.go").read_text()
    browser_mcp = computer[computer.index("func runBrowserMCP") :]
    browser_mcp = browser_mcp[: browser_mcp.index("\n}") + 2]
    actual["browser_mcp"] = operation_cases(
        browser_mcp, "request.Method", r'failure\s*=\s*errors\.New\("[^"\\]*"\)'
    )
    actions = computer[computer.index("func validateComputerAction") :]
    actions = actions[: actions.index("\n}")]
    actual["browser_action"] = operation_cases(
        actions, "action.Action", r'return\s+errors\.New\("[^"\\]*"\)'
    )
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
