import hashlib
import json
from pathlib import Path
from urllib.request import urlopen


def main():
    root = Path(__file__).parent
    source = json.loads((root / "model-source.json").read_text())
    repo = source["repository"]
    revision = source["revision"]
    with urlopen(
        f"https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true",
        timeout=60,
    ) as response:
        metadata = json.load(response)
    if metadata["sha"] != revision:
        raise ValueError("Hugging Face returned a different revision")
    files = {item["rfilename"]: item for item in metadata["siblings"]}
    locked = []
    for name in source["files"]:
        item = files[name]
        if "lfs" in item:
            digest = item["lfs"]["sha256"]
        else:
            with urlopen(
                f"https://huggingface.co/{repo}/resolve/{revision}/{name}", timeout=60
            ) as response:
                data = response.read()
            if len(data) != item["size"]:
                raise ValueError(f"Unexpected size for {name}")
            digest = hashlib.sha256(data).hexdigest()
        locked.append({"name": name, "bytes": item["size"], "sha256": digest})
    result = {**source, "files": locked}
    (root / "model-lock.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
