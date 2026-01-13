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
            "required": schema.get("required", []),
            "dependencies": schema.get("dependencies", {}),
            "definitions": schema.get("definitions", {}),
            "additionalProperties": schema.get("additionalProperties", True),
        }
        # kubeconform lowercases kind when resolving schema paths.
        out_path = Path(f"schemas/custom/{group}_{version}_{kind_slug}.json")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(output))
        print(f"wrote {out_path}")
        sys.exit(0)

print("schema not found", file=sys.stderr)
sys.exit(1)
