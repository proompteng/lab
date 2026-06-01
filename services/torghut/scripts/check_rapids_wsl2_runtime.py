#!/usr/bin/env python3
from __future__ import annotations

import json
import platform
import subprocess
from importlib import import_module
from typing import Any


def _run(command: list[str]) -> dict[str, Any]:
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    return {
        "command": command,
        "returncode": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
    }


def _module_version(name: str) -> str | None:
    try:
        module = import_module(name)
    except Exception:
        return None
    return str(getattr(module, "__version__", "") or "unknown")


def main() -> int:
    payload = {
        "schema_version": "torghut.rapids-wsl2-runtime-check.v1",
        "platform": platform.platform(),
        "python": platform.python_version(),
        "nvidia_smi": _run(
            [
                "nvidia-smi",
                "--query-gpu=name,driver_version,memory.total,compute_cap",
                "--format=csv,noheader",
            ]
        ),
        "modules": {
            "cudf": _module_version("cudf"),
            "dask_cudf": _module_version("dask_cudf"),
            "cuml": _module_version("cuml"),
            "cugraph": _module_version("cugraph"),
        },
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload["modules"]["cudf"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
