import json
import sys
from pathlib import Path

import yaml

if len(sys.argv) != 5:
    sys.exit(
        "usage: python scripts/download_crd_schema.py <crd-yaml> <group> <version> <kind>"
    )

crd_path = Path(sys.argv[1])
group, version, kind = sys.argv[2:]
with crd_path.open(encoding="utf-8") as f:
    crd = yaml.safe_load(f)

spec = crd.get("spec", {})
if crd.get("kind") != "CustomResourceDefinition" or (
    spec.get("group"),
    spec.get("names", {}).get("kind"),
) != (group, kind):
    sys.exit(f"{crd_path}: expected CRD for {group}/{kind}")

for entry in spec.get("versions", []):
    schema = entry.get("schema", {}).get("openAPIV3Schema")
    if entry.get("name") == version and schema:
        # Preserve the schema shape used by kubeconform; only the file location changes.
        output = {
            "type": "object",
            "properties": schema.get("properties", {}),
            "dependencies": schema.get("dependencies", {}),
            "definitions": schema.get("definitions", {}),
            "additionalProperties": schema.get("additionalProperties", True),
        }
        if schema.get("required"):
            output["required"] = schema["required"]

        # kubeconform uses the full .Group and lowercases .ResourceKind.
        out_path = Path("schemas/custom") / group / version / f"{kind.lower()}.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(output), encoding="utf-8")
        print(f"wrote {out_path}")
        sys.exit(0)

sys.exit(f"{crd_path}: schema not found for {group}/{version}/{kind}")
