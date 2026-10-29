#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
render_root="$(mktemp -d)"
trap 'rm -rf "$render_root"' EXIT

# Render only the two workload manifests; never read Secret or SealedSecret bodies.
cp "$repo_root/argocd/applications/bayn/deployment.yaml" "$render_root/deployment.yaml"
cp "$repo_root/argocd/applications/bayn/execution-controller.yaml" "$render_root/execution-controller.yaml"
printf 'resources:\n  - deployment.yaml\n  - execution-controller.yaml\n' > "$render_root/kustomization.yaml"
kubectl kustomize "$render_root" > "$render_root/rendered.yaml"

# Check the Kubernetes renderer's numeric mode, not a YAML 1.2 source parser's
# interpretation of a leading-zero scalar. Decimal 288 is octal 0440, not 0670.
yq eval-all -o=json -I=0 '[.]' "$render_root/rendered.yaml" | jq -e '
  length == 2 and
  ([.[].metadata.name] | sort) == ["bayn", "bayn-execution-controller"] and
  all(.[];
    .spec.template.spec as $pod |
    ([$pod.volumes[] | select(.name == "valkey-client-tls") | .secret] ==
      [{secretName: "bayn-valkey-client-tls", defaultMode: 288}]) and
    ([$pod.containers[].volumeMounts[]? | select(.name == "valkey-client-tls")] | length > 0) and
    all($pod.containers[].volumeMounts[]? | select(.name == "valkey-client-tls");
      .readOnly == true and .mountPath == "/var/run/secrets/bayn/valkey")
  )
'
