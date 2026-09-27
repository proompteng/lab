import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.request import urlopen

ENGINE_REVISION = "4888528abcfdcd36e2f4a6a1ffa0262b67683c66"


def read_lock(path):
    lock = json.loads(path.read_text())
    if not re.fullmatch(r"[\w-]+/[\w.-]+", lock["repository"]):
        raise ValueError("Invalid model repository")
    if not re.fullmatch(r"[0-9a-f]{40}", lock["revision"]):
        raise ValueError("Model revision must be immutable")
    names = set()
    for item in lock["files"]:
        name = item["name"]
        if not re.fullmatch(r"[\w-][\w.-]*", name) or name in names:
            raise ValueError("Invalid or duplicated model filename")
        if not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]) or item["bytes"] <= 0:
            raise ValueError(f"Invalid file identity: {name}")
        names.add(name)
    if not names or not lock["servedModel"]:
        raise ValueError("Empty model lock")
    return lock


def verify_file(path, item):
    if path.stat().st_size != item["bytes"]:
        raise ValueError(f"Model file size mismatch: {item['name']}")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != item["sha256"]:
        raise ValueError(f"Model file digest mismatch: {item['name']}")


def prepare(lock, cache, fetch=urlopen):
    model = cache / lock["revision"]
    model.mkdir(parents=True, exist_ok=True)
    for item in lock["files"]:
        path = model / item["name"]
        if not path.exists():
            url = (
                f"https://huggingface.co/{lock['repository']}/resolve/"
                f"{lock['revision']}/{item['name']}"
            )
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=model, delete=False) as output:
                    temporary = Path(output.name)
                    with fetch(url, timeout=60) as response:
                        count = 0
                        while block := response.read(8 * 1024 * 1024):
                            count += len(block)
                            if count > item["bytes"]:
                                raise ValueError("Download exceeds locked size")
                            output.write(block)
                verify_file(temporary, item)
                temporary.replace(path)
            except Exception:
                raise ValueError(
                    f"Model download failed verification: {item['name']}"
                ) from None
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
        verify_file(path, item)
        print(
            json.dumps({"verified": item["name"], "sha256": item["sha256"]}), flush=True
        )
    return model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--lock", type=Path, default=Path(__file__).with_name("model-lock.json")
    )
    parser.add_argument("--cache", type=Path, default=Path("/models"))
    args = parser.parse_args()
    lock = read_lock(args.lock)
    model = prepare(lock, args.cache)
    os.environ["SUROGATE_CONVERT_DEVICE"] = "cpu"
    os.environ["SUROGATE_SERVE_CACHE"] = str(args.cache / "prepared" / ENGINE_REVISION)
    os.execv(
        sys.executable,
        [
            sys.executable,
            "-m",
            "surogate.cli.serve",
            str(model),
            "--served-model-name",
            lock["servedModel"],
            "--host",
            "0.0.0.0",
            "--port",
            "8080",
            "--device",
            "0",
            "--max-model-len",
            "32768",
            "--kv-capacity",
            "32768",
            "--kv-cache-dtype",
            "bf16",
            "--max-num-seqs",
            "8",
            "--max-pending-requests",
            "8",
            "--pending-timeout-ms",
            "5000",
            "--gpu-memory-limit-mib",
            "85000",
            "--decision-temperature",
            "2",
            "--decision-attempts",
            "1",
        ],
    )


if __name__ == "__main__":
    main()
