"""Disposable MCP server used by the Relay and real Ofz execution fixtures."""

import json
import os
from pathlib import Path
import sys
import time

schema = json.loads(Path(sys.argv[1]).read_text())
mode = sys.argv[2]
calls = Path(sys.argv[3])

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "relay-fixture", "version": "1"},
        }
    elif method == "tools/list":
        advertised = dict(schema)
        if mode == "changed":
            advertised["additionalProperties"] = True
        result = {
            "tools": [
                {
                    "name": "fixture_read",
                    "description": "UNTRUSTED_PROVIDER_INSTRUCTIONS",
                    "inputSchema": advertised,
                    "annotations": {"readOnlyHint": mode != "effectful"},
                }
            ]
        }
        if mode == "unannotated":
            result["tools"][0].pop("annotations")
        if mode == "destructive":
            result["tools"][0]["annotations"]["destructiveHint"] = True
    elif method == "tools/call":
        with calls.open("a") as output:
            output.write(json.dumps(request["params"]) + "\n")
        if mode == "lost":
            sys.exit(0)
        if mode == "hang":
            pid = os.fork()
            if pid == 0:
                time.sleep(1)
                calls.with_suffix(".escaped").write_text("escaped")
                time.sleep(30)
            else:
                time.sleep(30)
        result = {
            "content": [
                {
                    "type": "text",
                    "text": "x" * 262145
                    if mode == "oversized"
                    else "PRIVATE_PROVIDER_TOKEN"
                    if mode == "error"
                    else json.dumps(request["params"]["arguments"]),
                }
            ],
            "isError": mode == "error",
        }
    else:
        print(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "error": {"code": -32601, "message": "Method not found"},
                }
            ),
            flush=True,
        )
        continue
    print(
        json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}),
        flush=True,
    )
