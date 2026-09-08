import json
import sys
from pathlib import Path

# Simple helper to extract the OpenAPI schema from a CRD YAML and emit a kubeconform schema.
# Usage: python scripts/download_crd_schema.py <crd-yaml-path> <group> <version> <kind>

if len(sys.argv) != 5:
    print("usage: python scripts/download_crd_schema.py <crd-yaml> <group> <version> <kind>", file=sys.stderr)
    sys.exit(1)

crd_path = Path(sys.argv[1])
group = sys.argv[2]
version = sys.argv[3]
kind = sys.argv[4]
kind_slug = kind.lower()
short_group = group.split(".", 1)[0] if group else ""
kind_suffix = f"-{group}-{version}" if group else f"-{version}"
short_kind_suffix = f"-{short_group}-{version}" if short_group else f"-{version}"
generic_schema_kind_denylist = {"Service"}

import yaml

with crd_path.open() as f:
    crd = yaml.safe_load(f)

for version_entry in crd.get("spec", {}).get("versions", []):
    name = version_entry.get("name")
    schema = version_entry.get("schema", {}).get("openAPIV3Schema")
    if name == version and schema:
        # kubeconform expects top-level type object with properties
        output = {
            "type": "object",
            "properties": schema.get("properties", {}),
            "dependencies": schema.get("dependencies", {}),
            "definitions": schema.get("definitions", {}),
            "additionalProperties": schema.get("additionalProperties", True),
        }
        if schema.get("required"):
            output["required"] = schema["required"]
        # kubeconform resolution differs across kinds; emit multiple naming styles.
        out_paths = []
        if group:
            out_paths.extend(
                [
                    Path(f"schemas/custom/{group}_{version}_{kind}.json"),
                    Path(f"schemas/custom/{kind}{kind_suffix}.json"),
                    Path(f"schemas/custom/{kind}_{group}_{version}.json"),
                    Path(f"schemas/custom/{group}/{version}/{kind}.json"),
                    Path(f"schemas/custom/{group}/{kind}_{version}.json"),
                ]
            )
            if kind not in generic_schema_kind_denylist:
                out_paths.extend(
                    [
                        Path(f"schemas/custom/{kind}-{version}.json"),
                        Path(f"schemas/custom/{kind}_{version}.json"),
                        Path(f"schemas/custom/{kind}.json"),
                    ]
                )
        else:
            out_paths.extend(
                [
                    Path(f"schemas/custom/{kind}-{version}.json"),
                    Path(f"schemas/custom/{kind}_{version}.json"),
                    Path(f"schemas/custom/{kind}.json"),
                ]
            )
        lowercase_paths = []
        if short_group:
            lowercase_paths.extend(
                [
                    Path(f"schemas/custom/{short_group}_{version}_{kind}.json"),
                    Path(f"schemas/custom/{kind}{short_kind_suffix}.json"),
                    Path(f"schemas/custom/{kind}_{short_group}_{version}.json"),
                    Path(f"schemas/custom/{short_group}/{version}/{kind}.json"),
                    Path(f"schemas/custom/{short_group}/{kind}_{version}.json"),
                    Path(f"schemas/custom/{group}_{version}_{kind_slug}.json"),
                    Path(f"schemas/custom/{kind_slug}-{group}-{version}.json"),
                    Path(f"schemas/custom/{kind_slug}_{group}_{version}.json"),
                    Path(f"schemas/custom/{group}/{version}/{kind_slug}.json"),
                    Path(f"schemas/custom/{group}/{kind_slug}_{version}.json"),
                    Path(f"schemas/custom/{short_group}_{version}_{kind_slug}.json"),
                    Path(f"schemas/custom/{kind_slug}{short_kind_suffix}.json"),
                    Path(f"schemas/custom/{kind_slug}_{short_group}_{version}.json"),
                    Path(f"schemas/custom/{short_group}/{version}/{kind_slug}.json"),
                    Path(f"schemas/custom/{short_group}/{kind_slug}_{version}.json"),
                ]
            )
        out_paths.extend(lowercase_paths)
        for out_path in out_paths:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(output))
            print(f"wrote {out_path}")
        sys.exit(0)

print("schema not found", file=sys.stderr)
sys.exit(1)
